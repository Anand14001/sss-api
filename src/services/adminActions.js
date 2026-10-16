import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { CATEGORIES } from '../config/event.js';
import { env } from '../config/env.js';
import {
  sendPaymentConfirmationEmail,
  sendPaymentInvitationEmail,
  sendRegistrationAcknowledgementEmail
} from './email.js';
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

  // If application is awaiting review or shortlisted, resend the registration acknowledgement
  if (registration.status === 'PENDING_REVIEW' || registration.status === 'SHORTLISTED') {
    const result = await sendRegistrationAcknowledgementEmail({ registration, force: true });
    return {
      reference,
      recipientEmail: registration.email,
      accepted: result.success === true || Boolean(result.messageId),
      simulated: result.simulated === true,
      error: result.error ?? null,
      sentBy: admin.email,
      emailType: 'REGISTRATION_ACKNOWLEDGEMENT'
    };
  }

  if (registration.status !== 'PAID' && registration.status !== 'CONFIRMED') {
    throw badRequest(
      'A confirmation can only be sent for a registration whose payment is confirmed.',
      'REGISTRATION_NOT_CONFIRMED',
      409
    );
  }

  const payment = registration.payments[0];
  if (!payment && registration.amountPaise > 0) {
    throw badRequest(
      'This registration is marked paid but has no captured payment on file. Reconcile it before sending a confirmation.',
      'NO_CAPTURED_PAYMENT',
      409
    );
  }

  const result = await sendPaymentConfirmationEmail({
    registration,
    payment: payment || { amountPaise: 0, settlementMode: 'COMPLIMENTARY' },
    force: true
  });

  return {
    reference,
    accepted: result.success === true,
    simulated: result.simulated === true,
    error: result.error ?? null,
    sentBy: admin.email
  };
}

export async function resendAcknowledgementEmail({ reference, admin }) {
  const registration = await prisma.registration.findUnique({ where: { reference } });
  if (!registration) throw badRequest('Registration not found.', 'NOT_FOUND', 404);

  const result = await sendRegistrationAcknowledgementEmail({ registration, force: true });
  return {
    reference,
    recipientEmail: registration.email,
    accepted: result.success === true || Boolean(result.messageId),
    simulated: result.simulated === true,
    error: result.error ?? null,
    sentBy: admin.email
  };
}

/** Expected fee for a category, used to flag priced-differently registrations. */
export async function expectedFeePaise(categorySlug) {
  try {
    const dbCat = await prisma.category.findUnique({ where: { slug: categorySlug } });
    if (dbCat) return dbCat.feePaise;
  } catch {
    // fallback
  }
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

// -------------------------------------------------------- application review & shortlisting

/**
 * Shortlists an applicant.
 * Does NOT generate a payment order or link. Shortlisting is a separate administrative decision.
 */
export async function shortlistApplicant({ reference, notes, admin }) {
  const registration = await prisma.registration.findUnique({ where: { reference } });
  if (!registration) throw badRequest('Application not found.', 'NOT_FOUND', 404);

  if (registration.status === 'CONFIRMED' || registration.status === 'PAID') {
    throw badRequest('This registration has already been confirmed and paid.', 'ALREADY_PAID', 400);
  }
  if (registration.status === 'CANCELLED') {
    throw badRequest('Cannot shortlist a cancelled registration.', 'REGISTRATION_CANCELLED', 400);
  }

  const updated = await prisma.registration.update({
    where: { id: registration.id },
    data: {
      status: 'SHORTLISTED',
      reviewDecision: 'SHORTLISTED',
      reviewNotes: notes ? String(notes).trim() : null,
      reviewedBy: admin.email,
      reviewedAt: new Date()
    }
  });

  return {
    reference: updated.reference,
    fullName: updated.fullName,
    status: updated.status,
    reviewDecision: updated.reviewDecision,
    reviewNotes: updated.reviewNotes,
    reviewedBy: updated.reviewedBy,
    reviewedAt: updated.reviewedAt
  };
}

/**
 * Rejects an applicant.
 * Ensures any active or unfulfilled payment invitations are cancelled so no payment can be made.
 */
export async function rejectApplicant({ reference, reason, admin }) {
  const registration = await prisma.registration.findUnique({ where: { reference } });
  if (!registration) throw badRequest('Application not found.', 'NOT_FOUND', 404);

  if (registration.status === 'CONFIRMED' || registration.status === 'PAID') {
    throw badRequest('Cannot reject a confirmed and paid registration.', 'CANNOT_REJECT_PAID', 400);
  }
  if (registration.status === 'CANCELLED') {
    throw badRequest('Cannot reject a cancelled registration.', 'REGISTRATION_CANCELLED', 400);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Invalidate any active payment invitations so rejected applicant cannot pay
    await tx.paymentInvitation.updateMany({
      where: {
        registrationId: registration.id,
        status: { in: ['PENDING', 'SENT'] }
      },
      data: {
        status: 'CANCELLED'
      }
    });

    return tx.registration.update({
      where: { id: registration.id },
      data: {
        status: 'REJECTED',
        reviewDecision: 'REJECTED',
        reviewNotes: reason ? String(reason).trim() : null,
        reviewedBy: admin.email,
        reviewedAt: new Date()
      }
    });
  });

  return {
    reference: updated.reference,
    fullName: updated.fullName,
    status: updated.status,
    reviewDecision: updated.reviewDecision,
    reviewNotes: updated.reviewNotes,
    reviewedBy: updated.reviewedBy,
    reviewedAt: updated.reviewedAt
  };
}

