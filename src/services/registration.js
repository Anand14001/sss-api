import crypto from 'node:crypto';
import { CATEGORIES, EVENT_CONFIG } from '../config/event.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { validateRegistrationPayload, isDeadlinePassed } from './validation.js';
import { createRazorpayOrder, verifyCheckoutSignature } from './razorpay.js';
import { sendPaymentConfirmationEmail } from './email.js';
import { quotePrice } from './pricing.js';
import {
  validateAndQuoteCoupon,
  claimCouponSlot,
  attachCouponToRegistration,
  consumeCouponForRegistration,
  releaseCouponForRegistration,
  compensateCouponReservation,
  couponError
} from './coupons.js';

/**
 * Generates a clean human-readable reference, e.g. SSS-2026-X8K2M9
 */
export function generateReference(prefix = 'SSS-2026') {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(crypto.randomInt(chars.length));
  }
  return `${prefix}-${rand}`;
}

/**
 * Creates a registration record and matching Razorpay order using Prisma.
 * Supports optional coupon codes and complimentary 100% discount bypassing Razorpay.
 */
export async function createRegistration(data) {
  // 1. Validation
  const { isValid, errors, cleaned } = validateRegistrationPayload(data);
  if (!isValid) {
    const error = new Error('Validation failed');
    error.status = 400;
    error.details = errors;
    throw error;
  }

  // 2. Deadline check (always takes precedence over coupons)
  if (isDeadlinePassed(EVENT_CONFIG.deadline)) {
    const error = new Error('Registration deadline has passed. Registrations are closed.');
    error.status = 400;
    error.code = 'DEADLINE_PASSED';
    throw error;
  }

  const category = CATEGORIES[cleaned.category];

  // 3. Prevent duplicate active registrations with the same email and category
  const existing = await prisma.registration.findFirst({
    where: {
      email: cleaned.email,
      categorySlug: cleaned.category,
      dob: new Date(`${cleaned.dob}T00:00:00Z`),
      status: 'PAID'
    }
  });

  if (existing) {
    const error = new Error(
      `A confirmed registration for ${cleaned.fullName} in category ${category.name} already exists under reference ${existing.reference}.`
    );
    error.status = 409;
    error.code = 'DUPLICATE_REGISTRATION';
    throw error;
  }

  // 4. Coupon validation and pricing quote (D1, D2, D3)
  let quote;
  let coupon = null;
  let isFree = false;

  if (data.couponCode) {
    const valResult = await validateAndQuoteCoupon(prisma, {
      code: data.couponCode,
      categorySlug: cleaned.category,
      email: cleaned.email
    });

    if (!valResult.valid) {
      throw couponError(valResult.code, valResult.error, 400);
    }

    coupon = valResult.coupon;
    quote = valResult.quote;
    isFree = valResult.isFree;
  } else {
    quote = quotePrice({ categorySlug: cleaned.category });
  }

  const registrationId = crypto.randomUUID();
  const reference = generateReference();
  const paymentId = crypto.randomUUID();

  // 5. 100% Free / Complimentary Registration Path (D3)
  if (isFree) {
    const { reg } = await prisma.$transaction(async (tx) => {
      if (coupon) {
        await claimCouponSlot(tx, coupon);
      }

      const reg = await tx.registration.create({
        data: {
          id: registrationId,
          reference,
          categorySlug: cleaned.category,
          fullName: cleaned.fullName,
          email: cleaned.email,
          phone: cleaned.phone,
          dob: new Date(`${cleaned.dob}T00:00:00Z`),
          ageOnContest: cleaned.ageOnContest,
          occupation: cleaned.occupation,
          city: cleaned.city,
          guardianName: cleaned.guardianName || null,
          guardianPhone: cleaned.guardianPhone || null,
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise,
          amountPaise: 0,
          currency: quote.currency,
          status: 'PAID',
          couponId: coupon?.id || null,
          couponCode: coupon?.code || null
        }
      });

      const payment = await tx.payment.create({
        data: {
          id: paymentId,
          registrationId,
          registrationReference: reference,
          razorpayOrderId: `FREE-${reference}`,
          razorpayPaymentId: null,
          razorpaySignature: null,
          amountPaise: 0,
          currency: quote.currency,
          status: 'CAPTURED',
          settlementMode: 'COMPLIMENTARY'
        }
      });

      if (coupon) {
        await tx.couponRedemption.create({
          data: {
            couponId: coupon.id,
            couponCode: coupon.code,
            registrationId,
            registrationReference: reference,
            email: cleaned.email.trim().toLowerCase(),
            categorySlug: cleaned.category,
            baseAmountPaise: quote.baseAmountPaise,
            discountPaise: quote.discountPaise,
            payableAmountPaise: 0,
            status: 'CONSUMED',
            reservedAt: new Date(),
            consumedAt: new Date()
          }
        });
      }

      return { reg, payment };
    });

    // Fire confirmation email asynchronously
    sendPaymentConfirmationEmail({
      registration: reg,
      payment: {
        id: paymentId,
        amountPaise: 0,
        settlementMode: 'COMPLIMENTARY'
      }
    }).catch((err) => {
      console.error('[CONFIRMATION EMAIL ERROR]', err.message);
    });

    return {
      success: true,
      registration: {
        id: reg.id,
        reference: reg.reference,
        fullName: reg.fullName,
        email: reg.email,
        phone: reg.phone,
        category: reg.categorySlug,
        categoryName: category.name,
        baseAmountPaise: quote.baseAmountPaise,
        discountPaise: quote.discountPaise,
        amountPaise: 0,
        amountRupees: 0,
        currency: quote.currency,
        status: reg.status,
        coupon: coupon ? { code: coupon.code, discountValue: coupon.discountValue } : null,
        createdAt: reg.createdAt
      },
      order: null,
      freeRegistration: true
    };
  }

  // 6. Paid Path: Create Razorpay order first
  let rzpOrder;
  try {
    rzpOrder = await createRazorpayOrder({
      amountPaise: quote.payableAmountPaise,
      currency: quote.currency,
      receipt: reference,
      notes: {
        registrationReference: reference,
        category: cleaned.category,
        fullName: cleaned.fullName,
        email: cleaned.email,
        couponCode: coupon?.code || ''
      }
    });
  } catch (err) {
    const error = new Error(`Failed to create payment order: ${err.message}`);
    error.status = 502;
    error.code = 'PAYMENT_GATEWAY_ERROR';
    throw error;
  }

  // 7. Atomic database insertion with compensating release (D4)
  try {
    const { reg } = await prisma.$transaction(async (tx) => {
      if (coupon) {
        await claimCouponSlot(tx, coupon);
      }

      const reg = await tx.registration.create({
        data: {
          id: registrationId,
          reference,
          categorySlug: cleaned.category,
          fullName: cleaned.fullName,
          email: cleaned.email,
          phone: cleaned.phone,
          dob: new Date(`${cleaned.dob}T00:00:00Z`),
          ageOnContest: cleaned.ageOnContest,
          occupation: cleaned.occupation,
          city: cleaned.city,
          guardianName: cleaned.guardianName || null,
          guardianPhone: cleaned.guardianPhone || null,
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise,
          amountPaise: quote.payableAmountPaise,
          currency: quote.currency,
          status: 'AWAITING_PAYMENT',
          couponId: coupon?.id || null,
          couponCode: coupon?.code || null
        }
      });

      await tx.payment.create({
        data: {
          id: paymentId,
          registrationId,
          registrationReference: reference,
          razorpayOrderId: rzpOrder.id,
          amountPaise: quote.payableAmountPaise,
          currency: quote.currency,
          status: 'CREATED'
        }
      });

      if (coupon) {
        await tx.couponRedemption.create({
          data: {
            couponId: coupon.id,
            couponCode: coupon.code,
            registrationId,
            registrationReference: reference,
            email: cleaned.email.trim().toLowerCase(),
            categorySlug: cleaned.category,
            baseAmountPaise: quote.baseAmountPaise,
            discountPaise: quote.discountPaise,
            payableAmountPaise: quote.payableAmountPaise,
            status: 'RESERVED',
            reservedAt: new Date()
          }
        });
      }

      return { reg };
    });

    return {
      success: true,
      registration: {
        id: reg.id,
        reference: reg.reference,
        fullName: reg.fullName,
        email: reg.email,
        phone: reg.phone,
        category: reg.categorySlug,
        categoryName: category.name,
        baseAmountPaise: quote.baseAmountPaise,
        discountPaise: quote.discountPaise,
        amountPaise: quote.payableAmountPaise,
        amountRupees: quote.payableAmountPaise / 100,
        currency: quote.currency,
        status: reg.status,
        coupon: coupon ? { code: coupon.code, discountValue: coupon.discountValue } : null,
        createdAt: reg.createdAt
      },
      order: {
        id: rzpOrder.id,
        amount: quote.payableAmountPaise,
        currency: quote.currency,
        keyId: env.RAZORPAY_KEY_ID
      },
      freeRegistration: false
    };
  } catch (err) {
    // If the database transaction failed after claim, compensate the slot
    if (coupon) {
      await compensateCouponReservation(prisma, coupon.id, 'REGISTRATION_TRANSACTION_FAILED');
    }
    throw err;
  }
}

