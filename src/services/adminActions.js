import { prisma } from '../db/prisma.js';
import { CATEGORIES } from '../config/event.js';
import { getRazorpayClient } from './razorpay.js';
import { sendPaymentConfirmationEmail } from './email.js';
import { validateCouponDefinition, validateBatchGenerationRequest } from './couponValidation.js';
import { generateCouponBatch } from './couponCodes.js';
import { releaseCouponForRegistration } from './coupons.js';
import { releaseStaleReservations } from './couponMaintenance.js';

/**
 * Write-side operations for the dashboard.
 *
 * The rule that shapes this file: the dashboard may record a decision, but it
 * may not assert a financial fact. Money is only ever marked collected after
 * Razorpay has been asked directly and has answered "captured" for the right
 * order at the right amount. There is no code path anywhere that lets a button
 * press alone turn a payment green.
 */

function badRequest(message, code = 'BAD_REQUEST', status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

// ----------------------------------------------------------------------- notes

export async function addRegistrationNote({ reference, body, admin }) {
  const text = String(body ?? '').trim();
  if (!text) throw badRequest('A note cannot be empty.');
  if (text.length > 2000) throw badRequest('A note must be 2000 characters or fewer.');

  const registration = await prisma.registration.findUnique({ where: { reference } });
  if (!registration) throw badRequest('Registration not found.', 'NOT_FOUND', 404);

  const note = await prisma.adminNote.create({
    data: {
      registrationReference: reference,
      adminUserId: admin.id,
      authorEmail: admin.email,
      body: text
    }
  });

  return { id: note.id, body: note.body, authorEmail: note.authorEmail, createdAt: note.createdAt };
}

// ------------------------------------------------------------------ cancelling

/**
 * Cancels a registration.
 *
 * Payment and email history is never deleted — the registration is marked
 * cancelled and the reason recorded, so the trail of what was collected and
 * when survives the cancellation.
 *
 * Releases any reserved or consumed coupon redemptions atomically.
 */
export async function cancelRegistration({ reference, reason, acknowledgeNoRefund, admin }) {
  const text = String(reason ?? '').trim();
  if (text.length < 3) throw badRequest('Give a reason for the cancellation.');
  if (text.length > 500) throw badRequest('The reason must be 500 characters or fewer.');

  const registration = await prisma.registration.findUnique({ where: { reference } });
  if (!registration) throw badRequest('Registration not found.', 'NOT_FOUND', 404);

  if (registration.status === 'CANCELLED') {
    return { alreadyCancelled: true, reference, cancelledAt: registration.cancelledAt };
  }

  if (registration.status === 'PAID' && acknowledgeNoRefund !== true) {
    throw badRequest(
      'This registration has been paid for. Cancelling it here does not refund the participant — a refund must be issued separately in Razorpay. Confirm you understand to proceed.',
      'REFUND_ACKNOWLEDGEMENT_REQUIRED',
      409
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (registration.couponId) {
      await releaseCouponForRegistration(tx, registration.id, 'ADMIN_CANCEL');
    }

    return tx.registration.update({
      where: { id: registration.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: `${text} — cancelled by ${admin.email}`
      }
    });
  });

  return {
    reference: updated.reference,
    status: updated.status,
    cancelledAt: updated.cancelledAt,
    previousStatus: registration.status,
    wasPaid: registration.status === 'PAID'
  };
}

// ------------------------------------------------------------------- check-in

/**
 * Event-day attendance. Kept strictly separate from registration status:
 * checking someone in says they arrived, not that they qualified or won.
 */
export async function setCheckIn({ reference, checkedIn, admin }) {
  const registration = await prisma.registration.findUnique({ where: { reference } });
  if (!registration) throw badRequest('Registration not found.', 'NOT_FOUND', 404);

  if (checkedIn && registration.status !== 'PAID') {
    throw badRequest(
      'Only confirmed registrations can be checked in.',
      'REGISTRATION_NOT_CONFIRMED',
      409
    );
  }

  const updated = await prisma.registration.update({
    where: { id: registration.id },
    data: checkedIn
      ? { checkedInAt: new Date(), checkedInBy: admin.email }
      : { checkedInAt: null, checkedInBy: null }
  });

  return {
    reference: updated.reference,
    checkedInAt: updated.checkedInAt,
    checkedInBy: updated.checkedInBy
  };
}

// ------------------------------------------------------------- reconciliation

/**
 * Asks Razorpay what actually happened to an order and brings the local record
 * into line with the answer.
 *
 * This is the only route by which the dashboard can move a payment to CAPTURED,
 * and the decision is Razorpay's, not the operator's: the payment must come
 * back captured, on this order, for this exact amount. A mismatch is reported
 * rather than reconciled, because a mismatch means something is wrong that a
 * status flip would bury.
 *
 * Safe to run twice — an already-captured payment returns its existing state.
 */
export async function reconcilePayment({ orderId, admin }) {
  const payment = await prisma.payment.findUnique({
    where: { razorpayOrderId: orderId },
    include: { registration: true }
  });

  if (!payment) throw badRequest('No payment found for that order.', 'NOT_FOUND', 404);

  const rzp = getRazorpayClient();
  if (!rzp) {
    throw badRequest(
      'Razorpay is not configured on this server, so payments cannot be reconciled.',
      'GATEWAY_NOT_CONFIGURED',
      503
    );
  }

  let remote;
  try {
    remote = await rzp.orders.fetchPayments(orderId);
  } catch (err) {
    // The Razorpay SDK reports failures in several shapes, and some carry no
    // message at all — which produced a literal "undefined" in the dashboard.
    // Fall back through them, then say something useful rather than nothing.
    const described =
      err?.error?.description ||
      err?.error?.reason ||
      err?.description ||
      err?.message ||
      null;

    const status = err?.statusCode ?? err?.error?.code;

    // A 404 from the gateway carries no body at all — the SDK surfaces it as
    // bare { statusCode: 404 } — so the status is the only thing to go on.
    if (status === 404 || status === 400 || /does not exist|not found/i.test(described ?? '')) {
      throw badRequest(
        `Razorpay has no record of order ${orderId}. This happens with orders that were never created at the gateway — test fixtures, for instance — so there is nothing to reconcile.`,
        'ORDER_NOT_AT_GATEWAY',
        404
      );
    }

    throw badRequest(
      described
        ? `Razorpay could not be reached: ${described}`
        : 'Razorpay could not be reached, and returned no reason. Check the API server can make outbound HTTPS requests, and that the Razorpay keys are for the same mode (test or live) as this order.',
      'GATEWAY_ERROR',
      502
    );
  }

  const attempts = remote?.items ?? [];
  const captured = attempts.find((p) => p.status === 'captured');

  if (!captured) {
    const latest = attempts[attempts.length - 1];
    const reason =
      latest?.error_description || latest?.error_reason || 'No captured payment on this order.';

    // Record the failure locally so the operator sees the same answer next time
    // without another round trip, but never touch a payment already captured.
    if (payment.status !== 'CAPTURED' && latest?.status === 'failed') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: String(reason).slice(0, 255) }
      });
    }

    return {
      reconciled: false,
      orderId,
      reference: payment.registrationReference,
      gatewayStatus: latest?.status ?? 'none',
      attempts: attempts.length,
      reason
    };
  }

  if (captured.amount !== payment.amountPaise) {
    // Deliberately not reconciled. Marking this paid would record a fee that
    // was never agreed; it needs a person.
    return {
      reconciled: false,
      orderId,
      reference: payment.registrationReference,
      gatewayStatus: 'captured',
      mismatch: {
        expectedPaise: payment.amountPaise,
        capturedPaise: captured.amount
      },
      reason:
        'Razorpay captured a different amount than this registration was priced at. Resolve this manually before confirming.'
    };
  }

  if (payment.status === 'CAPTURED' && payment.registration.status === 'PAID') {
    return {
      reconciled: true,
      alreadyConsistent: true,
      orderId,
      reference: payment.registrationReference,
      razorpayPaymentId: payment.razorpayPaymentId
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        razorpayPaymentId: captured.id,
        status: 'CAPTURED',
        failureReason: null
      }
    });
    // A cancelled registration is left cancelled: someone decided that, and a
    // reconciliation job should not quietly reverse a human decision.
    if (payment.registration.status === 'AWAITING_PAYMENT') {
      await tx.registration.update({
        where: { id: payment.registrationId },
        data: { status: 'PAID' }
      });
    }
  });

  const fresh = await prisma.registration.findUnique({ where: { id: payment.registrationId } });

  sendPaymentConfirmationEmail({
    registration: fresh,
    payment: { ...payment, razorpayPaymentId: captured.id }
  }).catch((err) => console.error('[RECONCILE] confirmation email error:', err.message));

  return {
    reconciled: true,
    orderId,
    reference: payment.registrationReference,
    razorpayPaymentId: captured.id,
    registrationStatus: fresh.status,
    previousPaymentStatus: payment.status,
    reconciledBy: admin.email
  };
}

