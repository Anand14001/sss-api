import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { setTransporter } from '../src/services/email.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

const ADMIN_EMAIL = 'admin_multi_reg@example.invalid';
const ADMIN_PASSWORD = 'MultiRegAdmin@2026!';

function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

test('Allow Multiple Registrations Using The Same Email Address', async (t) => {
  await setupTestEnvironment();

  // Track dispatched emails
  const sentEmails = [];
  setTransporter({
    sendMail: async (options) => {
      sentEmails.push(options);
      return { messageId: `msg_${Date.now()}_${Math.random()}` };
    }
  });

  // Setup admin user for dashboard testing
  await prisma.adminSession.deleteMany({
    where: { adminUser: { email: ADMIN_EMAIL } }
  });
  await prisma.adminUser.deleteMany({
    where: { email: ADMIN_EMAIL }
  });

  const admin = await prisma.adminUser.create({
    data: {
      email: ADMIN_EMAIL,
      name: 'Multi Reg Admin',
      role: 'SUPER_ADMIN',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      mustChangePassword: false,
      isActive: true
    }
  });

  let adminSessionCookie, adminCsrfToken;

  const loginRes = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(loginRes.status, 200);
  adminSessionCookie = cookieValue(loginRes.headers['set-cookie'], 'sss_admin_session');
  adminCsrfToken = cookieValue(loginRes.headers['set-cookie'], 'sss_admin_csrf');

  t.after(async () => {
    await prisma.adminSession.deleteMany({
      where: { adminUser: { email: ADMIN_EMAIL } }
    });
    await prisma.adminUser.deleteMany({
      where: { email: ADMIN_EMAIL }
    });
    await teardownTestEnvironment();
  });

  const parentEmail = `parent_${Date.now()}_test@example.com`;
  let refA, refB, idA, idB;

  // 1 & 2 & 3: Register participant A and participant B with same email address
  await t.test('1, 2, 3: Register participant A and B with parent@example.com, both succeed with unique references', async () => {
    // 1. Register Participant A (Kid category)
    const resA = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Aarav Sharma',
        email: parentEmail,
        phone: '9876543210',
        dob: '2014-06-15', // Age 12 - Kid
        category: 'kid',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Rajesh Sharma',
        guardianRelationship: 'Father',
        guardianPhone: '9876543210',
        guardianEmail: parentEmail
      });

    assert.equal(resA.status, 201, 'Participant A application must succeed');
    assert.equal(resA.body.success, true);
    assert.ok(resA.body.application.reference, 'Must have reference');
    refA = resA.body.application.reference;
    idA = resA.body.application.id;
    assert.equal(resA.body.application.email, parentEmail);
    assert.equal(resA.body.application.fullName, 'Aarav Sharma');

    // 2. Register Participant B (Teen category) using the EXACT same email address
    const resB = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Diya Sharma',
        email: parentEmail, // SAME email address
        phone: '9876543210',
        dob: '2010-04-12', // Age 16 - Teen
        category: 'teen',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Rajesh Sharma',
        guardianRelationship: 'Father',
        guardianPhone: '9876543210',
        guardianEmail: parentEmail
      });

    assert.equal(resB.status, 201, 'Participant B application with same email must succeed');
    assert.equal(resB.body.success, true);
    assert.ok(resB.body.application.reference, 'Must have reference');
    refB = resB.body.application.reference;
    idB = resB.body.application.id;
    assert.equal(resB.body.application.email, parentEmail);
    assert.equal(resB.body.application.fullName, 'Diya Sharma');

    // 3. Confirm both registrations receive different application references and IDs
    assert.notEqual(refA, refB, 'Participant A and B must receive distinct reference numbers');
    assert.notEqual(idA, idB, 'Participant A and B must receive distinct IDs');
  });

  // 4: Confirm both records exist independently in PostgreSQL
  await t.test('4: Confirm both records exist independently in PostgreSQL', async () => {
    const records = await prisma.registration.findMany({
      where: { email: parentEmail }
    });

    assert.equal(records.length, 2, 'Must have exactly 2 independent records in PostgreSQL for the same email');

    const recA = records.find((r) => r.reference === refA);
    const recB = records.find((r) => r.reference === refB);

    assert.ok(recA, 'Record A must exist');
    assert.ok(recB, 'Record B must exist');
    assert.equal(recA.fullName, 'Aarav Sharma');
    assert.equal(recB.fullName, 'Diya Sharma');
    assert.equal(recA.categorySlug, 'kid');
    assert.equal(recB.categorySlug, 'teen');
    assert.equal(recA.id, idA);
    assert.equal(recB.id, idB);
  });

  // 5: Confirm both applications appear separately in the admin dashboard
  await t.test('5: Confirm both applications appear separately in admin dashboard search and listings', async () => {
    const listRes = await request(app)
      .get(`/api/v1/admin/registrations?q=${encodeURIComponent(parentEmail)}`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`]);

    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.success, true);

    const items = listRes.body.items.filter((item) => item.email === parentEmail);
    assert.equal(items.length, 2, 'Dashboard search by email must return both separate application records');

    const itemA = items.find((i) => i.reference === refA);
    const itemB = items.find((i) => i.reference === refB);

    assert.ok(itemA, 'Dashboard item A exists');
    assert.ok(itemB, 'Dashboard item B exists');
    assert.equal(itemA.fullName, 'Aarav Sharma');
    assert.equal(itemB.fullName, 'Diya Sharma');
    assert.equal(itemA.category, 'kid');
    assert.equal(itemB.category, 'teen');

    // Also check CSV export preserves both rows
    const csvRes = await request(app)
      .get('/api/v1/admin/reports/registrations/export')
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`]);

    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.text.includes(refA), 'CSV export must include reference A');
    assert.ok(csvRes.text.includes(refB), 'CSV export must include reference B');
  });

  // 6: Confirm each application has its own status and shortlisting/payment workflow
  await t.test('6: Confirm each application has its own status and shortlisting/payment workflow', async () => {
    // Shortlist Participant A only
    const shortlistResA = await request(app)
      .post(`/api/v1/admin/registrations/${refA}/shortlist`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ notes: 'Strong speaker in junior division' });

    assert.equal(shortlistResA.status, 200);

    // Reject Participant B only
    const rejectResB = await request(app)
      .post(`/api/v1/admin/registrations/${refB}/reject`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ reason: 'Incomplete speech submission video' });

    assert.equal(rejectResB.status, 200);

    // Check Participant A status: SHORTLISTED
    const statusA = await request(app).get(`/api/v1/registrations/${refA}/status`);
    assert.equal(statusA.status, 200);
    assert.equal(statusA.body.registration.status, 'SHORTLISTED');
    assert.equal(statusA.body.registration.reviewDecision, 'SHORTLISTED');

    // Check Participant B status: REJECTED
    const statusB = await request(app).get(`/api/v1/registrations/${refB}/status`);
    assert.equal(statusB.status, 200);
    assert.equal(statusB.body.registration.status, 'REJECTED');
    assert.equal(statusB.body.registration.reviewDecision, 'REJECTED');

    // Send payment link for Participant A
    const inviteRes = await request(app)
      .post(`/api/v1/admin/registrations/${refA}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ expiryDays: 5 });

    assert.equal(inviteRes.status, 200);
    assert.ok(inviteRes.body.invitation?.token, 'Must return invitation token');
    const tokenA = inviteRes.body.invitation.token;

    // Verify invitation endpoint works for Participant A
    const getInviteRes = await request(app).get(`/api/v1/invitations/${tokenA}`);
    assert.equal(getInviteRes.status, 200);
    assert.equal(getInviteRes.body.invitation.reference, refA);
    assert.equal(getInviteRes.body.invitation.fullName, 'Aarav Sharma');
    assert.equal(getInviteRes.body.invitation.email, parentEmail);
  });

  // 7: Confirm each successful application triggers its own acknowledgement email
  await t.test('7: Confirm each successful application triggers its own acknowledgement email', async () => {
    // Wait briefly for asynchronous email dispatches
    await new Promise((r) => setTimeout(r, 400));

    // Check sentEmails
    const emailsToParent = sentEmails.filter((m) => m.to === parentEmail);
    assert.ok(emailsToParent.length >= 2, 'Parent email must have received acknowledgement for each participant');

    const emailForA = emailsToParent.find((m) => m.text?.includes(refA) || m.html?.includes(refA));
    const emailForB = emailsToParent.find((m) => m.text?.includes(refB) || m.html?.includes(refB));

    assert.ok(emailForA, 'Must receive acknowledgement email containing reference A');
    assert.ok(emailForB, 'Must receive acknowledgement email containing reference B');
    assert.ok(emailForA.text.includes('Aarav Sharma'), 'Email for A mentions Aarav Sharma');
    assert.ok(emailForB.text.includes('Diya Sharma'), 'Email for B mentions Diya Sharma');

    // Verify EmailDelivery table has separate rows
    const deliveries = await prisma.emailDelivery.findMany({
      where: { recipientEmail: parentEmail, emailType: 'REGISTRATION_ACKNOWLEDGEMENT' }
    });
    assert.equal(deliveries.length, 2, 'Two separate EmailDelivery records must exist in PostgreSQL');
    assert.ok(deliveries.some((d) => d.registrationReference === refA));
    assert.ok(deliveries.some((d) => d.registrationReference === refB));
  });

  // 8: Confirm an accidental retry of the same submission does not create a duplicate application
  await t.test('8: Confirm an accidental retry of the same submission does not create a duplicate application', async () => {
    const countBefore = await prisma.registration.count({
      where: { email: parentEmail }
    });
    assert.equal(countBefore, 2);

    // Accidental retry of Participant A submission with exact same payload
    const retryPayload = {
      fullName: 'Aarav Sharma',
      email: parentEmail,
      phone: '9876543210',
      dob: '2014-06-15',
      category: 'kid',
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: '9876543210',
      guardianEmail: parentEmail
    };

    const retryRes = await request(app)
      .post('/api/v1/applications')
      .send(retryPayload);

    assert.equal(retryRes.status, 201);
    assert.equal(retryRes.body.success, true);
    // Must return the existing application reference, not create a new one
    assert.equal(retryRes.body.application.reference, refA, 'Retry must return existing application reference');

    const countAfter = await prisma.registration.count({
      where: { email: parentEmail }
    });
    assert.equal(countAfter, 2, 'No duplicate record should be created on accidental retry');

    // Test explicit idempotency key header
    const explicitKey = `test-key-${Date.now()}`;
    const explicitPayload = {
      fullName: 'Sibling Three',
      email: parentEmail,
      phone: '9876543210',
      dob: '2015-08-10',
      category: 'kid',
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: '9876543210',
      guardianEmail: parentEmail
    };

    const firstCall = await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', explicitKey)
      .send(explicitPayload);

    assert.equal(firstCall.status, 201);
    const refC = firstCall.body.application.reference;

    // Retry with same Idempotency-Key
    const secondCall = await request(app)
      .post('/api/v1/applications')
      .set('Idempotency-Key', explicitKey)
      .send(explicitPayload);

    assert.equal(secondCall.status, 201);
    assert.equal(secondCall.body.application.reference, refC, 'Idempotent retry returns same reference');

    const countAfterExplicit = await prisma.registration.count({
      where: { reference: refC }
    });
    assert.equal(countAfterExplicit, 1, 'Only one record exists in DB for explicit key');
  });

  // 9: Confirm admin account email uniqueness remains enforced
  await t.test('9: Confirm admin account email uniqueness remains enforced', async () => {
    // Attempting to create an AdminUser with duplicate email should be rejected
    let failed = false;
    try {
      await prisma.adminUser.create({
        data: {
          email: ADMIN_EMAIL, // already exists
          name: 'Imposter Admin',
          role: 'ADMIN',
          passwordHash: 'dummyhash',
          mustChangePassword: false,
          isActive: true
        }
      });
    } catch (err) {
      failed = true;
      assert.equal(err.code, 'P2002', 'Prisma unique constraint P2002 must be thrown for duplicate admin email');
    }
    assert.equal(failed, true, 'AdminUser creation with duplicate email must fail');

    // Also test via Admin API endpoint POST /api/v1/admin/users
    const apiRes = await request(app)
      .post('/api/v1/admin/users')
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({
        email: ADMIN_EMAIL,
        name: 'Another Duplicate',
        role: 'ADMIN',
        password: 'SomePassword@123!'
      });

    assert.equal(apiRes.status, 409, 'Admin user API must return 409 Conflict on duplicate email');
    assert.equal(apiRes.body.code, 'EMAIL_ALREADY_EXISTS');
  });

  // 10: Confirm existing registration records remain intact after migration
  await t.test('10: Confirm existing registration records remain intact after migration', async () => {
    const totalCount = await prisma.registration.count();
    assert.ok(totalCount >= 246, `Expected at least 246 registration records, got ${totalCount}`);

    // Verify a random existing registration can be read and retains all required properties
    const sample = await prisma.registration.findFirst({
      where: { status: { in: ['PAID', 'PENDING_REVIEW', 'AWAITING_PAYMENT'] } }
    });
    assert.ok(sample, 'Sample registration must exist');
    assert.ok(sample.id, 'Sample has id');
    assert.ok(sample.reference, 'Sample has reference');
    assert.ok(sample.email, 'Sample has email');
    assert.ok(sample.categorySlug, 'Sample has categorySlug');
    assert.ok(sample.fullName, 'Sample has fullName');
  });
});