/**
 * Applies a coupon to an existing registration in AWAITING_PAYMENT status.
 * Re-prices the booking and generates a fresh Razorpay order.
 */
export async function applyCouponToRegistration(reference, couponCode) {
  const reg = await prisma.registration.findUnique({
    where: { reference }
  });

  if (!reg) {
    const error = new Error('Registration not found.');
    error.status = 404;
    throw error;
  }

  if (reg.status !== 'AWAITING_PAYMENT') {
    throw couponError('COUPON_NOT_APPLICABLE_STATE', 'Coupons can only be applied to registrations awaiting payment.', 409);
  }

  if (reg.couponId) {
    throw couponError('COUPON_ALREADY_APPLIED', 'A coupon is already applied to this registration.', 409);
  }

  const valResult = await validateAndQuoteCoupon(prisma, {
    code: couponCode,
    categorySlug: reg.categorySlug,
    email: reg.email
  });

  if (!valResult.valid) {
    throw couponError(valResult.code, valResult.error, 400);
  }

  const { coupon, quote, isFree } = valResult;

  // 100% discount branch
  if (isFree) {
    await prisma.$transaction(async (tx) => {
      await attachCouponToRegistration(tx, {
        coupon,
        registration: reg,
        quote,
        initialStatus: 'CONSUMED'
      });

      await tx.registration.update({
        where: { id: reg.id },
        data: { status: 'PAID' }
      });

      await tx.payment.create({
        data: {
          registrationId: reg.id,
          registrationReference: reg.reference,
          razorpayOrderId: `FREE-${reg.reference}`,
          amountPaise: 0,
          currency: reg.currency,
          status: 'CAPTURED',
          settlementMode: 'COMPLIMENTARY'
        }
      });
    });

    sendPaymentConfirmationEmail({
      registration: { ...reg, couponCode: coupon.code, discountPaise: quote.discountPaise, amountPaise: 0 },
      payment: { amountPaise: 0, settlementMode: 'COMPLIMENTARY' }
    }).catch(e => console.error('[EMAIL ERROR]', e.message));

    return {
      success: true,
      registration: {
        reference: reg.reference,
        status: 'PAID',
        baseAmountPaise: quote.baseAmountPaise,
        discountPaise: quote.discountPaise,
        amountPaise: 0,
        amountRupees: 0,
        coupon: { code: coupon.code, discountValue: coupon.discountValue }
      },
      order: null,
      freeRegistration: true
    };
  }

  // Create fresh Razorpay order for new discounted amount
  let rzpOrder;
  try {
    rzpOrder = await createRazorpayOrder({
      amountPaise: quote.payableAmountPaise,
      currency: reg.currency,
      receipt: reg.reference,
      notes: {
        registrationReference: reg.reference,
        category: reg.categorySlug,
        couponCode: coupon.code
      }
    });
  } catch (err) {
    const error = new Error(`Failed creating payment order: ${err.message}`);
    error.status = 502;
    error.code = 'PAYMENT_GATEWAY_ERROR';
    throw error;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await attachCouponToRegistration(tx, {
        coupon,
        registration: reg,
        quote,
        initialStatus: 'RESERVED'
      });

      await tx.payment.create({
        data: {
          registrationId: reg.id,
          registrationReference: reg.reference,
          razorpayOrderId: rzpOrder.id,
          amountPaise: quote.payableAmountPaise,
          currency: reg.currency,
          status: 'CREATED'
        }
      });
    });

    return {
      success: true,
      registration: {
        reference: reg.reference,
        status: 'AWAITING_PAYMENT',
        baseAmountPaise: quote.baseAmountPaise,
        discountPaise: quote.discountPaise,
        amountPaise: quote.payableAmountPaise,
        amountRupees: quote.payableAmountPaise / 100,
        coupon: { code: coupon.code, discountValue: coupon.discountValue }
      },
      order: {
        id: rzpOrder.id,
        amount: quote.payableAmountPaise,
        currency: reg.currency,
        keyId: env.RAZORPAY_KEY_ID
      },
      freeRegistration: false
    };
  } catch (err) {
    await compensateCouponReservation(prisma, coupon.id, 'APPLY_COUPON_FAILED');
    throw err;
  }
}