/**
 * Explicit administrative trigger to send a payment link to a shortlisted applicant.
 * Resolves authoritative fee from server config and generates unguessable invitation token.
 */
export async function sendPaymentInvitationAction({ reference, expiryDays = 7, force = false, admin }) {
  const registration = await prisma.registration.findUnique({
    where: { reference },
    include: {
      paymentInvitations: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });
  if (!registration) throw badRequest('Application not found.', 'NOT_FOUND', 404);

  if (registration.status === 'CONFIRMED' || registration.status === 'PAID') {
    throw badRequest('This registration has already been paid and confirmed.', 'ALREADY_PAID', 400);
  }

  if (registration.status === 'REJECTED') {
    throw badRequest('Cannot send a payment link to a rejected applicant.', 'APPLICANT_REJECTED', 400);
  }

  if (registration.status === 'CANCELLED') {
    throw badRequest('Cannot send a payment link to a cancelled registration.', 'REGISTRATION_CANCELLED', 400);
  }

  if (
    registration.status !== 'SHORTLISTED' &&
    registration.status !== 'PAYMENT_PENDING' &&
    registration.status !== 'PAYMENT_FAILED' &&
    registration.status !== 'PAYMENT_EXPIRED'
  ) {
    throw badRequest(
      `Applicant must be shortlisted before sending a payment link. Current status: ${registration.status}.`,
      'NOT_SHORTLISTED',
      400
    );
  }

  if (!registration.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registration.email.trim())) {
    throw badRequest('Applicant does not have a valid email address on record.', 'INVALID_EMAIL', 400);
  }

  // Derive authoritative fee from database categories (with static config fallback)
  let authoritativeFeePaise;
  let currency = 'INR';
  const dbCategory = await prisma.category.findUnique({
    where: { slug: registration.categorySlug }
  });

  if (dbCategory) {
    authoritativeFeePaise = dbCategory.feePaise;
    currency = dbCategory.currency || 'INR';
  } else {
    const category = CATEGORIES[registration.categorySlug];
    if (!category) {
      throw badRequest(`Unknown category: ${registration.categorySlug}`, 'UNKNOWN_CATEGORY', 400);
    }
    authoritativeFeePaise = category.feePaise;
    currency = category.currency || 'INR';
  }

  // Check for existing unexpired invitation (idempotency safeguard)
  const now = new Date();
  const existingActive = registration.paymentInvitations.find(
    (inv) => (inv.status === 'PENDING' || inv.status === 'SENT') && new Date(inv.expiresAt) > now
  );

  let invitation;
  const baseUrl = (env.FRONTEND_URL || 'https://sss.eventsinfinite.com').replace(/\/$/, '');

  // If existing link has a stale amount, do not silently reuse it! Recreate with new authoritative amount
  const hasStaleAmount = existingActive && existingActive.amountPaise !== authoritativeFeePaise;

  if (existingActive && !force && !hasStaleAmount) {
    // Concurrency safe reuse of valid existing link
    invitation = existingActive;
  } else {
    // Generate fresh high-entropy token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + Math.max(1, parseInt(expiryDays, 10) || 7) * 24 * 60 * 60 * 1000);

    invitation = await prisma.$transaction(async (tx) => {
      // Invalidate any older active invitations if issuing a fresh link
      if (existingActive) {
        await tx.paymentInvitation.updateMany({
          where: {
            registrationId: registration.id,
            status: { in: ['PENDING', 'SENT'] }
          },
          data: { status: 'CANCELLED' }
        });
      }

      const inv = await tx.paymentInvitation.create({
        data: {
          registrationId: registration.id,
          registrationReference: registration.reference,
          token,
          amountPaise: authoritativeFeePaise,
          currency,
          status: 'PENDING',
          sentToEmail: registration.email.trim(),
          expiresAt,
          createdByAdminEmail: admin.email
        }
      });

      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: 'PAYMENT_PENDING',
          amountPaise: authoritativeFeePaise
        }
      });

      return inv;
    });
  }

  const paymentUrl = `${baseUrl}/pay/${invitation.token}`;

  // Send email asynchronously
  const emailResult = await sendPaymentInvitationEmail({
    registration,
    invitation,
    paymentUrl
  });

  return {
    success: true,
    invitationId: invitation.id,
    token: invitation.token,
    paymentUrl,
    sentToEmail: registration.email,
    amountPaise: invitation.amountPaise,
    amountRupees: invitation.amountPaise / 100,
    expiresAt: invitation.expiresAt,
    status: emailResult.success ? 'SENT' : 'FAILED',
    deliveryStatus: emailResult.success ? 'SENT' : 'FAILED',
    emailError: emailResult.error || null,
    isReused: Boolean(existingActive && !force)
  };
}

