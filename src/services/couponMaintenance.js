import { env } from '../config/env.js';

/**
 * Releases stale coupon reservations older than the configured TTL (default 30 mins)
 * whose registrations are still AWAITING_PAYMENT.
 *
 * Concurrency & Idempotency:
 * - Each row is updated in an atomic transaction guarded by `status: 'RESERVED'`.
 * - If a concurrent checkout consumes or admin cancels the reservation, the update
 *   affects 0 rows and is safely skipped.
 * - Decrements redeemedCount using the clamp `gt: 0` so counters never go negative.
 *
 * @param {Object} options
 * @param {import('@prisma/client').PrismaClient} options.prisma
 * @param {number} [options.ttlMinutes]
 * @returns {Promise<{ sweptCount: number }>}
 */
export async function releaseStaleReservations({ prisma, ttlMinutes = env.COUPON_RESERVATION_TTL_MINUTES }) {
  const cutoff = new Date(Date.now() - (ttlMinutes * 60 * 1000));

  // Find candidate stale reservations
  const candidates = await prisma.couponRedemption.findMany({
    where: {
      status: 'RESERVED',
      reservedAt: { lt: cutoff },
      registration: {
        status: 'AWAITING_PAYMENT'
      }
    },
    select: {
      id: true,
      couponId: true,
      couponCode: true,
      registrationId: true,
      registrationReference: true,
      baseAmountPaise: true
    }
  });

  let sweptCount = 0;

  for (const row of candidates) {
    try {
      await prisma.$transaction(async (tx) => {
        // Atomic status transition from RESERVED -> RELEASED
        const updated = await tx.couponRedemption.updateMany({
          where: {
            id: row.id,
            status: 'RESERVED'
          },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
            releaseReason: 'RESERVATION_EXPIRED'
          }
        });

        if (updated.count !== 1) {
          // Concurrently consumed or already released
          return;
        }

        // Detach coupon from registration and restore full base fee
        await tx.registration.updateMany({
          where: {
            id: row.registrationId,
            couponId: row.couponId,
            status: 'AWAITING_PAYMENT'
          },
          data: {
            couponId: null,
            couponCode: null,
            discountPaise: 0,
            amountPaise: row.baseAmountPaise
          }
        });

        // Clamped decrement on coupon counter
        await tx.coupon.updateMany({
          where: {
            id: row.couponId,
            redeemedCount: { gt: 0 }
          },
          data: {
            redeemedCount: { decrement: 1 }
          }
        });

        console.error(
          `[COUPON SWEEPER] Released stale reservation ${row.id} for coupon ${row.couponCode} on registration ${row.registrationReference}`
        );
        sweptCount++;
      });
    } catch (err) {
      console.error(
        `[COUPON SWEEPER ERROR] Failed releasing stale reservation ${row.id} for reference ${row.registrationReference}: ${err.message}`
      );
    }
  }

  return { sweptCount };
}
