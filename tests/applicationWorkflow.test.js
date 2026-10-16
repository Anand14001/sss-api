import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

const ADMIN_EMAIL = 'workflow-admin@example.invalid';
const ADMIN_PASSWORD = 'WorkflowAdmin@2026!';
const SUPERADMIN_EMAIL = 'workflow-super@example.invalid';
const SUPERADMIN_PASSWORD = 'WorkflowSuper@2026!';

function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

test('Salem Star Speaker — Application, Shortlisting & Payment Workflow', async (t) => {
  await setupTestEnvironment();

  // Cleanup test users
  await prisma.adminSession.deleteMany({
    where: { adminUser: { email: { in: [ADMIN_EMAIL, SUPERADMIN_EMAIL] } } }
  });
  await prisma.auditLog.deleteMany({
    where: { actorEmail: { in: [ADMIN_EMAIL, SUPERADMIN_EMAIL] } }
  });
  await prisma.adminUser.deleteMany({
    where: { email: { in: [ADMIN_EMAIL, SUPERADMIN_EMAIL] } }
  });

  // Create test admin and super admin
  const adminUser = await prisma.adminUser.create({
    data: {
      email: ADMIN_EMAIL,
      name: 'Workflow Regular Admin',
      role: 'ADMIN',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      mustChangePassword: false,
      isActive: true
    }
  });

  const superAdminUser = await prisma.adminUser.create({
    data: {
      email: SUPERADMIN_EMAIL,
      name: 'Workflow Super Admin',
      role: 'SUPER_ADMIN',
      passwordHash: await hashPassword(SUPERADMIN_PASSWORD),
      mustChangePassword: false,
      isActive: true
    }
  });

  t.after(async () => {
    await prisma.adminSession.deleteMany({
      where: { adminUser: { email: { in: [ADMIN_EMAIL, SUPERADMIN_EMAIL] } } }
    });
    await prisma.auditLog.deleteMany({
      where: { actorEmail: { in: [ADMIN_EMAIL, SUPERADMIN_EMAIL] } }
    });
    await prisma.adminUser.deleteMany({
      where: { email: { in: [ADMIN_EMAIL, SUPERADMIN_EMAIL] } }
    });
    await teardownTestEnvironment();
  });

  let adminSessionCookie, adminCsrfToken;
  let superSessionCookie, superCsrfToken;

  // 1. Admin login
  await t.test('Admin and SuperAdmin can login', async () => {
    const resAdmin = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    assert.strictEqual(resAdmin.status, 200);
    adminSessionCookie = cookieValue(resAdmin.headers['set-cookie'], 'sss_admin_session');
    adminCsrfToken = cookieValue(resAdmin.headers['set-cookie'], 'sss_admin_csrf');

    const resSuper = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD });
    assert.strictEqual(resSuper.status, 200);
    superSessionCookie = cookieValue(resSuper.headers['set-cookie'], 'sss_admin_session');
    superCsrfToken = cookieValue(resSuper.headers['set-cookie'], 'sss_admin_csrf');
  });

  let kidRef, teenRef, adultRef;

  // 2. Application Submission (All 3 Categories without payment)
  await t.test('POST /api/v1/applications submits application without upfront payment', async () => {
    // Kid (10-13)
    const kidRes = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Arun Kid',
        email: `arun_${Date.now()}@example.com`,
        phone: '9876543211',
        category: 'kid',
        dob: '2014-05-10',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Ravi Parent',
        guardianRelationship: 'Father',
        guardianPhone: '9876543212',
        guardianEmail: 'ravi.parent@example.com'
      });

    assert.strictEqual(kidRes.status, 201);
    assert.strictEqual(kidRes.body.success, true);
    assert.ok(kidRes.body.application.reference);
    assert.strictEqual(kidRes.body.application.status, 'PENDING_REVIEW');
    assert.strictEqual(kidRes.body.order, null, 'No Razorpay order should be created upon application submission');
    assert.strictEqual(kidRes.body.paymentRequired, false);
    kidRef = kidRes.body.application.reference;

    // Teen (14-17)
    const teenRes = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Priya Teen',
        email: `priya_${Date.now()}@example.com`,
        phone: '9876543213',
        category: 'teen',
        dob: '2010-02-15',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Sundar Parent',
        guardianRelationship: 'Father',
        guardianPhone: '9876543214',
        guardianEmail: 'sundar.parent@example.com'
      });

    assert.strictEqual(teenRes.status, 201);
    assert.strictEqual(teenRes.body.success, true);
    assert.strictEqual(teenRes.body.application.status, 'PENDING_REVIEW');
    assert.strictEqual(teenRes.body.order, null);
    teenRef = teenRes.body.application.reference;

    // Adult (18+)
    const adultRes = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Karthik Adult',
        email: `karthik_${Date.now()}@example.com`,
        phone: '9876543215',
        category: 'adult',
        dob: '1995-08-20',
        occupation: 'Working Professional',
        city: 'Salem'
      });

    assert.strictEqual(adultRes.status, 201);
    assert.strictEqual(adultRes.body.success, true);
    assert.strictEqual(adultRes.body.application.status, 'PENDING_REVIEW');
    assert.strictEqual(adultRes.body.order, null);
    adultRef = adultRes.body.application.reference;
  });

  // 3. Validation and duplicate submission prevention
  await t.test('Enforces age validation and required fields on application submission', async () => {
    // Junior age mismatch (e.g. 19 years old applying for kid category)
    const invalidAgeRes = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Wrong Age Applicant',
        email: `wrong_age_${Date.now()}@example.com`,
        phone: '9876543216',
        category: 'kid',
        dob: '2005-01-01', // Age 21
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Parent',
        guardianRelationship: 'Mother',
        guardianPhone: '9876543212',
        guardianEmail: 'parent@example.com'
      });

    assert.strictEqual(invalidAgeRes.status, 400);

    // Missing required field (fullName)
    const missingFieldRes = await request(app)
      .post('/api/v1/applications')
      .send({
        email: `nofullname_${Date.now()}@example.com`,
        phone: '9876543217',
        category: 'kid',
        dob: '2014-05-10',
        occupation: 'Student',
        city: 'Salem'
      });

    assert.strictEqual(missingFieldRes.status, 400);
  });

  // 4. Admin Shortlisting & Audit History
  await t.test('Admin can shortlist an applicant with notes', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/registrations/${kidRef}/shortlist`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ notes: 'Strong application and speaking topic.' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.registration.reviewDecision, 'SHORTLISTED');
    assert.strictEqual(res.body.registration.status, 'SHORTLISTED');

    // Verify audit log entry
    const audit = await prisma.auditLog.findFirst({
      where: {
        entityId: kidRef,
        action: 'application.shortlisted'
      }
    });
    assert.ok(audit, 'Audit log must record application.shortlisted');
    assert.strictEqual(audit.actorEmail, ADMIN_EMAIL);
  });

  // 5. Admin Rejection
  await t.test('Admin can reject an applicant with notes', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/registrations/${teenRef}/reject`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ reason: 'Does not meet category eligibility requirements.' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.registration.reviewDecision, 'REJECTED');
    assert.strictEqual(res.body.registration.status, 'REJECTED');

    // Verify audit log entry
    const audit = await prisma.auditLog.findFirst({
      where: {
        entityId: teenRef,
        action: 'application.rejected'
      }
    });
    assert.ok(audit, 'Audit log must record application.rejected');
  });

  // 6. Rejected applicants cannot receive payment links
  await t.test('Rejected applicant cannot receive a payment link', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/registrations/${teenRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({});

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.code === 'APPLICANT_REJECTED' || res.body.code === 'INVALID_DECISION_FOR_PAYMENT');
  });

  // 7. Non-shortlisted applicants cannot receive payment links
  await t.test('Pending review applicant cannot receive a payment link before shortlisting', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/registrations/${adultRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({});

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.code === 'NOT_SHORTLISTED' || res.body.code === 'INVALID_DECISION_FOR_PAYMENT');
  });

  let invitationToken;

  // 8. Send Payment Link for Shortlisted Applicant
  await t.test('Send payment link generates invitation token and authoritative fee', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/registrations/${kidRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ expiryDays: 5 });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.invitation.amountPaise > 0);
    assert.strictEqual(res.body.invitation.amountPaise, 25000, 'Authoritative fee ₹250 for Junior category');
    assert.ok(res.body.invitation.status === 'SENT' || res.body.invitation.deliveryStatus === 'SENT');
    invitationToken = res.body.invitation.token;

    // Idempotency: Repeating send payment link reuses existing valid invitation without duplicating
    const repeatRes = await request(app)
      .post(`/api/v1/admin/registrations/${kidRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({});

    assert.strictEqual(repeatRes.status, 200);
    assert.strictEqual(repeatRes.body.invitation.token, invitationToken, 'Must reuse valid active invitation token');

    const invitations = await prisma.paymentInvitation.findMany({
      where: { registrationReference: kidRef }
    });
    assert.strictEqual(invitations.length, 1, 'Only one active invitation should exist');
  });

  // 9. Public Participant Payment Page API
  await t.test('GET /api/v1/invitations/:token returns participant payment details safely', async () => {
    const res = await request(app).get(`/api/v1/invitations/${invitationToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.invitation.reference, kidRef);
    assert.strictEqual(res.body.invitation.fullName, 'Arun Kid');
    assert.strictEqual(res.body.invitation.categoryName, 'Kids');
    assert.strictEqual(res.body.invitation.amountRupees, 250);
    assert.strictEqual(res.body.invitation.payable, true);

    // Invalid token returns 404
    const invalidRes = await request(app).get('/api/v1/invitations/invalid-fake-token-123');
    assert.strictEqual(invalidRes.status, 404);
  });

  // 10. Create Checkout Order for Invitation
  let checkoutOrderId;
  await t.test('POST /api/v1/invitations/:token/checkout creates Razorpay checkout order', async () => {
    const res = await request(app).post(`/api/v1/invitations/${invitationToken}/checkout`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.order.id);
    assert.strictEqual(res.body.order.amount, 25000);
    checkoutOrderId = res.body.order.id;
  });

  // 11. Payment Verification transitions application to CONFIRMED
  await t.test('Payment verification marks application CONFIRMED and invitation PAID', async () => {
    const crypto = await import('node:crypto');
    const secret = process.env.RAZORPAY_KEY_SECRET || 'test_secret_12345';
    const paymentId = `pay_workflow_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const signature = crypto.default
      .createHmac('sha256', secret)
      .update(`${checkoutOrderId}|${paymentId}`)
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/payments/verify')
      .send({
        razorpay_order_id: checkoutOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        invitationToken
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.registration.status, 'CONFIRMED');

    // Verify DB state
    const reg = await prisma.registration.findUnique({ where: { reference: kidRef } });
    assert.strictEqual(reg.status, 'CONFIRMED');

    const inv = await prisma.paymentInvitation.findUnique({ where: { token: invitationToken } });
    assert.strictEqual(inv.status, 'PAID');

    // Confirm that already-paid application refuses new payment links
    const attemptSendAgain = await request(app)
      .post(`/api/v1/admin/registrations/${kidRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({});
    assert.strictEqual(attemptSendAgain.status, 400);
    assert.strictEqual(attemptSendAgain.body.code, 'ALREADY_PAID');
  });

  // 12. Security & RBAC: Regular ADMIN cannot delete users or change roles
  await t.test('RBAC: ADMIN role cannot delete users or change roles; SUPER_ADMIN can', async () => {
    // ADMIN attempts to change role
    const adminChangeRoleRes = await request(app)
      .patch(`/api/v1/admin/users/${adminUser.id}/role`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ role: 'SUPER_ADMIN' });
    assert.strictEqual(adminChangeRoleRes.status, 403, 'ADMIN must be forbidden from changing user roles');

    // ADMIN attempts to delete user
    const adminDeleteRes = await request(app)
      .delete(`/api/v1/admin/users/${adminUser.id}`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken);
    assert.strictEqual(adminDeleteRes.status, 403, 'ADMIN must be forbidden from deleting users');

    // SUPER_ADMIN can change role
    const superChangeRoleRes = await request(app)
      .patch(`/api/v1/admin/users/${adminUser.id}/role`)
      .set('Cookie', [`sss_admin_session=${superSessionCookie}`])
      .set('x-csrf-token', superCsrfToken)
      .send({ role: 'ADMIN' });
    assert.strictEqual(superChangeRoleRes.status, 200, 'SUPER_ADMIN should be permitted to manage roles');
  });
});
