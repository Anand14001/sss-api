import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../src/app.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

test('Razorpay Webhook Handler', async (t) => {
  await setupTestEnvironment();

  t.after(async () => {
    await teardownTestEnvironment();
  });

  const webhookSecret = 'test_webhook_secret_12345';

  await t.test('Rejects webhook without signature or with invalid signature', async () => {
    const payload = JSON.stringify({ event: 'payment.captured' });
    const res = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'invalid_signature_hex')
      .send(payload);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, 'Invalid webhook signature');
  });

  await t.test('Processes valid order.paid webhook and transitions registration to PAID', async () => {
    // 1. Create a registration
    const regRes = await request(app)
      .post('/api/v1/registrations')
      .send({
        fullName: 'Naveen Kumar',
        email: `naveen_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`,
        phone: '9876543210',
        category: 'kid',
        dob: '2015-02-10', // Age 11
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Kumar Sr',
        guardianRelationship: 'Father',
        guardianPhone: '9876543211',
        guardianEmail: 'kumar.sr@example.com'
      });

    const ref = regRes.body.registration.reference;
    const orderId = regRes.body.order.id;
    const paymentId = `pay_wh_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    const webhookPayloadObj = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: orderId,
            amount: regRes.body.order.amount,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const rawPayload = JSON.stringify(webhookPayloadObj);
    const validSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawPayload)
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', validSignature)
      .send(rawPayload);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.processed, true);
    assert.strictEqual(res.body.reference, ref);

    // Verify registration status is now PAID
    const statusRes = await request(app).get(`/api/v1/registrations/${ref}/status`);
    assert.strictEqual(statusRes.body.registration.status, 'PAID');

    // 2. Test duplicate webhook idempotency: sending same webhook again
    const dupeRes = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', validSignature)
      .send(rawPayload);

    assert.strictEqual(dupeRes.status, 200);
    assert.strictEqual(dupeRes.body.alreadyProcessed, true);
  });
});