/**
 * Removes an applied coupon from a pending registration, releasing the reservation
 * and restoring the full fee with a fresh Razorpay order.
 */
export async function removeCouponFromRegistration(reference) {
  const reg = await prisma.registration.findUnique({
    where: { reference }
  });

  if (!reg) {
    const error = new Error('Registration not found.');
    error.status = 404;
    throw error;
  }

  if (reg.status !== 'AWAITING_PAYMENT') {
    throw couponError('COUPON_NOT_APPLICABLE_STATE', 'Cannot remove coupon from a paid or cancelled registration.', 409);
  }

  if (!reg.couponId) {
    return {
      success: true,
      message: 'No coupon applied.',
      registration: {
        reference: reg.reference,
        amountPaise: reg.amountPaise
      }
    };
  }

  const baseFee = reg.baseAmountPaise ?? reg.amountPaise;

  // Create fresh Razorpay order for the base fee
  const rzpOrder = await createRazorpayOrder({
    amountPaise: baseFee,
    currency: reg.currency,
    receipt: reg.reference,
    notes: {
      registrationReference: reg.reference,
      category: reg.categorySlug,
      couponRemoved: 'true'
    }
  });

  await prisma.$transaction(async (tx) => {
    await releaseCouponForRegistration(tx, reg.id, 'USER_REMOVED');

    await tx.payment.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        razorpayOrderId: rzpOrder.id,
        amountPaise: baseFee,
        currency: reg.currency,
        status: 'CREATED'
      }
    });
  });

  return {
    success: true,
    message: 'Coupon removed.',
    registration: {
      reference: reg.reference,
      baseAmountPaise: baseFee,
      discountPaise: 0,
      amountPaise: baseFee,
      amountRupees: baseFee / 100,
      coupon: null
    },
    order: {
      id: rzpOrder.id,
      amount: baseFee,
      currency: reg.currency,
      keyId: env.RAZORPAY_KEY_ID
    }
  };
}

