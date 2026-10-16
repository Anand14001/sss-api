import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db/prisma.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';
import {
  claimCouponSlot,
  attachCouponToRegistration,
  consumeCouponForRegistration,
  releaseCouponForRegistration
} from '../src/services/coupons.js';
import { releaseStaleReservations } from '../src/services/couponMaintenance.js';
import { quotePrice } from '../src/services/pricing.js';

describe('Coupon Concurrency & Slot Invariants (D4)', () => {
  const createdCouponIds = [];
  const createdRegistrationIds = [];

  before(async () => {
    await setupTestEnvironment();
  });

  after(async () => {
    // Teardown test fixtures in dependency order
    if (createdRegistrationIds.length > 0) {
      await prisma.couponRedemption.deleteMany({
        where: { registrationId: { in: createdRegistrationIds } }
      });
      await prisma.payment.deleteMany({
        where: { registrationId: { in: createdRegistrationIds } }
      });
      await prisma.registration.deleteMany({
        where: { id: { in: createdRegistrationIds } }
      });
    }
    if (createdCouponIds.length > 0) {
      await prisma.couponRedemption.deleteMany({
        where: { couponId: { in: createdCouponIds } }
      });
      await prisma.coupon.deleteMany({
        where: { id: { in: createdCouponIds } }
      });
    }
    await teardownTestEnvironment();
  });

  // Helper to create a test coupon
  async function createTestCoupon(code, { maxRedemptions = 1, discountValue = 25 } = {}) {
    const coupon = await prisma.coupon.create({
      data: {
        code,
        displayCode: code,
        discountType: 'PERCENT',
        discountValue,
        maxRedemptions,
        redeemedCount: 0,
        status: 'ACTIVE'
      }
    });
    createdCouponIds.push(coupon.id);
    return coupon;
  }

  // Helper to create a test registration
  async function createTestRegistration(reference, { email = 'test@example.invalid', categorySlug = 'teen' } = {}) {
    const reg = await prisma.registration.create({
      data: {
        reference,
        categorySlug,
        fullName: 'Test Participant',
        email,
        phone: '9876543210',
        dob: new Date('2010-05-15'),
        ageOnContest: 16,
        occupation: 'Student',
        city: 'Salem',
        amountPaise: 19900,
        baseAmountPaise: 19900,
        status: 'AWAITING_PAYMENT'
      }
    });
    createdRegistrationIds.push(reg.id);
    return reg;
  }

  // Test 1 of §12: A coupon with maxRedemptions = 1 and two simultaneous claims -> exactly one succeeds
  test('Test 1: Two parallel claims on a coupon with maxRedemptions = 1 -> exactly one succeeds', async () => {
    const testCode = `TESTCPN_C1_${Date.now()}`;
    const coupon = await createTestCoupon(testCode, { maxRedemptions: 1 });

    const claimTask = async () => {
      return prisma.$transaction(async (tx) => {
        await claimCouponSlot(tx, coupon);
        return 'SUCCESS';
      }).catch((err) => {
        return err.code || err.message;
      });
    };

    // Run simultaneously as real parallel promises
    const [res1, res2] = await Promise.all([claimTask(), claimTask()]);

    const successes = [res1, res2].filter((r) => r === 'SUCCESS');
    const failures = [res1, res2].filter((r) => r === 'COUPON_LIMIT_REACHED');

    assert.equal(successes.length, 1, 'Exactly one claim should succeed');
    assert.equal(failures.length, 1, 'The other claim should fail with COUPON_LIMIT_REACHED');

    const updatedCoupon = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(updatedCoupon.redeemedCount, 1, 'redeemedCount must be 1, never 2');
  });

  // Test 2 of §12: Two simultaneous apply-coupon calls for the SAME reference -> exactly one attaches
  test('Test 2: Two simultaneous attach calls on the SAME registration -> exactly one attaches', async () => {
    const codeA = `TESTCPN_A_${Date.now()}`;
    const codeB = `TESTCPN_B_${Date.now()}`;
    const couponA = await createTestCoupon(codeA, { maxRedemptions: 10 });
    const couponB = await createTestCoupon(codeB, { maxRedemptions: 10 });

    const reg = await createTestRegistration(`SSS-2026-TEST${Math.floor(Math.random() * 899999 + 100000)}`);
    const quoteA = quotePrice({ categorySlug: reg.categorySlug, coupon: couponA });
    const quoteB = quotePrice({ categorySlug: reg.categorySlug, coupon: couponB });

    const attachTask = async (coupon, quote) => {
      return prisma.$transaction(async (tx) => {
        return attachCouponToRegistration(tx, {
          coupon,
          registration: reg,
          quote
        });
      }).then(() => 'SUCCESS').catch((err) => err.code || err.message);
    };

    const [resA, resB] = await Promise.all([
      attachTask(couponA, quoteA),
      attachTask(couponB, quoteB)
    ]);

    const successes = [resA, resB].filter((r) => r === 'SUCCESS');
    const failures = [resA, resB].filter((r) => r === 'COUPON_ALREADY_APPLIED');

    assert.equal(successes.length, 1, 'Exactly one attach must succeed');
    assert.equal(failures.length, 1, 'The loser must receive COUPON_ALREADY_APPLIED');

    const redemptions = await prisma.couponRedemption.findMany({
      where: { registrationId: reg.id }
    });
    assert.equal(redemptions.length, 1, 'Only one CouponRedemption row must be created');

    const updatedCouponA = await prisma.coupon.findUnique({ where: { id: couponA.id } });
    const updatedCouponB = await prisma.coupon.findUnique({ where: { id: couponB.id } });
    assert.equal(updatedCouponA.redeemedCount + updatedCouponB.redeemedCount, 1, 'Total claimed counter must increment by only 1');
  });

  // Test 4 of §12: The sweeper racing a verify -> never a CONSUMED row that was also RELEASED
  test('Test 4: Sweeper racing a payment confirmation -> never simultaneously CONSUMED and RELEASED', async () => {
    const testCode = `TESTCPN_RACE_${Date.now()}`;
    const coupon = await createTestCoupon(testCode, { maxRedemptions: 5 });
    const reg = await createTestRegistration(`SSS-2026-RACE${Math.floor(Math.random() * 899999 + 100000)}`);
    const quote = quotePrice({ categorySlug: reg.categorySlug, coupon });

    // Attach coupon
    await prisma.$transaction(async (tx) => {
      await attachCouponToRegistration(tx, { coupon, registration: reg, quote });
    });

    // Make reservation look stale by setting reservedAt into the past
    await prisma.couponRedemption.updateMany({
      where: { registrationId: reg.id },
      data: { reservedAt: new Date(Date.now() - 40 * 60 * 1000) }
    });

    // Race verify consumption vs sweeper
    const verifyAction = prisma.$transaction(async (tx) => {
      return consumeCouponForRegistration(tx, reg);
    });

    const sweeperAction = releaseStaleReservations({ prisma, ttlMinutes: 30 });

    await Promise.all([verifyAction, sweeperAction]);

    const finalRedemption = await prisma.couponRedemption.findFirst({
      where: { registrationId: reg.id }
    });

    assert.ok(
      finalRedemption.status === 'CONSUMED' || finalRedemption.status === 'RELEASED',
      'Status must be either CONSUMED or RELEASED'
    );

    const finalCoupon = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.ok(finalCoupon.redeemedCount >= 0, 'redeemedCount must never be negative');

    if (finalRedemption.status === 'CONSUMED') {
      assert.equal(finalCoupon.redeemedCount, 1);
    } else {
      assert.equal(finalCoupon.redeemedCount, 0);
    }
  });

  // Test 6 of §12: A double release (cancel, then sweeper) leaves redeemedCount at 0, not -1
  test('Test 6: Double release on a coupon leaves redeemedCount clamped at 0, not -1', async () => {
    const testCode = `TESTCPN_CLAMP_${Date.now()}`;
    const coupon = await createTestCoupon(testCode, { maxRedemptions: 5 });
    const reg = await createTestRegistration(`SSS-2026-CLAMP${Math.floor(Math.random() * 899999 + 100000)}`);
    const quote = quotePrice({ categorySlug: reg.categorySlug, coupon });

    await prisma.$transaction(async (tx) => {
      await attachCouponToRegistration(tx, { coupon, registration: reg, quote });
    });

    // First release (e.g. cancellation)
    const rel1 = await prisma.$transaction(async (tx) => {
      return releaseCouponForRegistration(tx, reg.id, 'ADMIN_CANCEL');
    });
    assert.equal(rel1, true);

    const afterRel1 = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(afterRel1.redeemedCount, 0);

    // Second release attempt (e.g. sweeper or second cancel call)
    const rel2 = await prisma.$transaction(async (tx) => {
      return releaseCouponForRegistration(tx, reg.id, 'SECOND_RELEASE');
    });
    assert.equal(rel2, false, 'Second release must be a no-op');

    const afterRel2 = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(afterRel2.redeemedCount, 0, 'redeemedCount must remain 0 and never drop to -1');
  });
});
