import { normaliseCouponCode } from './couponCodes.js';
import { evaluateRedemptionRules, getEffectiveStatus } from './couponValidation.js';
import { releaseStaleReservations } from './couponMaintenance.js';
import { env } from '../config/env.js';

/**
 * Creates a standard application error for coupon failures.
 *
 * @param {string} code
 * @param {string} message
 * @param {number} [status=400]
 * @param {Object} [details=null]
 * @returns {Error}
 */
export function couponError(code, message, status = 400, details = null) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (details) err.details = details;
  return err;
}

/**
 * Looks up a coupon by its raw code string (normalised).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} rawCode
 * @returns {Promise<any|null>}
 */
export async function findCouponByCode(prisma, rawCode) {
  const code = normaliseCouponCode(rawCode);
  if (!code) return null;
  return prisma.coupon.findUnique({
    where: { code }
  });
}

/**
 * Pre-checks and quotes a coupon for a category and email without reserving.
 * (Public preview endpoint: POST /coupons/validate).
 *
 * Runs the stale reservation sweeper lazily if the coupon is capped and looks
 * exhausted, guaranteeing that an expired hold doesn't lock out a visitor.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {Object} params
 * @param {string} params.code
 * @param {string} params.categorySlug
 * @param {string} [params.email]
 * @returns {Promise<{ valid: boolean, coupon?: any, quote?: any, isFree?: boolean, code?: string, error?: string }>}
 */
export async function validateAndQuoteCoupon(prisma, { code, categorySlug, email = null, baseAmountPaise = null }) {
  const normalisedCode = normaliseCouponCode(code);
  if (!normalisedCode) {
    return {
      valid: false,
      code: 'COUPON_INVALID',
      error: "That coupon code isn't valid."
    };
  }

  let coupon = await prisma.coupon.findUnique({
    where: { code: normalisedCode }
  });

  if (!coupon || coupon.isArchived) {
    return {
      valid: false,
      code: 'COUPON_INVALID',
      error: "That coupon code isn't valid."
    };
  }

  // Lazy sweeper: if capped and currently full, sweep stale holds and re-fetch
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    await releaseStaleReservations({ prisma });
    coupon = await prisma.coupon.findUnique({
      where: { code: normalisedCode }
    });
  }

  // Count existing redemptions for this email if perEmailLimit is configured
  let emailCount = 0;
  if (coupon.perEmailLimit && email) {
    const cleanEmail = email.trim().toLowerCase();
    emailCount = await prisma.couponRedemption.count({
      where: {
        couponId: coupon.id,
        email: cleanEmail,
        status: { in: ['RESERVED', 'CONSUMED'] }
      }
    });
  }

  // Resolve authoritative base amount from DB if not passed
  let effectiveBaseAmount = baseAmountPaise;
  if (effectiveBaseAmount === null || effectiveBaseAmount === undefined) {
    try {
      const dbCat = await prisma.category.findUnique({ where: { slug: categorySlug } });
      if (dbCat) {
        effectiveBaseAmount = dbCat.feePaise;
      }
    } catch {
      // fallback
    }
  }

  const result = evaluateRedemptionRules({
    coupon,
    categorySlug,
    emailRedemptionCount: emailCount,
    now: new Date(),
    baseAmountPaise: effectiveBaseAmount
  });

  if (!result.valid) {
    return {
      valid: false,
      code: result.code,
      error: result.error
    };
  }

  return {
    valid: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      displayCode: coupon.displayCode,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      categorySlugs: coupon.categorySlugs,
      maxRedemptions: coupon.maxRedemptions
    },
    quote: result.quote,
    isFree: result.isFree
  };
}

/**
 * ===========================================================================
 * ATOMIC CLAIM CHOKEPOINT (D4)
 * ===========================================================================
 *
 * This conditional update is the ONLY place in the entire codebase where
 * Coupon.redeemedCount is incremented.
 *
 * Because there are no database CHECK constraints on redeemedCount (§1.2), this
 * conditional update is the sole guarantee against overselling. Postgres
 * evaluates the WHERE clause against the locked row, so two concurrent claimers
 * cannot both claim the final remaining slot.
 *
 * @param {any} tx - Active Prisma transaction client
 * @param {any} coupon - The coupon model
 * @throws {Error} COUPON_LIMIT_REACHED if the slot could not be claimed
 */