/**
 * Verifies payment checkout signature and confirms registration.
 * Consumes reserved coupon atomically and idempotently.
 */
export async function verifyPayment({
  registrationReference,
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature
}) {
  if (!registrationReference || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    const error = new Error('Missing payment verification parameters.');
    error.status = 400;
    throw error;
  }

  // 1. Signature verification
  const isValid = verifyCheckoutSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature
  });

  if (!isValid) {
    await prisma.payment.updateMany({
      where: { razorpayOrderId: razorpay_order_id },
      data: {
        status: 'FAILED',
        failureReason: 'Signature verification mismatch'
      }
    });
    const error = new Error('Payment verification failed: invalid signature.');
    error.status = 400;
    error.code = 'INVALID_SIGNATURE';
    throw error;
  }

  // 2. Fetch registration and payment
  const registration = await prisma.registration.findUnique({
    where: { reference: registrationReference }
  });
  if (!registration) {
    const error = new Error('Registration not found.');
    error.status = 404;
    throw error;
  }

  const payment = await prisma.payment.findUnique({
    where: { razorpayOrderId: razorpay_order_id }
  });
  if (!payment) {
    const error = new Error('Payment record not found for this order.');
    error.status = 404;
    throw error;
  }

  // Idempotency: if already paid, return existing success
  if (registration.status === 'PAID') {
    return {
      success: true,
      alreadyVerified: true,
      registration: {
        reference: registration.reference,
        fullName: registration.fullName,
        category: registration.categorySlug,
        status: registration.status,
        baseAmountPaise: registration.baseAmountPaise ?? registration.amountPaise,
        discountPaise: registration.discountPaise || 0,
        amountRupees: registration.amountPaise / 100,
        currency: registration.currency,
        couponCode: registration.couponCode || null,
        paymentId: payment?.razorpayPaymentId || null,
        createdAt: registration.createdAt
      }
    };
  }

  // 3. Atomically update status and consume coupon
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        status: 'CAPTURED'
      }
    });

    await tx.registration.update({
      where: { id: registration.id },
      data: {
        status: 'PAID'
      }
    });

    // Idempotent coupon consumption
    await consumeCouponForRegistration(tx, registration);
  });

  // 4. Send confirmation email (async/non-blocking)
  sendPaymentConfirmationEmail({
    registration,
    payment: { ...payment, razorpayPaymentId: razorpay_payment_id }
  }).catch((err) => {
    console.error('Confirmation email error:', err.message);
  });

  return {
    success: true,
    message: 'Payment verified and registration confirmed.',
    registration: {
      reference: registration.reference,
      fullName: registration.fullName,
      email: registration.email,
      category: registration.categorySlug,
      status: 'PAID',
      baseAmountPaise: registration.baseAmountPaise ?? registration.amountPaise,
      discountPaise: registration.discountPaise || 0,
      amountRupees: registration.amountPaise / 100,
      currency: registration.currency,
      couponCode: registration.couponCode || null,
      paymentId: razorpay_payment_id,
      createdAt: registration.createdAt
    }
  };
}