// ------------------------------------------------------------------ messaging

/**
 * Resends the confirmation email for a single registration.
 *
 * Returns what actually happened at the SMTP handshake. "Accepted by the mail
 * server" is not "delivered to the participant", and the dashboard says so —
 * there is no delivery receipt available from this transport.
 */
export async function resendConfirmationEmail({ reference, admin }) {
  const registration = await prisma.registration.findUnique({
    where: { reference },
    include: { payments: { where: { status: 'CAPTURED' }, orderBy: { createdAt: 'desc' }, take: 1 } }
  });

  if (!registration) throw badRequest('Registration not found.', 'NOT_FOUND', 404);

  if (registration.status !== 'PAID') {
    throw badRequest(
      'A confirmation can only be sent for a registration whose payment is confirmed.',
      'REGISTRATION_NOT_CONFIRMED',
      409
    );
  }

  const payment = registration.payments[0];
  if (!payment) {
    throw badRequest(
      'This registration is marked paid but has no captured payment on file. Reconcile it before sending a confirmation.',
      'NO_CAPTURED_PAYMENT',
      409
    );
  }

  const result = await sendPaymentConfirmationEmail({ registration, payment, force: true });

  return {
    reference,
    accepted: result.success === true,
    simulated: result.simulated === true,
    error: result.error ?? null,
    sentBy: admin.email
  };
}