/**
 * Validates eligibility for sending a payment invitation according to existing business rules.
 */
export function checkPaymentInvitationEligibility(registration) {
  if (!registration) {
    return { eligible: false, reason: 'Registration not found', code: 'NOT_FOUND' };
  }

  if (registration.isConfirmed || registration.status === 'CONFIRMED' || registration.status === 'PAID') {
    return { eligible: false, reason: 'Already paid and confirmed', code: 'ALREADY_PAID' };
  }

  if (registration.status === 'REJECTED' || registration.reviewDecision === 'REJECTED') {
    return { eligible: false, reason: 'Application has been rejected', code: 'APPLICANT_REJECTED' };
  }

  if (registration.status === 'CANCELLED') {
    return { eligible: false, reason: 'Registration has been cancelled', code: 'REGISTRATION_CANCELLED' };
  }

  const isShortlisted =
    registration.reviewDecision === 'SHORTLISTED' ||
    registration.status === 'SHORTLISTED' ||
    registration.status === 'PAYMENT_PENDING' ||
    registration.status === 'PAYMENT_FAILED' ||
    registration.status === 'PAYMENT_EXPIRED';

  if (!isShortlisted) {
    return {
      eligible: false,
      reason: `Applicant must be shortlisted first (current: ${registration.status || 'PENDING_REVIEW'})`,
      code: 'NOT_SHORTLISTED'
    };
  }

  const email = registration.email ? String(registration.email).trim() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { eligible: false, reason: 'Applicant has no valid email address on record', code: 'INVALID_EMAIL' };
  }

  return { eligible: true, reason: null, code: 'ELIGIBLE' };
}

/**
 * Previews bulk payment invitation eligibility and fees without sending emails or mutating state.
 */