/**
 * Handles incoming Razorpay webhook events using Prisma.
 * Consumes reserved coupon atomically and idempotently.
 */
export async function processWebhookEvent(payload) {
  const eventType = payload.event;

  if (eventType === 'order.paid' || eventType === 'payment.captured') {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const orderId = paymentEntity.order_id || payload.payload?.order?.entity?.id;
    const paymentId = paymentEntity.id;

    if (!orderId) {
      return { received: true, ignored: true, reason: 'No order_id in webhook payload' };
    }

    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: orderId },
      include: { registration: true }
    });

    if (!payment) {
      return { received: true, ignored: true, reason: 'Order not found in database' };
    }

    const registration = payment.registration;
    if (!registration) {
      return { received: true, ignored: true, reason: 'Registration not found' };
    }

    // Verify amount consistency against final payable amountPaise
    if (paymentEntity.amount && paymentEntity.amount !== registration.amountPaise) {
      console.warn(
        `Amount mismatch for order ${orderId}: expected ${registration.amountPaise}, got ${paymentEntity.amount}`
      );
      return { received: true, warning: 'Amount mismatch' };
    }

    // If already marked PAID, prevent duplicate processing or duplicate email
    if (registration.status === 'PAID') {
      return { received: true, alreadyProcessed: true };
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          razorpayPaymentId: paymentId,
          status: 'CAPTURED'
        }
      });

      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: 'PAID'
        }
      });

      // Idempotently consume coupon
      await consumeCouponForRegistration(tx, registration);
    });

    sendPaymentConfirmationEmail({
      registration,
      payment: { ...payment, razorpayPaymentId: paymentId }
    }).catch((err) => {
      console.error('Webhook confirmation email error:', err.message);
    });

    return { received: true, processed: true, reference: registration.reference };
  }

  if (eventType === 'payment.failed') {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const orderId = paymentEntity.order_id;
    const reason = paymentEntity.error_description || 'Payment failed';

    if (orderId) {
      await prisma.payment.updateMany({
        where: { razorpayOrderId: orderId },
        data: {
          status: 'FAILED',
          failureReason: reason.slice(0, 255)
        }
      });
    }

    // Leave coupon reservation RESERVED per D4 table so user can retry with another card
    return { received: true, recordedFailure: true };
  }

  return { received: true, ignored: true };
}

