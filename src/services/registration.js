import crypto from 'node:crypto';
import { CATEGORIES, EVENT_CONFIG } from '../config/event.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { validateRegistrationPayload, isDeadlinePassed } from './validation.js';
import { createRazorpayOrder, verifyCheckoutSignature } from './razorpay.js';
import { sendPaymentConfirmationEmail, sendRegistrationAcknowledgementEmail } from './email.js';
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

  // 3. Idempotency & Accidental Duplicate Submission Prevention
  // Allows multiple participant registrations using the same email address.
  // Protects against accidental retries of the same application submission using an idempotency key
  // or a deterministic fingerprint of the participant's application payload.
  const explicitIdempotencyKey =
    typeof data.idempotencyKey === 'string' && data.idempotencyKey.trim()
      ? data.idempotencyKey.trim()
      : null;

  const submissionFingerprint = crypto
    .createHash('sha256')
    .update(
      [
        cleaned.fullName.toLowerCase().trim(),
        cleaned.email.toLowerCase().trim(),
        cleaned.phone.trim(),
        cleaned.dob,
        cleaned.category,
        cleaned.city.toLowerCase().trim(),
        cleaned.occupation.toLowerCase().trim(),
        (cleaned.guardianName || '').toLowerCase().trim(),
        (cleaned.guardianRelationship || '').toLowerCase().trim(),
        (cleaned.guardianPhone || '').trim(),
        (cleaned.guardianEmail || '').toLowerCase().trim(),
        (data.couponCode || '').toUpperCase().trim()
      ].join('|')
    )
    .digest('hex');

  const idempotencyKey = explicitIdempotencyKey || `fp_${submissionFingerprint}`;

  // Check if this exact application was already submitted / retried
  const existingByIdempotency = await prisma.registration.findFirst({
    where: {
      idempotencyKey,
      status: { notIn: ['CANCELLED', 'REJECTED'] }
    },
    include: {
      payments: { orderBy: { createdAt: 'desc' }, take: 1 }
    }
  });

  if (existingByIdempotency) {
    const existingCategory = CATEGORIES[existingByIdempotency.categorySlug] || category;
    const existingAppData = {
      id: existingByIdempotency.id,
      reference: existingByIdempotency.reference,
      fullName: existingByIdempotency.fullName,
      email: existingByIdempotency.email,
      phone: existingByIdempotency.phone,
      category: existingByIdempotency.categorySlug,
      categoryName: existingCategory.name,
      baseAmountPaise: existingByIdempotency.baseAmountPaise ?? existingByIdempotency.amountPaise,
      discountPaise: existingByIdempotency.discountPaise || 0,
      amountPaise: existingByIdempotency.amountPaise,
      amountRupees: existingByIdempotency.amountPaise / 100,
      currency: existingByIdempotency.currency || 'INR',
      status: existingByIdempotency.status,
      coupon: existingByIdempotency.couponCode ? { code: existingByIdempotency.couponCode } : null,
      createdAt: existingByIdempotency.createdAt
    };

    if (data.applicationMode === true || data.isApplication === true) {
      return {
        success: true,
        application: existingAppData,
        registration: existingAppData,
        order: null,
        freeRegistration: existingByIdempotency.amountPaise === 0,
        paymentRequired: false,
        duplicatePrevented: true
      };
    }

    const latestPayment = existingByIdempotency.payments?.[0];
    return {
      success: true,
      registration: existingAppData,
      order: latestPayment
        ? {
            id: latestPayment.razorpayOrderId,
            amount: latestPayment.amountPaise,
            currency: latestPayment.currency
          }
        : null,
      freeRegistration: existingByIdempotency.amountPaise === 0,
      alreadyPaid: existingByIdempotency.status === 'PAID' || existingByIdempotency.status === 'CONFIRMED',
      duplicatePrevented: true
    };
  }

  // 4. Coupon validation and pricing quote (using DB as authoritative source of truth)
  let dbCategory = null;
  try {
    dbCategory = await prisma.category.findUnique({
      where: { slug: cleaned.category }
    });
  } catch (err) {
    console.error('[REGISTRATION] DB category fee lookup error:', err.message);
  }

  const authoritativeFeePaise = dbCategory ? dbCategory.feePaise : CATEGORIES[cleaned.category]?.feePaise;

  let quote;
  let coupon = null;
  let isFree = false;

  if (data.couponCode && !data.applicationMode && !data.isApplication) {
    const valResult = await validateAndQuoteCoupon(prisma, {
      code: data.couponCode,
      categorySlug: cleaned.category,
      email: cleaned.email,
      baseAmountPaise: authoritativeFeePaise
    });

    if (!valResult.valid) {
      throw couponError(valResult.code, valResult.error, 400);
    }

    coupon = valResult.coupon;
    quote = valResult.quote;
    isFree = valResult.isFree;
  } else {
    quote = quotePrice({
      categorySlug: cleaned.category,
      baseAmountPaise: authoritativeFeePaise
    });
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
          guardianRelationship: cleaned.guardianRelationship || null,
          guardianPhone: cleaned.guardianPhone || null,
          guardianEmail: cleaned.guardianEmail || null,
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise,
          amountPaise: 0,
          currency: quote.currency,
          status: 'PAID',
          idempotencyKey,
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

  // 6. Application-First Flow: Save application without payment or Razorpay order
  if (data.applicationMode === true || data.isApplication === true) {
    let reg;
    try {
      reg = await prisma.registration.create({
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
          guardianRelationship: cleaned.guardianRelationship || null,
          guardianPhone: cleaned.guardianPhone || null,
          guardianEmail: cleaned.guardianEmail || null,
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise || 0,
          amountPaise: quote.payableAmountPaise,
          currency: quote.currency || 'INR',
          status: 'PENDING_REVIEW',
          idempotencyKey,
          couponId: coupon?.id || null,
          couponCode: coupon?.code || null
        }
      });
    } catch (err) {
      if (err.code === 'P2002') {
        const concurrent = await prisma.registration.findFirst({
          where: { idempotencyKey }
        });
        if (concurrent) {
          const appData = {
            id: concurrent.id,
            reference: concurrent.reference,
            fullName: concurrent.fullName,
            email: concurrent.email,
            phone: concurrent.phone,
            category: concurrent.categorySlug,
            categoryName: category.name,
            baseAmountPaise: concurrent.baseAmountPaise ?? concurrent.amountPaise,
            discountPaise: concurrent.discountPaise || 0,
            amountPaise: concurrent.amountPaise,
            amountRupees: concurrent.amountPaise / 100,
            currency: concurrent.currency || 'INR',
            status: concurrent.status,
            coupon: concurrent.couponCode ? { code: concurrent.couponCode } : null,
            createdAt: concurrent.createdAt
          };
          return {
            success: true,
            application: appData,
            registration: appData,
            order: null,
            freeRegistration: false,
            paymentRequired: false,
            duplicatePrevented: true
          };
        }
      }
      throw err;
    }

    // Send registration acknowledgement email with rules PDF asynchronously
    sendRegistrationAcknowledgementEmail({ registration: reg }).catch((err) => {
      console.error('[ACKNOWLEDGEMENT EMAIL ERROR]', err.message);
    });

    const appData = {
      id: reg.id,
      reference: reg.reference,
      fullName: reg.fullName,
      email: reg.email,
      phone: reg.phone,
      category: reg.categorySlug,
      categoryName: category.name,
      baseAmountPaise: quote.baseAmountPaise,
      discountPaise: quote.discountPaise || 0,
      amountPaise: quote.payableAmountPaise,
      amountRupees: quote.payableAmountPaise / 100,
      currency: quote.currency || 'INR',
      status: reg.status,
      coupon: coupon ? { code: coupon.code, discountValue: coupon.discountValue } : null,
      createdAt: reg.createdAt
    };

    return {
      success: true,
      application: appData,
      registration: appData,
      order: null,
      freeRegistration: false,
      paymentRequired: false
    };
  }

  // 7. Legacy Immediate Checkout Path (used only when immediateCheckout is explicitly requested)
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
          guardianRelationship: cleaned.guardianRelationship || null,
          guardianPhone: cleaned.guardianPhone || null,
          guardianEmail: cleaned.guardianEmail || null,
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise,
          amountPaise: quote.payableAmountPaise,
          currency: quote.currency,
          status: 'AWAITING_PAYMENT',
          idempotencyKey,
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

  const allowedStatuses = ['AWAITING_PAYMENT', 'PAYMENT_PENDING', 'SHORTLISTED', 'PAYMENT_FAILED'];
  if (!allowedStatuses.includes(reg.status)) {
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

      await tx.paymentInvitation.updateMany({
        where: {
          registrationId: reg.id,
          status: { in: ['PENDING', 'SENT'] }
        },
        data: { amountPaise: quote.payableAmountPaise }
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

  if (reg.status === 'PAID' || reg.status === 'CONFIRMED' || reg.status === 'CANCELLED' || reg.status === 'REJECTED') {
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
  razorpay_signature,
  invitationToken
}) {
  let ref = registrationReference;
  if (!ref && invitationToken) {
    const inv = await prisma.paymentInvitation.findUnique({ where: { token: invitationToken } });
    if (inv) ref = inv.registrationReference;
  }
  if (!ref && razorpay_order_id) {
    const pmt = await prisma.payment.findUnique({ where: { razorpayOrderId: razorpay_order_id } });
    if (pmt) ref = pmt.registrationReference;
  }

  if (!ref || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
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
    where: { reference: ref }
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

  const finalStatus = (registration.reviewDecision === 'SHORTLISTED' || registration.status === 'SHORTLISTED' || registration.status === 'PAYMENT_PENDING' || invitationToken)
    ? 'CONFIRMED'
    : 'PAID';

  // Idempotency: if already paid or confirmed, return existing success
  if (registration.status === 'PAID' || registration.status === 'CONFIRMED') {
    return {
      success: true,
      alreadyVerified: true,
      registration: {
        reference: registration.reference,
        fullName: registration.fullName,
        category: registration.categorySlug,
        status: finalStatus,
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
        status: finalStatus
      }
    });

    // Mark any active payment invitations as PAID
    await tx.paymentInvitation.updateMany({
      where: {
        registrationId: registration.id,
        status: { in: ['PENDING', 'SENT'] }
      },
      data: {
        status: 'PAID',
        paidAt: new Date()
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
      status: finalStatus,
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

    // If already marked PAID or CONFIRMED, prevent duplicate processing or duplicate email
    if (registration.status === 'PAID' || registration.status === 'CONFIRMED') {
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

      const finalStatus = (registration.reviewDecision === 'SHORTLISTED' || registration.status === 'SHORTLISTED' || registration.status === 'PAYMENT_PENDING')
        ? 'CONFIRMED'
        : 'PAID';

      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: finalStatus
        }
      });

      // Mark payment invitations as PAID
      await tx.paymentInvitation.updateMany({
        where: {
          registrationId: registration.id,
          status: { in: ['PENDING', 'SENT'] }
        },
        data: {
          status: 'PAID',
          paidAt: new Date()
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

      const pmt = await prisma.payment.findUnique({
        where: { razorpayOrderId: orderId }
      });
      if (pmt) {
        await prisma.registration.updateMany({
          where: {
            id: pmt.registrationId,
            status: { notIn: ['CONFIRMED', 'PAID', 'CANCELLED'] }
          },
          data: { status: 'PAYMENT_FAILED' }
        });
      }
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
      },
      paymentInvitations: {
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
  const latestInvitation = reg.paymentInvitations?.[0] || null;
  const baseAmountPaise = reg.baseAmountPaise ?? reg.amountPaise;
  const discountPaise = reg.discountPaise || 0;
  const isConfirmed = reg.status === 'CONFIRMED' || reg.status === 'PAID';

  return {
    reference: reg.reference,
    fullName: reg.fullName,
    category: reg.categorySlug,
    status: reg.status,
    isConfirmed,
    rawStatus: reg.status,
    reviewDecision: reg.reviewDecision || null,
    reviewNotes: reg.reviewNotes || null,
    invitationStatus: latestInvitation ? (latestInvitation.deliveryStatus || latestInvitation.status) : null,
    invitationToken: latestInvitation?.token || null,
    baseAmountPaise,
    discountPaise,
    amountPaise: reg.amountPaise,
    amountRupees: reg.amountPaise / 100,
    discountRupees: discountPaise / 100,
    couponCode: reg.couponCode || null,
    currency: reg.currency,
    paymentStatus: isConfirmed ? 'CAPTURED' : (latestPayment ? latestPayment.status : null),
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

/**
 * Resolves invitation details for the participant payment page (/pay/:token).
 * Rechecks expiry, current registration status, and ensures rejected or already
 * confirmed participants cannot pay.
 */
export async function getInvitationByToken(token) {
  if (!token || typeof token !== 'string') {
    const error = new Error('Invalid invitation token.');
    error.status = 400;
    error.code = 'INVALID_TOKEN';
    throw error;
  }

  const invitation = await prisma.paymentInvitation.findUnique({
    where: { token: token.trim() },
    include: {
      registration: {
        include: {
          payments: {
            orderBy: { createdAt: 'desc' },
            take: 1
          },
          coupon: true
        }
      }
    }
  });

  if (!invitation) {
    const error = new Error('Payment invitation not found or invalid link.');
    error.status = 404;
    error.code = 'INVITATION_NOT_FOUND';
    throw error;
  }

  const { registration } = invitation;

  let dbCategory = null;
  try {
    dbCategory = await prisma.category.findUnique({
      where: { slug: registration.categorySlug }
    });
  } catch (err) {
    console.error('[INVITATION] DB category lookup error:', err.message);
  }

  const authoritativeFeePaise = dbCategory ? dbCategory.feePaise : (CATEGORIES[registration.categorySlug]?.feePaise || invitation.amountPaise);
  const baseAmountPaise = registration.baseAmountPaise ?? authoritativeFeePaise;
  const discountPaise = registration.discountPaise || 0;
  const payableAmountPaise = registration.amountPaise ?? invitation.amountPaise;

  const category = CATEGORIES[registration.categorySlug] || {
    name: dbCategory?.name || registration.categorySlug,
    formLabel: dbCategory?.name || registration.categorySlug,
    feePaise: authoritativeFeePaise
  };

  const isConfirmed = registration.status === 'CONFIRMED' || registration.status === 'PAID';
  const isRejected = registration.status === 'REJECTED' || invitation.status === 'CANCELLED';
  const isCancelled = registration.status === 'CANCELLED';
  const isExpired = new Date(invitation.expiresAt) < new Date() || invitation.status === 'EXPIRED';

  // Determine effective invitation state
  let effectiveStatus = invitation.status;
  if (isConfirmed) {
    effectiveStatus = 'PAID';
  } else if (isRejected) {
    effectiveStatus = 'REJECTED';
  } else if (isCancelled) {
    effectiveStatus = 'CANCELLED';
  } else if (isExpired) {
    effectiveStatus = 'EXPIRED';
  } else if (registration.status === 'PAYMENT_FAILED') {
    effectiveStatus = 'FAILED';
  }

  const latestPayment = registration.payments?.[0] || null;

  const couponMeta = registration.couponId ? {
    code: registration.couponCode || registration.coupon?.displayCode || registration.coupon?.code,
    displayCode: registration.coupon?.displayCode || registration.couponCode || registration.coupon?.code,
    discountValue: registration.coupon?.discountValue ?? (discountPaise > 0 && baseAmountPaise > 0 ? Math.round((discountPaise / baseAmountPaise) * 100) : 0),
    discountType: registration.coupon?.discountType || 'PERCENT',
    isFree: payableAmountPaise === 0
  } : null;

  return {
    success: true,
    invitation: {
      id: invitation.id,
      token: invitation.token,
      reference: registration.reference,
      fullName: registration.fullName,
      email: registration.email,
      category: registration.categorySlug,
      categoryName: category.name,
      categoryLabel: category.formLabel,
      status: effectiveStatus,
      amountPaise: payableAmountPaise,
      amountRupees: payableAmountPaise / 100,
      baseAmountPaise,
      baseAmountRupees: baseAmountPaise / 100,
      discountPaise,
      discountRupees: discountPaise / 100,
      coupon: couponMeta,
      couponCode: couponMeta?.code || null,
      isFree: payableAmountPaise === 0 && Boolean(registration.couponId),
      currency: invitation.currency,
      expiresAt: invitation.expiresAt,
      isPayable: !isConfirmed && !isRejected && !isCancelled && !isExpired,
      payable: !isConfirmed && !isRejected && !isCancelled && !isExpired,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      participant: {
        reference: registration.reference,
        fullName: registration.fullName,
        email: registration.email,
        category: registration.categorySlug,
        categoryName: category.name,
        categoryLabel: category.formLabel,
        status: isConfirmed ? 'CONFIRMED' : registration.status
      },
      payment: latestPayment
        ? {
          id: latestPayment.id,
          status: latestPayment.status,
          paymentId: latestPayment.razorpayPaymentId || null,
          orderId: latestPayment.razorpayOrderId
        }
        : null
    }
  };
}

/**
 * Creates or retrieves a Razorpay checkout order for a valid, payable invitation.
 */
export async function createInvitationCheckoutOrder(token) {
  const details = await getInvitationByToken(token);
  const { invitation } = details;

  if (!invitation.isPayable) {
    const error = new Error(`Cannot initiate payment. Invitation is in status: ${invitation.status}`);
    error.status = 400;
    error.code = `INVITATION_${invitation.status}`;
    throw error;
  }

  const reg = await prisma.registration.findUnique({
    where: { reference: invitation.participant.reference }
  });

  // Handle 100% complimentary coupon without Razorpay order
  if (invitation.amountPaise === 0 && (reg.couponId || invitation.isFree)) {
    return {
      success: true,
      freeRegistration: true,
      reference: reg.reference
    };
  }

  // Create Razorpay Order
  const rzpOrder = await createRazorpayOrder({
    amountPaise: invitation.amountPaise,
    currency: invitation.currency,
    receipt: reg.reference,
    notes: {
      registrationReference: reg.reference,
      invitationToken: invitation.token,
      category: reg.categorySlug,
      fullName: reg.fullName,
      email: reg.email,
      couponCode: reg.couponCode || ''
    }
  });

  // Record payment in DB
  await prisma.payment.create({
    data: {
      registrationId: reg.id,
      registrationReference: reg.reference,
      razorpayOrderId: rzpOrder.id,
      amountPaise: invitation.amountPaise,
      currency: invitation.currency,
      status: 'CREATED'
    }
  });

  // Link order to invitation
  await prisma.paymentInvitation.update({
    where: { token: invitation.token },
    data: {
      razorpayOrderId: rzpOrder.id
    }
  });

  return {
    success: true,
    order: {
      id: rzpOrder.id,
      amount: invitation.amountPaise,
      currency: invitation.currency,
      keyId: env.RAZORPAY_KEY_ID
    },
    reference: reg.reference
  };
}

/**
 * Applies a coupon to a pending payment invitation (/pay/:token).
 */
export async function applyCouponToInvitation(token, couponCode) {
  if (!token || typeof token !== 'string') {
    const error = new Error('Invalid invitation token.');
    error.status = 400;
    throw error;
  }

  const invitation = await prisma.paymentInvitation.findUnique({
    where: { token: token.trim() },
    include: {
      registration: {
        include: { coupon: true }
      }
    }
  });

  if (!invitation) {
    const error = new Error('Payment invitation not found or invalid link.');
    error.status = 404;
    throw error;
  }

  const { registration } = invitation;

  const isConfirmed = registration.status === 'CONFIRMED' || registration.status === 'PAID';
  const isRejected = registration.status === 'REJECTED' || invitation.status === 'CANCELLED';
  const isCancelled = registration.status === 'CANCELLED';
  const isExpired = new Date(invitation.expiresAt) < new Date() || invitation.status === 'EXPIRED';

  if (isConfirmed || isRejected || isCancelled || isExpired) {
    throw couponError('INVITATION_NOT_PAYABLE', 'This payment invitation is no longer active or payable.', 409);
  }

  const allowedStatuses = ['PAYMENT_PENDING', 'SHORTLISTED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED'];
  if (!allowedStatuses.includes(registration.status)) {
    throw couponError('COUPON_NOT_APPLICABLE_STATE', 'Coupons can only be applied to registrations awaiting payment.', 409);
  }

  if (registration.couponId) {
    throw couponError('COUPON_ALREADY_APPLIED', 'A coupon is already applied to this payment invitation. Please remove it first.', 409);
  }

  let dbCategory = null;
  try {
    dbCategory = await prisma.category.findUnique({
      where: { slug: registration.categorySlug }
    });
  } catch (err) {}

  const authoritativeBasePaise = dbCategory ? dbCategory.feePaise : (registration.baseAmountPaise || invitation.amountPaise);

  const valResult = await validateAndQuoteCoupon(prisma, {
    code: couponCode,
    categorySlug: registration.categorySlug,
    email: registration.email,
    baseAmountPaise: authoritativeBasePaise
  });

  if (!valResult.valid) {
    throw couponError(valResult.code, valResult.error, 400);
  }

  const { coupon, quote, isFree } = valResult;

  // 100% complimentary discount branch
  if (isFree || quote.payableAmountPaise === 0) {
    await prisma.$transaction(async (tx) => {
      await attachCouponToRegistration(tx, {
        coupon,
        registration,
        quote,
        initialStatus: 'CONSUMED'
      });

      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: 'CONFIRMED',
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise,
          amountPaise: 0
        }
      });

      await tx.paymentInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          amountPaise: 0
        }
      });

      await tx.payment.create({
        data: {
          registrationId: registration.id,
          registrationReference: registration.reference,
          razorpayOrderId: `FREE-INV-${invitation.token.slice(0, 16)}`,
          amountPaise: 0,
          currency: invitation.currency,
          status: 'CAPTURED',
          settlementMode: 'COMPLIMENTARY'
        }
      });
    });

    sendPaymentConfirmationEmail({
      registration: {
        ...registration,
        couponCode: coupon.code,
        discountPaise: quote.discountPaise,
        baseAmountPaise: quote.baseAmountPaise,
        amountPaise: 0
      },
      payment: { amountPaise: 0, settlementMode: 'COMPLIMENTARY' }
    }).catch(e => console.error('[EMAIL ERROR]', e.message));

    return {
      success: true,
      freeRegistration: true,
      message: '100% complimentary coupon applied! Booking confirmed.',
      invitation: {
        reference: registration.reference,
        status: 'CONFIRMED',
        baseAmountPaise: quote.baseAmountPaise,
        baseAmountRupees: quote.baseAmountPaise / 100,
        discountPaise: quote.discountPaise,
        discountRupees: quote.discountPaise / 100,
        amountPaise: 0,
        amountRupees: 0,
        coupon: {
          code: coupon.displayCode || coupon.code,
          discountValue: coupon.discountValue,
          discountType: coupon.discountType,
          isFree: true
        }
      }
    };
  }

  // Discount branch (payable > 0)
  try {
    await prisma.$transaction(async (tx) => {
      await attachCouponToRegistration(tx, {
        coupon,
        registration,
        quote,
        initialStatus: 'RESERVED'
      });

      await tx.registration.update({
        where: { id: registration.id },
        data: {
          baseAmountPaise: quote.baseAmountPaise,
          discountPaise: quote.discountPaise,
          amountPaise: quote.payableAmountPaise
        }
      });

      await tx.paymentInvitation.update({
        where: { id: invitation.id },
        data: {
          amountPaise: quote.payableAmountPaise
        }
      });
    });

    return {
      success: true,
      freeRegistration: false,
      message: 'Coupon applied successfully.',
      invitation: {
        reference: registration.reference,
        baseAmountPaise: quote.baseAmountPaise,
        baseAmountRupees: quote.baseAmountPaise / 100,
        discountPaise: quote.discountPaise,
        discountRupees: quote.discountPaise / 100,
        amountPaise: quote.payableAmountPaise,
        amountRupees: quote.payableAmountPaise / 100,
        coupon: {
          code: coupon.displayCode || coupon.code,
          discountValue: coupon.discountValue,
          discountType: coupon.discountType,
          isFree: false
        }
      }
    };
  } catch (err) {
    await compensateCouponReservation(prisma, coupon.id, 'APPLY_COUPON_FAILED');
    throw err;
  }
}

/**
 * Removes an applied coupon from a pending payment invitation.
 */
export async function removeCouponFromInvitation(token) {
  if (!token || typeof token !== 'string') {
    const error = new Error('Invalid invitation token.');
    error.status = 400;
    throw error;
  }

  const invitation = await prisma.paymentInvitation.findUnique({
    where: { token: token.trim() },
    include: { registration: true }
  });

  if (!invitation) {
    const error = new Error('Payment invitation not found or invalid link.');
    error.status = 404;
    throw error;
  }

  const { registration } = invitation;

  if (registration.status === 'PAID' || registration.status === 'CONFIRMED') {
    throw couponError('COUPON_NOT_APPLICABLE_STATE', 'Cannot remove coupon from a completed registration.', 409);
  }

  if (!registration.couponId) {
    return {
      success: true,
      message: 'No coupon applied.',
      invitation: {
        reference: registration.reference,
        amountPaise: registration.amountPaise,
        amountRupees: registration.amountPaise / 100
      }
    };
  }

  let dbCategory = null;
  try {
    dbCategory = await prisma.category.findUnique({
      where: { slug: registration.categorySlug }
    });
  } catch (err) {}

  const authoritativeBasePaise = dbCategory ? dbCategory.feePaise : (registration.baseAmountPaise || invitation.amountPaise);
  const baseFee = registration.baseAmountPaise ?? authoritativeBasePaise;

  await prisma.$transaction(async (tx) => {
    await releaseCouponForRegistration(tx, registration.id, 'USER_REMOVED');

    await tx.registration.update({
      where: { id: registration.id },
      data: {
        baseAmountPaise: baseFee,
        amountPaise: baseFee,
        discountPaise: 0,
        couponId: null,
        couponCode: null
      }
    });

    await tx.paymentInvitation.update({
      where: { id: invitation.id },
      data: {
        amountPaise: baseFee
      }
    });
  });

  return {
    success: true,
    message: 'Coupon removed successfully.',
    invitation: {
      reference: registration.reference,
      baseAmountPaise: baseFee,
      baseAmountRupees: baseFee / 100,
      discountPaise: 0,
      discountRupees: 0,
      amountPaise: baseFee,
      amountRupees: baseFee / 100,
      coupon: null
    }
  };
}

export const createApplication = (data) => createRegistration({ ...data, applicationMode: true });


