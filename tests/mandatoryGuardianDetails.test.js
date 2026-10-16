import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';
import { getRegistrationDetail } from '../src/services/adminQueries.js';

test('Mandatory Parent / Guardian Details Feature Suite', async (t) => {
  await setupTestEnvironment();

  t.after(async () => {
    await teardownTestEnvironment();
  });

  // Base payload factory
  const createJuniorPayload = (overrides = {}) => ({
    fullName: 'Ananya Ramesh',
    email: `ananya_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`,
    phone: '9876543210',
    category: 'kid',
    dob: '2014-06-15', // Age 12 on contest date
    occupation: 'Student',
    city: 'Salem',
    guardianName: 'Ramesh Sundaram',
    guardianRelationship: 'Father',
    guardianPhone: '9876543211',
    guardianEmail: 'ramesh.sundaram@example.com',
    ...overrides
  });

  const createTeenPayload = (overrides = {}) => ({
    fullName: 'Kiran Deep',
    email: `kiran_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`,
    phone: '9876543220',
    category: 'teen',
    dob: '2010-03-20', // Age 16 on contest date
    occupation: 'Student',
    city: 'Salem',
    guardianName: 'Deepak Kumar',
    guardianRelationship: 'Father',
    guardianPhone: '9876543221',
    guardianEmail: 'deepak.kumar@example.com',
    ...overrides
  });

  // Test 1: Junior registration without a guardian name is rejected
  await t.test('1. Junior registration without a guardian name is rejected with 400', async () => {
    const payload = createJuniorPayload({ guardianName: '' });
    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.details?.guardianName, "Please enter the parent/guardian's full name.");
  });

  // Test 2: Junior registration without a guardian relationship is rejected
  await t.test('2. Junior registration without a guardian relationship is rejected with 400', async () => {
    const payload = createJuniorPayload({ guardianRelationship: '' });
    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.details?.guardianRelationship, 'Please select your relationship to the participant.');
  });

  // Test 3: Junior registration without a guardian phone number is rejected
  await t.test('3. Junior registration without a guardian phone number is rejected with 400', async () => {
    const payload = createJuniorPayload({ guardianPhone: '' });
    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.details?.guardianPhone, 'Please enter a valid parent/guardian contact number.');
  });

  // Test 4: Junior registration without a guardian email is rejected
  await t.test('4. Junior registration without a guardian email is rejected with 400', async () => {
    const payload = createJuniorPayload({ guardianEmail: '' });
    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.details?.guardianEmail, 'Please enter a valid parent/guardian email address.');
  });

  // Test 5: Teen registration enforces the same mandatory fields
  await t.test('5. Teen registration enforces the same mandatory fields', async () => {
    const missingNameRes = await request(app)
      .post('/api/v1/applications')
      .send(createTeenPayload({ guardianName: '' }));
    assert.strictEqual(missingNameRes.status, 400);
    assert.ok(missingNameRes.body.details?.guardianName);

    const missingRelRes = await request(app)
      .post('/api/v1/applications')
      .send(createTeenPayload({ guardianRelationship: '' }));
    assert.strictEqual(missingRelRes.status, 400);
    assert.ok(missingRelRes.body.details?.guardianRelationship);

    const missingPhoneRes = await request(app)
      .post('/api/v1/applications')
      .send(createTeenPayload({ guardianPhone: '' }));
    assert.strictEqual(missingPhoneRes.status, 400);
    assert.ok(missingPhoneRes.body.details?.guardianPhone);

    const missingEmailRes = await request(app)
      .post('/api/v1/applications')
      .send(createTeenPayload({ guardianEmail: '' }));
    assert.strictEqual(missingEmailRes.status, 400);
    assert.ok(missingEmailRes.body.details?.guardianEmail);
  });

  // Test 6: Invalid phone numbers and email addresses are rejected
  await t.test('6. Invalid phone numbers and email addresses are rejected with clear messages', async () => {
    const invalidContactRes = await request(app)
      .post('/api/v1/applications')
      .send(createJuniorPayload({
        guardianPhone: '12345', // invalid phone
        guardianEmail: 'not-an-email-at-all' // invalid email
      }));
    assert.strictEqual(invalidContactRes.status, 400);
    assert.strictEqual(invalidContactRes.body.details?.guardianPhone, 'Please enter a valid parent/guardian contact number.');
    assert.strictEqual(invalidContactRes.body.details?.guardianEmail, 'Please enter a valid parent/guardian email address.');
  });

  // Test 7: Whitespace-only values are rejected
  await t.test('7. Whitespace-only values for guardian details are rejected', async () => {
    const whitespaceRes = await request(app)
      .post('/api/v1/applications')
      .send(createJuniorPayload({
        guardianName: '   ',
        guardianRelationship: '   ',
        guardianPhone: '   ',
        guardianEmail: '   '
      }));
    assert.strictEqual(whitespaceRes.status, 400);
    assert.strictEqual(whitespaceRes.body.details?.guardianName, "Please enter the parent/guardian's full name.");
    assert.strictEqual(whitespaceRes.body.details?.guardianRelationship, 'Please select your relationship to the participant.');
    assert.strictEqual(whitespaceRes.body.details?.guardianPhone, 'Please enter a valid parent/guardian contact number.');
    assert.strictEqual(whitespaceRes.body.details?.guardianEmail, 'Please enter a valid parent/guardian email address.');
  });

  // Test 8: Valid guardian details are saved correctly and persisted in DB
  await t.test('8. Valid guardian details are saved correctly in PostgreSQL', async () => {
    const payload = createJuniorPayload({
      guardianName: '  Lakshmi Narayanan  ',
      guardianRelationship: 'Mother',
      guardianPhone: ' +91 98765 43210 ',
      guardianEmail: '  Lakshmi.N@Example.COM  '
    });

    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    const ref = res.body.application.reference;

    // Fetch directly from database
    const saved = await prisma.registration.findUnique({
      where: { reference: ref }
    });

    assert.ok(saved);
    assert.strictEqual(saved.guardianName, 'Lakshmi Narayanan'); // trimmed
    assert.strictEqual(saved.guardianRelationship, 'Mother');
    assert.strictEqual(saved.guardianPhone, '9876543210'); // normalised
    assert.strictEqual(saved.guardianEmail, 'lakshmi.n@example.com'); // trimmed & lowercased
    // Ensure participant's own email and phone were not overwritten
    assert.strictEqual(saved.email, payload.email.trim().toLowerCase());
    assert.strictEqual(saved.phone, '9876543210');
  });

  // Test 9: Direct API requests cannot bypass validation
  await t.test('9. Direct API requests to /api/v1/registrations cannot bypass validation', async () => {
    const directRes = await request(app)
      .post('/api/v1/registrations')
      .send({
        fullName: 'Direct Attacker Kid',
        email: 'attacker@example.com',
        phone: '9876543210',
        category: 'kid',
        dob: '2014-06-15',
        occupation: 'Student',
        city: 'Salem'
        // omitted guardian fields
      });

    assert.strictEqual(directRes.status, 400);
    assert.strictEqual(directRes.body.success, false);
    assert.ok(directRes.body.details?.guardianName);
    assert.ok(directRes.body.details?.guardianRelationship);
    assert.ok(directRes.body.details?.guardianPhone);
    assert.ok(directRes.body.details?.guardianEmail);
  });

  // Test 10: Existing registrations (historical records) remain completely accessible
  await t.test('10. Existing registrations with null guardian fields remain fully accessible', async () => {
    const historicalId = `hist_${Date.now()}`;
    const historicalRef = `SSS-2026-HIST${Math.floor(1000 + Math.random() * 9000)}`;

    // Insert historical registration with null guardian fields
    await prisma.registration.create({
      data: {
        id: historicalId,
        reference: historicalRef,
        categorySlug: 'kid',
        fullName: 'Historical Kid',
        email: 'historical.kid@example.com',
        phone: '9876543210',
        dob: new Date('2014-05-10T00:00:00Z'),
        ageOnContest: 12,
        occupation: 'Student',
        city: 'Salem',
        amountPaise: 25000,
        currency: 'INR',
        status: 'PENDING_REVIEW',
        guardianName: null,
        guardianRelationship: null,
        guardianPhone: null,
        guardianEmail: null
      }
    });

    // Query status endpoint
    const statusRes = await request(app).get(`/api/v1/registrations/${historicalRef}/status`);
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.body.registration.reference, historicalRef);

    // Query admin details
    const adminDetail = await getRegistrationDetail(historicalRef);
    assert.ok(adminDetail);
    assert.strictEqual(adminDetail.reference, historicalRef);
    assert.strictEqual(adminDetail.guardianName, null);
    assert.strictEqual(adminDetail.guardianRelationship, null);
    assert.strictEqual(adminDetail.guardianPhone, null);
    assert.strictEqual(adminDetail.guardianEmail, null);
  });

  // Test 11: Adult registrations follow category-specific rules (guardian info not required)
  await t.test('11. Adult registrations follow category-specific rules without requiring guardian info', async () => {
    const adultPayload = {
      fullName: 'Venkatesh Prasad',
      email: `venkat_${Date.now()}@example.com`,
      phone: '9876543210',
      category: 'adult',
      dob: '1990-08-20', // Age 36 -> Adult
      occupation: 'Working Professional',
      city: 'Salem'
      // No guardian info
    };

    const res = await request(app).post('/api/v1/applications').send(adultPayload);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.application.reference);

    const saved = await prisma.registration.findUnique({
      where: { reference: res.body.application.reference }
    });
    assert.strictEqual(saved.guardianName, null);
    assert.strictEqual(saved.guardianRelationship, null);
    assert.strictEqual(saved.guardianPhone, null);
    assert.strictEqual(saved.guardianEmail, null);
  });

  // Test 12: Admin details query returns all 4 parent/guardian fields correctly
  await t.test('12. Admin details query includes all 4 parent/guardian fields', async () => {
    const payload = createTeenPayload({
      guardianName: 'Saraswathi Natarajan',
      guardianRelationship: 'Mother',
      guardianPhone: '9876543299',
      guardianEmail: 'saraswathi.n@example.com'
    });

    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 201);
    const ref = res.body.application.reference;

    const adminData = await getRegistrationDetail(ref);
    assert.ok(adminData);
    assert.strictEqual(adminData.guardianName, 'Saraswathi Natarajan');
    assert.strictEqual(adminData.guardianRelationship, 'Mother');
    assert.strictEqual(adminData.guardianPhone, '9876543299');
    assert.strictEqual(adminData.guardianEmail, 'saraswathi.n@example.com');
  });

  // Test 13: Long guardian email addresses are stored and handled cleanly
  await t.test('13. Long guardian email address is stored and retrieved properly', async () => {
    const longEmail = `very.long.guardian.email.address.for.testing.ui.wrapping.${Date.now()}@subdomain.example-domain.com`;
    const payload = createJuniorPayload({
      guardianEmail: longEmail
    });

    const res = await request(app).post('/api/v1/applications').send(payload);
    assert.strictEqual(res.status, 201);
    const ref = res.body.application.reference;

    const saved = await prisma.registration.findUnique({ where: { reference: ref } });
    assert.strictEqual(saved.guardianEmail, longEmail.toLowerCase());
  });

  // Test 14: Failed validation does not create application or send emails
  await t.test('14. Rejected registration payload does not persist to DB', async () => {
    const countBefore = await prisma.registration.count();
    const badPayload = createJuniorPayload({ guardianName: '' });

    const res = await request(app).post('/api/v1/applications').send(badPayload);
    assert.strictEqual(res.status, 400);

    const countAfter = await prisma.registration.count();
    assert.strictEqual(countAfter, countBefore, 'Database count must not increase on validation failure');
  });
});
