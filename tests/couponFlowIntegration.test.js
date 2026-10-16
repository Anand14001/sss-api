import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';
import { normaliseCouponCode } from '../src/services/couponCodes.js';
import { releaseCouponForRegistration } from '../src/services/coupons.js';
import { env } from '../src/config/env.js';

describe('Coupon Flow Integration Tests', () => {
  const createdCouponIds = [];
  const createdRegistrationIds = [];

  before(async () => {
    await setupTestEnvironment();
  });

  after(async () => {
    if (createdRegistrationIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { registrationId: { in: createdRegistrationIds } }
      });
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

  async function createCoupon({ code, discountValue = 25, maxRedemptions = 10, categorySlugs = [], status = 'ACTIVE', isArchived = false }) {
    const normCode = normaliseCouponCode(code);
    const cpn = await prisma.coupon.create({
      data: {
        code: normCode,
        displayCode: code,
        discountType: 'PERCENT',
        discountValue,
        maxRedemptions,
        redeemedCount: 0,
        categorySlugs,
        status,
        isArchived
      }
    });
    createdCouponIds.push(cpn.id);
    return cpn;
  }

  function makeParticipant(category = 'teen', email = null) {
    const ts = Date.now() + Math.floor(Math.random() * 10000);
    return {
      fullName: 'Test Candidate',
      email: email || `candidate_${ts}@example.invalid`,
      phone: '9876543210',
      category,
      dob: category === 'kid' ? '2014-06-15' : category === 'teen' ? '2010-06-15' : '1995-06-15',
      occupation: 'Student',
      city: 'Salem',
      ...(category !== 'adult'
        ? {
            guardianName: 'Test Guardian',
            guardianRelationship: 'Father',
            guardianPhone: '9876543211',
            guardianEmail: 'test.guardian@example.com'
          }
        : {})
    };
  }

  test('No-coupon registration flow is unchanged', async () => {
    const payload = makeParticipant('kid');
    const res = await request(app)
      .post('/api/v1/registrations')
      .send(payload);

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.freeRegistration, false);
    assert.ok(res.body.order.id);
    assert.equal(res.body.order.amount, 25000);
    assert.equal(res.body.registration.amountPaise, 25000);
    assert.equal(res.body.registration.baseAmountPaise, 25000);
    assert.equal(res.body.registration.discountPaise, 0);
    assert.equal(res.body.registration.coupon, null);

    createdRegistrationIds.push(res.body.registration.id);
  });

  test('Public coupon validate endpoint (POST /coupons/validate)', async () => {
    const code = `TESTVAL_${Date.now()}`;
    await createCoupon({ code, discountValue: 20, categorySlugs: ['teen'] });

    // Valid preview
    const resValid = await request(app)
      .post('/api/v1/coupons/validate')
      .send({ code, category: 'teen' });

    assert.equal(resValid.status, 200);
    assert.equal(resValid.body.success, true);
    assert.equal(resValid.body.valid, true);
    assert.equal(resValid.body.quote.discountPaise, 5000); // 20% of 25000
    assert.equal(resValid.body.quote.payableAmountPaise, 20000);

    // Business rejection (wrong category) -> returns 200 valid: false
    const resWrongCat = await request(app)
      .post('/api/v1/coupons/validate')
      .send({ code, category: 'kid' });

    assert.equal(resWrongCat.status, 200);
    assert.equal(resWrongCat.body.success, true);
    assert.equal(resWrongCat.body.valid, false);
    assert.equal(resWrongCat.body.code, 'COUPON_WRONG_CATEGORY');
  });

  test('Discounted registration creates order for discounted amount and reserves coupon', async () => {
    const code = `TESTDISC_${Date.now()}`;
    const coupon = await createCoupon({ code, discountValue: 25, maxRedemptions: 5 });

    const payload = {
      ...makeParticipant('teen'),
      couponCode: code
    };

    const res = await request(app)
      .post('/api/v1/registrations')
      .send(payload);

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.freeRegistration, false);
    // Teen fee: 25000 -> 25% discount = 6250 -> payable = 18750
    assert.equal(res.body.registration.baseAmountPaise, 25000);
    assert.equal(res.body.registration.discountPaise, 6250);
    assert.equal(res.body.registration.amountPaise, 18750);
    assert.equal(res.body.order.amount, 18750);

    createdRegistrationIds.push(res.body.registration.id);

    // Check reservation was created with status RESERVED
    const redemption = await prisma.couponRedemption.findFirst({
      where: { registrationId: res.body.registration.id }
    });
    assert.ok(redemption);
    assert.equal(redemption.status, 'RESERVED');
    assert.equal(redemption.discountPaise, 6250);

    // Counter incremented to 1
    const updatedCoupon = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(updatedCoupon.redeemedCount, 1);
  });

  test('Webhook amount check passes with discounted amount and marks coupon CONSUMED', async () => {
    const code = `TESTWEB_${Date.now()}`;
    await createCoupon({ code, discountValue: 10 });

    const payload = { ...makeParticipant('kid'), couponCode: code };
    const createRes = await request(app).post('/api/v1/registrations').send(payload);
    createdRegistrationIds.push(createRes.body.registration.id);

    const orderId = createRes.body.order.id;
    const discountedPaise = createRes.body.registration.amountPaise; // 9900 - 990 = 8910

    // Webhook with correct discounted amount
    const webhookPayload = {
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: `pay_mock_${Date.now()}`,
            order_id: orderId,
            amount: discountedPaise,
            status: 'captured'
          }
        }
      }
    };

    const rawBody = JSON.stringify(webhookPayload);
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const webhookRes = await request(app)
      .post('/api/v1/payments/webhook')
      .set('x-razorpay-signature', signature)
      .send(webhookPayload);

    assert.equal(webhookRes.status, 200);
    assert.equal(webhookRes.body.processed, true);

    const reg = await prisma.registration.findUnique({ where: { id: createRes.body.registration.id } });
    assert.equal(reg.status, 'PAID');

    const red = await prisma.couponRedemption.findFirst({ where: { registrationId: reg.id } });
    assert.equal(red.status, 'CONSUMED');
  });

  test('Webhook carrying pre-discount amount is rejected as amount mismatch', async () => {
    const code = `TESTMIS_${Date.now()}`;
    await createCoupon({ code, discountValue: 20 });

    const payload = { ...makeParticipant('teen'), couponCode: code };
    const createRes = await request(app).post('/api/v1/registrations').send(payload);
    createdRegistrationIds.push(createRes.body.registration.id);

    const orderId = createRes.body.order.id;

    // Webhook maliciously or mistakenly carries the full base amount (19900 instead of 15920)
    const webhookPayload = {
      event: 'order.paid',
      payload: {
        payment: {
          entity: {
            id: `pay_mock_${Date.now()}`,
            order_id: orderId,
            amount: 19900,
            status: 'captured'
          }
        }
      }
    };

    const rawBody = JSON.stringify(webhookPayload);
    const signature = crypto
      .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const webhookRes = await request(app)
      .post('/api/v1/payments/webhook')
      .set('x-razorpay-signature', signature)
      .send(webhookPayload);

    assert.equal(webhookRes.status, 200);
    assert.equal(webhookRes.body.warning, 'Amount mismatch');

    // Registration must still be AWAITING_PAYMENT, not confirmed
    const reg = await prisma.registration.findUnique({ where: { id: createRes.body.registration.id } });
    assert.equal(reg.status, 'AWAITING_PAYMENT');
  });

  test('100% coupon bypasses Razorpay entirely and confirms at ₹0 (D3)', async () => {
    const code = `TESTFREE_${Date.now()}`;
    const coupon = await createCoupon({ code, discountValue: 100, maxRedemptions: 5 });

    const payload = {
      ...makeParticipant('adult'),
      couponCode: code
    };

    const res = await request(app)
      .post('/api/v1/registrations')
      .send(payload);

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.freeRegistration, true);
    assert.equal(res.body.order, null);
    assert.equal(res.body.registration.status, 'PAID');
    assert.equal(res.body.registration.amountPaise, 0);
    assert.equal(res.body.registration.discountPaise, 25000);

    createdRegistrationIds.push(res.body.registration.id);

    // Verify payment record
    const payment = await prisma.payment.findFirst({
      where: { registrationId: res.body.registration.id }
    });
    assert.ok(payment);
    assert.equal(payment.status, 'CAPTURED');
    assert.equal(payment.settlementMode, 'COMPLIMENTARY');
    assert.equal(payment.amountPaise, 0);
    assert.ok(payment.razorpayOrderId.startsWith('FREE-'));

    // Verify coupon redemption is directly CONSUMED
    const red = await prisma.couponRedemption.findFirst({
      where: { registrationId: res.body.registration.id }
    });
    assert.ok(red);
    assert.equal(red.status, 'CONSUMED');

    const updatedCoupon = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(updatedCoupon.redeemedCount, 1);
  });

  test('Apply and remove coupon on existing AWAITING_PAYMENT registration', async () => {
    // 1. Create registration without coupon
    const createRes = await request(app)
      .post('/api/v1/registrations')
      .send(makeParticipant('teen'));

    const ref = createRes.body.registration.reference;
    createdRegistrationIds.push(createRes.body.registration.id);

    // 2. Apply a 20% coupon
    const code = `TESTAPPLY_${Date.now()}`;
    const coupon = await createCoupon({ code, discountValue: 20 });

    const applyRes = await request(app)
      .post(`/api/v1/registrations/${ref}/apply-coupon`)
      .send({ couponCode: code });

    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.body.success, true);
    assert.equal(applyRes.body.registration.amountPaise, 20000);
    assert.equal(applyRes.body.order.amount, 20000);

    const cpnAfterApply = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(cpnAfterApply.redeemedCount, 1);

    // 3. Remove coupon
    const removeRes = await request(app)
      .delete(`/api/v1/registrations/${ref}/coupon`);

    assert.equal(removeRes.status, 200);
    assert.equal(removeRes.body.success, true);
    assert.equal(removeRes.body.registration.amountPaise, 25000);
    assert.equal(removeRes.body.order.amount, 25000);

    const cpnAfterRemove = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(cpnAfterRemove.redeemedCount, 0);
  });

  test('Paused and archived coupons are rejected at apply time', async () => {
    const pausedCode = `TESTPAUSED_${Date.now()}`;
    await createCoupon({ code: pausedCode, status: 'PAUSED' });

    const resPaused = await request(app)
      .post('/api/v1/registrations')
      .send({ ...makeParticipant('kid'), couponCode: pausedCode });

    assert.equal(resPaused.status, 400);
    assert.equal(resPaused.body.code, 'COUPON_PAUSED');

    const archivedCode = `TESTARCH_${Date.now()}`;
    await createCoupon({ code: archivedCode, isArchived: true });

    const resArchived = await request(app)
      .post('/api/v1/registrations')
      .send({ ...makeParticipant('kid'), couponCode: archivedCode });

    assert.equal(resArchived.status, 400);
    assert.equal(resArchived.body.code, 'COUPON_INVALID');
  });

  test('Cancelling a registration releases its reservation and nulls couponId', async () => {
    const code = `TESTCANCEL_${Date.now()}`;
    const coupon = await createCoupon({ code, discountValue: 25 });

    const createRes = await request(app)
      .post('/api/v1/registrations')
      .send({ ...makeParticipant('teen'), couponCode: code });

    const regId = createRes.body.registration.id;
    createdRegistrationIds.push(regId);

    const cpnBefore = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(cpnBefore.redeemedCount, 1);

    // Simulate cancellation by calling releaseCouponForRegistration
    await prisma.$transaction(async (tx) => {
      await releaseCouponForRegistration(tx, regId, 'ADMIN_CANCEL');
      await tx.registration.update({
        where: { id: regId },
        data: { status: 'CANCELLED', cancelledAt: new Date() }
      });
    });

    const regAfter = await prisma.registration.findUnique({ where: { id: regId } });
    assert.equal(regAfter.couponId, null);
    assert.equal(regAfter.status, 'CANCELLED');

    const cpnAfter = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    assert.equal(cpnAfter.redeemedCount, 0);
  });
});