export async function claimCouponSlot(tx, coupon) {
  let maxRedemptions = coupon.maxRedemptions;
  if (maxRedemptions === undefined) {
    const fresh = await tx.coupon.findUnique({
      where: { id: coupon.id },
      select: { maxRedemptions: true }
    });
    maxRedemptions = fresh?.maxRedemptions ?? null;
  }

  const claimed = await tx.coupon.updateMany({
    where: {
      id: coupon.id,
      isArchived: false,
      status: 'ACTIVE',
      OR: [
        { maxRedemptions: null },
        ...(maxRedemptions !== null ? [{ redeemedCount: { lt: maxRedemptions } }] : [])
      ]
    },
    data: {
      redeemedCount: { increment: 1 }
    }
  });

  if (claimed.count !== 1) {
    throw couponError('COUPON_LIMIT_REACHED', 'This coupon has been fully claimed.', 409);
  }
}

/**
 * Attaches a coupon to an existing registration in AWAITING_PAYMENT state (D4).
 *
 * Uses the same conditional WHERE technique on Registration.couponId to guarantee
 * that two concurrent apply-coupon calls serialize and cannot stack coupons.
 *
 * @param {any} tx - Active Prisma transaction client
 * @param {Object} params
 * @param {any} params.coupon
 * @param {any} params.registration
 * @param {Object} params.quote
 * @param {string} [params.initialStatus='RESERVED'] - 'RESERVED' or 'CONSUMED' (for free)
 * @returns {Promise<any>} Created CouponRedemption
 */
export async function attachCouponToRegistration(tx, {
  coupon,
  registration,
  quote,
  initialStatus = 'RESERVED'
}) {
  // 1. Claim slot on the coupon (throws if limit reached)
  await claimCouponSlot(tx, coupon);

  // 2. Lock-by-WHERE on the registration row: guarantees 1 coupon per registration
  const attached = await tx.registration.updateMany({
    where: {
      id: registration.id,
      couponId: null,
      status: { in: ['AWAITING_PAYMENT', 'PAYMENT_PENDING', 'SHORTLISTED', 'PAYMENT_FAILED'] }
    },
    data: {
      couponId: coupon.id,
      couponCode: coupon.code,
      baseAmountPaise: quote.baseAmountPaise,
      discountPaise: quote.discountPaise,
      amountPaise: quote.payableAmountPaise
    }
  });

  if (attached.count !== 1) {
    throw couponError(
      'COUPON_ALREADY_APPLIED',
      'A coupon is already applied to this registration or registration is no longer pending.',
      409
    );
  }

  // 3. Create redemption record
  const redemption = await tx.couponRedemption.create({
    data: {
      couponId: coupon.id,
      couponCode: coupon.code,
      registrationId: registration.id,
      registrationReference: registration.reference,
      email: registration.email.trim().toLowerCase(),
      categorySlug: registration.categorySlug,
      baseAmountPaise: quote.baseAmountPaise,
      discountPaise: quote.discountPaise,
      payableAmountPaise: quote.payableAmountPaise,
      status: initialStatus,
      reservedAt: new Date(),
      consumedAt: initialStatus === 'CONSUMED' ? new Date() : null
    }
  });

  return redemption;
}

/**
 * Consumes a RESERVED coupon for a registration.
 * Idempotent: called by both verify and webhook; safely no-ops if already CONSUMED
 * or if no coupon was attached.
 *
 * @param {any} tx - Active Prisma transaction client
 * @param {any} registration
 * @returns {Promise<boolean>} True if consumed, false if no-op
 */
export async function consumeCouponForRegistration(tx, registration) {
  if (!registration.couponId) return false;

  const reserved = await tx.couponRedemption.findFirst({
    where: {
      registrationId: registration.id,
      status: 'RESERVED'
    }
  });

  if (!reserved) {
    // Already CONSUMED or no active reservation
    return false;
  }

  await tx.couponRedemption.update({
    where: { id: reserved.id },
    data: {
      status: 'CONSUMED',
      consumedAt: new Date()
    }
  });

  return true;
}

/**
 * Releases a coupon reservation or consumed redemption for a registration.
 *
 * Guarantees:
 * - Counter is decremented with `redeemedCount: { gt: 0 }` so it never goes negative.
 * - Registration.couponId is nulled, reopening the slot for future application.
 * - Safe against double-release under concurrency.
 *
 * @param {any} tx - Active Prisma transaction client
 * @param {string} registrationId
 * @param {string} [reason='CANCELLED']
 * @returns {Promise<boolean>} True if released, false if nothing to release
 */
