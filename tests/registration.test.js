import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

test('Registration API Endpoints', async (t) => {
  await setupTestEnvironment();

  t.after(async () => {
    await teardownTestEnvironment();
  });

  await t.test('GET /api/v1/health returns healthy status', async () => {
    const res = await request(app).get('/api/v1/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.database, 'healthy');
  });

  await t.test('GET /api/v1/event returns authoritative event & category details', async () => {
    const res = await request(app).get('/api/v1/event');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.event.name, 'Salem Star Speaker — The Speaking Contest');
    assert.strictEqual(res.body.categories.length, 3);

    // Verify fees in rupees and paise
    const kid = res.body.categories.find((c) => c.slug === 'kid');
    const teen = res.body.categories.find((c) => c.slug === 'teen');
    const adult = res.body.categories.find((c) => c.slug === 'adult');

    assert.strictEqual(kid.fee, 250);
    assert.strictEqual(kid.feePaise, 25000);
    assert.strictEqual(teen.fee, 250);
    assert.strictEqual(teen.feePaise, 25000);
    assert.strictEqual(adult.fee, 250);
    assert.strictEqual(adult.feePaise, 25000);
  });

  await t.test('POST /api/v1/registrations creates registration and orders with authoritative pricing', async () => {
    // Junior (Kid) registration -> ₹250 / 25000 paise
    const kidPayload = {
      fullName: 'Meera Krishnan',
      email: `meera_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`,
      phone: '9876543210',
      category: 'kid',
      dob: '2014-06-15', // Age 12
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Mrs. Krishnan',
      guardianRelationship: 'Mother',
      guardianPhone: '9876543211',
      guardianEmail: 'krishnan.parent@example.com',
      // Attacker tries to pass fake amount
      amount: 10,
      feePaise: 100
    };

    const res = await request(app)
      .post('/api/v1/registrations')
      .send(kidPayload);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.registration.reference.startsWith('SSS-2026-'));
    assert.strictEqual(res.body.registration.status, 'AWAITING_PAYMENT');
    // Verify client-supplied fee was ignored and authoritative fee was applied
    assert.strictEqual(res.body.registration.amountRupees, 250);
    assert.strictEqual(res.body.registration.amountPaise, 25000);
    assert.strictEqual(res.body.order.amount, 25000);
    assert.ok(res.body.order.id);
  });

  await t.test('POST /api/v1/registrations rejects invalid payloads with 400', async () => {
    const res = await request(app)
      .post('/api/v1/registrations')
      .send({ fullName: '' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.details);
  });

  await t.test('GET /api/v1/registrations/:reference/status returns safe registration status', async () => {
    // First create registration
    const regRes = await request(app)
      .post('/api/v1/registrations')
      .send({
        fullName: 'Karthik Raja',
        email: `karthik_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`,
        phone: '9876543210',
        category: 'adult',
        dob: '1998-03-20',
        occupation: 'Working Professional',
        city: 'Salem'
      });

    const ref = regRes.body.registration.reference;
    const statusRes = await request(app).get(`/api/v1/registrations/${ref}/status`);

    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.body.registration.reference, ref);
    assert.strictEqual(statusRes.body.registration.status, 'AWAITING_PAYMENT');
    assert.strictEqual(statusRes.body.registration.amountRupees, 250);
  });

  await t.test('POST /api/v1/registrations rejects registration when deadline has passed', async () => {
    const module = await import('../src/config/event.js');
    const originalDeadline = module.EVENT_CONFIG.deadline;
    module.EVENT_CONFIG.deadline = '2020-01-01T00:00:00Z'; // Past deadline
    
    try {
      const res = await request(app)
        .post('/api/v1/registrations')
        .send({
          fullName: 'Late Comers',
          email: 'late@example.com',
          phone: '9876543210',
          category: 'kid',
          dob: '2014-06-15',
          occupation: 'Student',
          city: 'Salem',
          guardianName: 'Late Parent',
          guardianRelationship: 'Father',
          guardianPhone: '9876543211',
          guardianEmail: 'late.parent@example.com'
        });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, 'DEADLINE_PASSED');
    } finally {
      module.EVENT_CONFIG.deadline = originalDeadline; // restore
    }
  });
});

