import crypto from 'node:crypto';
import { CATEGORIES, EVENT_CONFIG } from '../config/event.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { validateRegistrationPayload, isDeadlinePassed } from './validation.js';
import { createRazorpayOrder, verifyCheckoutSignature } from './razorpay.js';
import { sendPaymentConfirmationEmail } from './email.js';

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

  // 2. Deadline check
  if (isDeadlinePassed(EVENT_CONFIG.deadline)) {
    const error = new Error('Registration deadline has passed. Registrations are closed.');
    error.status = 400;
    error.code = 'DEADLINE_PASSED';
    throw error;
  }

  const category = CATEGORIES[cleaned.category];
  const feePaise = category.feePaise;
  const currency = category.currency;

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

  const registrationId = crypto.randomUUID();
  const reference = generateReference();

  // 4. Create Razorpay order
  let rzpOrder;
  try {
    rzpOrder = await createRazorpayOrder({
      amountPaise: feePaise,
      currency,
      receipt: reference,
      notes: {
        registrationReference: reference,
        category: cleaned.category,
        fullName: cleaned.fullName,
        email: cleaned.email
      }
    });
  } catch (err) {
    const error = new Error(`Failed to create payment order: ${err.message}`);
    error.status = 502;
    error.code = 'PAYMENT_GATEWAY_ERROR';
    throw error;
  }

  const paymentId = crypto.randomUUID();

  // 5. Atomic database insertion using Prisma transaction
  const { reg } = await prisma.$transaction(async (tx) => {
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
        amountPaise: feePaise,
        currency,
        status: 'AWAITING_PAYMENT'
      }
    });

    await tx.payment.create({
      data: {
        id: paymentId,
        registrationId: registrationId,
        registrationReference: reference,
        razorpayOrderId: rzpOrder.id,
        amountPaise: feePaise,
        currency,
        status: 'CREATED'
      }
    });

    return { reg };
  });

  return {
    registration: {
      id: reg.id,
      reference: reg.reference,
      fullName: reg.fullName,
      email: reg.email,
      phone: reg.phone,
      category: reg.categorySlug,
      categoryName: category.name,
      amountRupees: category.feeRupees,
      amountPaise: feePaise,
      currency,
      status: reg.status,
      createdAt: reg.createdAt
    },
    order: {
      id: rzpOrder.id,
      amount: feePaise,
      currency,
      keyId: env.RAZORPAY_KEY_ID
    }
  };
}

/**
 * Verifies payment checkout signature and confirms registration.
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
    // Record payment failure safely
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
        amountRupees: registration.amountPaise / 100,
        currency: registration.currency
      }
    };
  }

  // 3. Atomically update status in Prisma transaction
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
      amountRupees: registration.amountPaise / 100,
      currency: registration.currency,
      paymentId: razorpay_payment_id
    }
  };
}

/**
 * Handles incoming Razorpay webhook events using Prisma.
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

    // Verify amount consistency
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

  return {
    reference: reg.reference,
    fullName: reg.fullName,
    category: reg.categorySlug,
    status: reg.status,
    amountRupees: reg.amountPaise / 100,
    currency: reg.currency,
    paymentStatus: latestPayment ? latestPayment.status : null,
    orderId: latestPayment ? latestPayment.razorpayOrderId : null
  };
}

/**
 * Creates a fresh Razorpay order for retry if a payment was abandoned or failed.
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

  const rzpOrder = await createRazorpayOrder({
    amountPaise: reg.amountPaise,
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
      amountPaise: reg.amountPaise,
      currency: reg.currency,
      status: 'CREATED'
    }
  });

  return {
    reference: reg.reference,
    order: {
      id: rzpOrder.id,
      amount: reg.amountPaise,
      currency: reg.currency,
      keyId: env.RAZORPAY_KEY_ID
    }
  };
}