/**
 * Returns safe payment and registration status for client polling.
 */
export async function getRegistrationStatus(reference) {
  const reg = await prisma.registration.findUnique({
    where: { reference },
    include: {
      payments: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  if (!reg) {
    const error = new Error('Registration not found.');
    error.status = 404;
    throw error;
  }

  const latestPayment = reg.payments?.[0] || null;
  const baseAmountPaise = reg.baseAmountPaise ?? reg.amountPaise;
  const discountPaise = reg.discountPaise || 0;

  return {
    reference: reg.reference,
    fullName: reg.fullName,
    category: reg.categorySlug,
    status: reg.status,
    baseAmountPaise,
    discountPaise,
    amountPaise: reg.amountPaise,
    amountRupees: reg.amountPaise / 100,
    discountRupees: discountPaise / 100,
    couponCode: reg.couponCode || null,
    currency: reg.currency,
    paymentStatus: latestPayment ? latestPayment.status : null,
    orderId: latestPayment ? latestPayment.razorpayOrderId : null,
    paymentId: latestPayment?.razorpayPaymentId || null,
    createdAt: reg.createdAt
  };
}

/**
 * Creates a fresh Razorpay order for retry if a payment was abandoned or failed.
 * Re-uses the stored quote if reservation is still live (D5); re-validates if lapsed.
 */
export async function retryPayment(reference) {
  const reg = await prisma.registration.findUnique({
    where: { reference }
  });

  if (!reg) {
    const error = new Error('Registration not found.');
    error.status = 404;
    throw error;
  }

  if (reg.status === 'PAID') {
    return {
      alreadyPaid: true,
      message: 'This registration has already been paid and confirmed.'
    };
  }

  let finalAmountPaise = reg.amountPaise;
  let repriced = false;
  let oldAmountPaise = reg.amountPaise;

  // Check coupon reservation status if coupon was attached
  if (reg.couponId) {
    const activeRes = await prisma.couponRedemption.findFirst({
      where: {
        registrationId: reg.id,
        status: 'RESERVED'
      }
    });

    if (!activeRes) {
      // Reservation lapsed or was released. Try to re-validate:
      const check = await validateAndQuoteCoupon(prisma, {
        code: reg.couponCode,
        categorySlug: reg.categorySlug,
        email: reg.email
      });

      if (check.valid && !check.isFree) {
        // Re-reserve
        await prisma.$transaction(async (tx) => {
          await attachCouponToRegistration(tx, {
            coupon: check.coupon,
            registration: reg,
            quote: check.quote
          });
        });
        finalAmountPaise = check.quote.payableAmountPaise;
      } else {
        // Drop coupon, re-price at base fee
        const baseFee = reg.baseAmountPaise ?? reg.amountPaise;
        await prisma.registration.update({
          where: { id: reg.id },
          data: {
            couponId: null,
            couponCode: null,
            discountPaise: 0,
            amountPaise: baseFee
          }
        });
        finalAmountPaise = baseFee;
        repriced = true;
      }
    }
  }

  const rzpOrder = await createRazorpayOrder({
    amountPaise: finalAmountPaise,
    currency: reg.currency,
    receipt: reg.reference,
    notes: {
      registrationReference: reg.reference,
      category: reg.categorySlug,
      fullName: reg.fullName,
      email: reg.email,
      retry: 'true'
    }
  });

  const paymentId = crypto.randomUUID();

  await prisma.payment.create({
    data: {
      id: paymentId,
      registrationId: reg.id,
      registrationReference: reg.reference,
      razorpayOrderId: rzpOrder.id,
      amountPaise: finalAmountPaise,
      currency: reg.currency,
      status: 'CREATED'
    }
  });

  return {
    reference: reg.reference,
    repriced,
    oldAmountPaise,
    newAmountPaise: finalAmountPaise,
    order: {
      id: rzpOrder.id,
      amount: finalAmountPaise,
      currency: reg.currency,
      keyId: env.RAZORPAY_KEY_ID
    }
  };
}