export async function releaseCouponForRegistration(tx, registrationId, reason = 'CANCELLED') {
  const redemption = await tx.couponRedemption.findFirst({
    where: {
      registrationId,
      status: { in: ['RESERVED', 'CONSUMED'] }
    }
  });

  if (!redemption) return false;

  // 1. Transition redemption status
  const updated = await tx.couponRedemption.updateMany({
    where: {
      id: redemption.id,
      status: { in: ['RESERVED', 'CONSUMED'] }
    },
    data: {
      status: 'RELEASED',
      releasedAt: new Date(),
      releaseReason: reason
    }
  });

  if (updated.count !== 1) return false;

  // 2. Clamped counter decrement on the coupon
  await tx.coupon.updateMany({
    where: {
      id: redemption.couponId,
      redeemedCount: { gt: 0 }
    },
    data: {
      redeemedCount: { decrement: 1 }
    }
  });

  // 3. Reset registration pricing to base fee and clear coupon
  await tx.registration.updateMany({
    where: { id: registrationId },
    data: {
      couponId: null,
      couponCode: null,
      discountPaise: 0,
      amountPaise: redemption.baseAmountPaise
    }
  });

  // 4. Reset active payment invitations to base fee
  await tx.paymentInvitation.updateMany({
    where: {
      registrationId,
      status: { in: ['PENDING', 'SENT'] }
    },
    data: {
      amountPaise: redemption.baseAmountPaise
    }
  });

  return true;
}

/**
 * Compensating release in case of an unhandled failure during registration
 * creation after slot was claimed.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} couponId
 * @param {string} [reason='COMPENSATION']
 */
export async function compensateCouponReservation(prisma, couponId, reason = 'COMPENSATION') {
  try {
    await prisma.coupon.updateMany({
      where: {
        id: couponId,
        redeemedCount: { gt: 0 }
      },
      data: {
        redeemedCount: { decrement: 1 }
      }
    });
    console.error(`[COUPON COMPENSATION] Compensated reservation slot for coupon ${couponId} (reason: ${reason})`);
  } catch (err) {
    console.error(`[COUPON COMPENSATION CRITICAL] Failed compensating coupon ${couponId}: ${err.message}`);
  }
}

/**
 * Integrity check between Coupon.redeemedCount and the CouponRedemption ledger.
 *
 * Reports:
 * - Drift per coupon between redeemedCount and active redemptions (RESERVED + CONSUMED)
 * - Number of stale RESERVED rows past the TTL
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<{ inSync: boolean, driftCount: number, issues: Array<any>, staleReservationsCount: number }>}
 */
export async function checkCouponsIntegrity(prisma) {
  // 1. Raw aggregate of active redemptions grouped by coupon_id
  const aggregates = await prisma.$queryRaw`
    SELECT
      c.id AS "couponId",
      c.code AS "code",
      c.display_code AS "displayCode",
      c.redeemed_count AS "redeemedCount",
      COALESCE(COUNT(r.id) FILTER (WHERE r.status IN ('RESERVED', 'CONSUMED')), 0)::int AS "ledgerCount"
    FROM coupons c
    LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
    WHERE c.is_archived = false
    GROUP BY c.id, c.code, c.display_code, c.redeemed_count
  `;

  const issues = [];
  for (const row of aggregates) {
    if (row.redeemedCount !== row.ledgerCount) {
      issues.push({
        couponId: row.couponId,
        code: row.code,
        displayCode: row.displayCode,
        redeemedCount: row.redeemedCount,
        ledgerCount: row.ledgerCount,
        drift: row.redeemedCount - row.ledgerCount
      });
      console.error(
        `[COUPON INTEGRITY DRIFT] Coupon ${row.code} (${row.couponId}): redeemedCount=${row.redeemedCount} != ledgerCount=${row.ledgerCount}`
      );
    }
  }

  // 2. Stale reservations past TTL
  const cutoff = new Date(Date.now() - (env.COUPON_RESERVATION_TTL_MINUTES * 60 * 1000));
  const staleCount = await prisma.couponRedemption.count({
    where: {
      status: 'RESERVED',
      reservedAt: { lt: cutoff },
      registration: {
        status: 'AWAITING_PAYMENT'
      }
    }
  });

  return {
    inSync: issues.length === 0,
    driftCount: issues.length,
    issues,
    staleReservationsCount: staleCount
  };
}