export async function previewBulkPaymentInvitationsAction({ references = [] }) {
  if (!Array.isArray(references) || references.length === 0) {
    throw badRequest('Please provide a list of registration references to preview.', 'EMPTY_SELECTION', 400);
  }

  const uniqueReferences = [...new Set(references.map((r) => String(r || '').trim()).filter(Boolean))];
  if (uniqueReferences.length === 0) {
    throw badRequest('No valid registration references provided.', 'INVALID_REFERENCES', 400);
  }

  const registrations = await prisma.registration.findMany({
    where: { reference: { in: uniqueReferences } },
    include: {
      paymentInvitations: {
        where: {
          status: { in: ['PENDING', 'SENT'] },
          expiresAt: { gt: new Date() }
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  const dbCategories = await prisma.category.findMany();
  const categoryMap = new Map(dbCategories.map((c) => [c.slug, c]));
  const regMap = new Map(registrations.map((r) => [r.reference, r]));

  const items = uniqueReferences.map((ref) => {
    const reg = regMap.get(ref);
    if (!reg) {
      return {
        reference: ref,
        fullName: 'Unknown',
        email: null,
        categorySlug: null,
        categoryName: 'Unknown',
        amountRupees: 0,
        amountPaise: 0,
        status: 'NOT_FOUND',
        eligible: false,
        reason: 'Registration not found',
        hasActiveInvitation: false
      };
    }

    const dbCat = categoryMap.get(reg.categorySlug);
    const staticCat = CATEGORIES[reg.categorySlug] || {};
    const amountPaise = dbCat?.feePaise ?? staticCat.feePaise ?? 0;
    const amountRupees = Math.floor(amountPaise / 100);
    const categoryName = dbCat?.name || staticCat.name || reg.categorySlug;

    const eligibility = checkPaymentInvitationEligibility(reg);
    const hasActiveInvitation = reg.paymentInvitations && reg.paymentInvitations.length > 0;

    return {
      id: reg.id,
      reference: reg.reference,
      fullName: reg.fullName,
      email: reg.email,
      categorySlug: reg.categorySlug,
      categoryName,
      amountRupees,
      amountPaise,
      status: reg.status,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      hasActiveInvitation,
      existingInvitationAmountPaise: hasActiveInvitation ? reg.paymentInvitations[0].amountPaise : null
    };
  });

  return {
    success: true,
    total: items.length,
    eligibleCount: items.filter((i) => i.eligible).length,
    ineligibleCount: items.filter((i) => !i.eligible).length,
    items
  };
}

/**
 * Bulk administrative trigger to send payment links to multiple shortlisted applicants.
 * Concurrency bounded (max 4 at a time) to prevent SMTP / gateway bursts.
 * Partial failures do not roll back other successful invitations.
 */
export async function sendBulkPaymentInvitationsAction({ references = [], expiryDays = 7, force = false, admin }) {
  if (!Array.isArray(references) || references.length === 0) {
    throw badRequest('Please provide a list of registration references to process.', 'EMPTY_SELECTION', 400);
  }

  const uniqueReferences = [...new Set(references.map((r) => String(r || '').trim()).filter(Boolean))];
  if (uniqueReferences.length === 0) {
    throw badRequest('No valid registration references provided.', 'INVALID_REFERENCES', 400);
  }

  if (uniqueReferences.length > 100) {
    throw badRequest('Maximum 100 registrations can be processed in a single bulk action.', 'BATCH_TOO_LARGE', 400);
  }

  const registrations = await prisma.registration.findMany({
    where: { reference: { in: uniqueReferences } },
    select: {
      id: true,
      reference: true,
      fullName: true,
      email: true,
      categorySlug: true,
      status: true,
      reviewDecision: true
    }
  });

  const regMap = new Map(registrations.map((r) => [r.reference, r]));

  const CONCURRENCY = 4;
  const results = [];

  for (let i = 0; i < uniqueReferences.length; i += CONCURRENCY) {
    const chunk = uniqueReferences.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (ref) => {
        const reg = regMap.get(ref);
        try {
          const actionResult = await sendPaymentInvitationAction({
            reference: ref,
            expiryDays,
            force,
            admin
          });

          const isDeliveryFailed = actionResult.deliveryStatus === 'FAILED';

          return {
            id: reg?.id || null,
            reference: ref,
            fullName: reg?.fullName || 'Participant',
            email: reg?.email || actionResult.sentToEmail,
            categorySlug: reg?.categorySlug || null,
            amountPaise: actionResult.amountPaise,
            amountRupees: actionResult.amountRupees,
            status: isDeliveryFailed ? 'EMAIL_FAILED' : actionResult.isReused ? 'REUSED' : 'SUCCESS',
            deliveryStatus: actionResult.deliveryStatus,
            isReused: actionResult.isReused,
            reason: isDeliveryFailed
              ? (actionResult.emailError || 'Payment link generated but email delivery failed.')
              : actionResult.isReused
              ? 'Active payment link reused and resent.'
              : null,
            paymentUrl: actionResult.paymentUrl,
            invitationId: actionResult.invitationId,
            expiresAt: actionResult.expiresAt
          };
        } catch (err) {
          const isSkipped = [
            'ALREADY_PAID',
            'APPLICANT_REJECTED',
            'REGISTRATION_CANCELLED',
            'NOT_SHORTLISTED',
            'INVALID_EMAIL'
          ].includes(err.code);

          return {
            id: reg?.id || null,
            reference: ref,
            fullName: reg?.fullName || 'Participant',
            email: reg?.email || null,
            categorySlug: reg?.categorySlug || null,
            amountPaise: null,
            amountRupees: null,
            status: isSkipped ? 'SKIPPED' : 'FAILED',
            deliveryStatus: null,
            isReused: false,
            reason: err.message || 'Processing failed'
          };
        }
      })
    );

    results.push(...chunkResults);
  }

  const summary = {
    total: results.length,
    sent: results.filter((r) => r.status === 'SUCCESS').length,
    reused: results.filter((r) => r.status === 'REUSED').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    emailFailed: results.filter((r) => r.status === 'EMAIL_FAILED').length,
    failed: results.filter((r) => r.status === 'FAILED').length
  };

  return {
    success: true,
    summary,
    results
  };
}