/** Expected fee for a category, used to flag priced-differently registrations. */
export function expectedFeePaise(categorySlug) {
  return CATEGORIES[categorySlug]?.feePaise ?? null;
}

// --------------------------------------------------------------------- coupons

export async function createCouponAction({ data, adminEmail }) {
  const { isValid, errors, cleaned } = validateCouponDefinition(data);
  if (!isValid) {
    throw badRequest('Coupon validation failed.', 'COUPON_VALIDATION_FAILED', 400, errors);
  }

  const existing = await prisma.coupon.findUnique({
    where: { code: cleaned.code }
  });

  if (existing) {
    throw badRequest('A coupon with this code already exists.', 'COUPON_CODE_TAKEN', 409);
  }

  const coupon = await prisma.coupon.create({
    data: {
      code: cleaned.code,
      displayCode: cleaned.displayCode,
      description: cleaned.description,
      discountType: cleaned.discountType,
      discountValue: cleaned.discountValue,
      categorySlugs: cleaned.categorySlugs,
      maxRedemptions: cleaned.maxRedemptions,
      perEmailLimit: cleaned.perEmailLimit,
      startsAt: cleaned.startsAt,
      expiresAt: cleaned.expiresAt,
      status: cleaned.status,
      createdByEmail: adminEmail
    }
  });

  return coupon;
}

export async function generateCouponsAction({ data, adminEmail }) {
  const { isValid, errors, cleaned } = validateBatchGenerationRequest(data);
  if (!isValid) {
    throw badRequest('Batch generation validation failed.', 'COUPON_VALIDATION_FAILED', 400, errors);
  }

  return generateCouponBatch(prisma, cleaned, adminEmail);
}

export async function updateCouponAction({ id, data, adminEmail }) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw badRequest('Coupon not found.', 'NOT_FOUND', 404);

  // Immutability rule: code and discountValue cannot change once redeemedCount > 0
  if (coupon.redeemedCount > 0) {
    if (data.code && String(data.code).trim().toUpperCase().replace(/[\s\-_]+/g, '') !== coupon.code) {
      throw badRequest(
        `Used by ${coupon.redeemedCount} registration(s) — the coupon code can no longer be changed.`,
        'COUPON_IMMUTABLE',
        409
      );
    }
    if (data.discountValue !== undefined && Number(data.discountValue) !== coupon.discountValue) {
      throw badRequest(
        `Used by ${coupon.redeemedCount} registration(s) — the discount percentage can no longer be changed.`,
        'COUPON_IMMUTABLE',
        409
      );
    }
  }

  const { isValid, errors, cleaned } = validateCouponDefinition(data, {
    isEdit: true,
    currentRedeemedCount: coupon.redeemedCount
  });

  if (!isValid) {
    throw badRequest('Coupon validation failed.', 'COUPON_VALIDATION_FAILED', 400, errors);
  }

  // Calculate changed fields for audit log
  const diff = {};
  for (const [key, val] of Object.entries(cleaned)) {
    if (JSON.stringify(coupon[key]) !== JSON.stringify(val)) {
      diff[key] = { from: coupon[key], to: val };
    }
  }

  const updated = await prisma.coupon.update({
    where: { id },
    data: {
      ...cleaned,
      updatedAt: new Date()
    }
  });

  return { coupon: updated, diff };
}

export async function pauseCouponAction(id) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw badRequest('Coupon not found.', 'NOT_FOUND', 404);

  return prisma.coupon.update({
    where: { id },
    data: { status: 'PAUSED' }
  });
}

export async function resumeCouponAction(id) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw badRequest('Coupon not found.', 'NOT_FOUND', 404);

  return prisma.coupon.update({
    where: { id },
    data: { status: 'ACTIVE' }
  });
}

export async function deleteCouponAction(id) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw badRequest('Coupon not found.', 'NOT_FOUND', 404);

  const redemptionCount = await prisma.couponRedemption.count({ where: { couponId: id } });

  if (coupon.redeemedCount > 0 || redemptionCount > 0) {
    const updated = await prisma.coupon.update({
      where: { id },
      data: { isArchived: true, archivedAt: new Date() }
    });
    return {
      action: 'ARCHIVED',
      couponId: id,
      code: coupon.code,
      message: `Coupon archived. ${redemptionCount} redemptions were preserved in the ledger.`,
      coupon: updated
    };
  }

  await prisma.coupon.delete({ where: { id } });
  return {
    action: 'DELETED',
    couponId: id,
    code: coupon.code,
    message: 'Coupon permanently deleted.'
  };
}

export async function archiveCouponBatchAction(batchId) {
  const result = await prisma.coupon.updateMany({
    where: { batchId, isArchived: false },
    data: { isArchived: true, archivedAt: new Date() }
  });

  return {
    batchId,
    archivedCount: result.count
  };
}

export async function sweepStaleReservationsAction({ ttlMinutes }) {
  return releaseStaleReservations({ prisma, ttlMinutes });
}

