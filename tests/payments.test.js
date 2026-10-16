import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../src/app.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

test('Payment Verification API', async (t) => {
  await setupTestEnvironment();

  t.after(async () => {
    await teardownTestEnvironment();
  });

  const secret = 'test_secret_12345';

  await t.test('Verifies valid signature and transitions registration to PAID', async () => {
    const testEmail = `ananya_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`;
    // 1. Create registration
    const regRes = await request(app)
      .post('/api/v1/registrations')
      .send({
        fullName: 'Ananya S',
        email: testEmail,
        phone: '9876543210',
        category: 'teen',
        dob: '2010-08-14', // Age 16 -> teen
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Sundar S',
        guardianRelationship: 'Father',
        guardianPhone: '9876543211',
        guardianEmail: 'sundar.s@example.com'
      });

    assert.strictEqual(regRes.status, 201);
    const ref = regRes.body.registration.reference;
    const orderId = regRes.body.order.id;
    const paymentId = `pay_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // 2. Generate valid HMAC SHA256 signature
    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    // 3. Submit verification
    const verifyRes = await request(app)
      .post('/api/v1/payments/verify')
      .send({
        registrationReference: ref,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: validSignature
      });

    assert.strictEqual(verifyRes.status, 200);
    assert.strictEqual(verifyRes.body.success, true);
    assert.strictEqual(verifyRes.body.registration.status, 'PAID');
    assert.strictEqual(verifyRes.body.registration.paymentId, paymentId);

    // 4. Verify status polling reflects PAID
    const statusRes = await request(app).get(`/api/v1/registrations/${ref}/status`);
    assert.strictEqual(statusRes.body.registration.status, 'PAID');
    assert.strictEqual(statusRes.body.registration.paymentStatus, 'CAPTURED');

    // 5. Test idempotency: re-submitting verification does not fail or duplicate
    const reVerifyRes = await request(app)
      .post('/api/v1/payments/verify')
      .send({
        registrationReference: ref,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: validSignature
      });

    assert.strictEqual(reVerifyRes.status, 200);
    assert.strictEqual(reVerifyRes.body.alreadyVerified, true);

    // Verify email delivery record was inserted in database
    const { prisma } = await import('../src/db/prisma.js');
    const emailRecord = await prisma.emailDelivery.findFirst({
      where: { registrationReference: ref, emailType: 'PAYMENT_CONFIRMATION' }
    });
    assert.ok(emailRecord);
    assert.strictEqual(emailRecord.recipientEmail, testEmail);
  });

  await t.test('Rejects invalid checkout signature with 400', async () => {
    const regRes = await request(app)
      .post('/api/v1/registrations')
      .send({
        fullName: 'Rohit Verma',
        email: `rohit_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`,
        phone: '9876543210',
        category: 'adult',
        dob: '1995-12-05',
        occupation: 'Business Owner',
        city: 'Salem'
      });

    const ref = regRes.body.registration.reference;
    const orderId = regRes.body.order.id;

    const res = await request(app)
      .post('/api/v1/payments/verify')
      .send({
        registrationReference: ref,
        razorpay_order_id: orderId,
        razorpay_payment_id: 'pay_tampered_123',
        razorpay_signature: 'fake_invalid_signature'
      });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.code, 'INVALID_SIGNATURE');
  });

  await t.test('POST /api/v1/registrations/:reference/retry-payment creates a new order for pending registration', async () => {
    const regRes = await request(app)
      .post('/api/v1/registrations')
      .send({
        fullName: 'Deepa R',
        email: `deepa_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`,
        phone: '9876543210',
        category: 'adult',
        dob: '1990-04-10',
        occupation: 'Home Maker',
        city: 'Salem'
      });

    const ref = regRes.body.registration.reference;
    const oldOrderId = regRes.body.order.id;

    const retryRes = await request(app).post(`/api/v1/registrations/${ref}/retry-payment`);

    assert.strictEqual(retryRes.status, 200);
    assert.strictEqual(retryRes.body.success, true);
    assert.notStrictEqual(retryRes.body.order.id, oldOrderId);
    assert.strictEqual(retryRes.body.order.amount, 25000);
  });
});
