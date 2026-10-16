import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import {
  checkPaymentInvitationEligibility,
  previewBulkPaymentInvitationsAction,
  sendBulkPaymentInvitationsAction,
  sendPaymentInvitationAction
} from '../src/services/adminActions.js';
import { setTransporter } from '../src/services/email.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

const TEST_ADMIN_EMAIL = 'bulk-test-admin@salemstarspeaker.test';
const TEST_ADMIN_PASSWORD = 'BulkAdminPassword@2026!';

function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

async function removeTestAdmin() {
  const existing = await prisma.adminUser.findUnique({ where: { email: TEST_ADMIN_EMAIL } });
  if (!existing) return;
  await prisma.auditLog.deleteMany({ where: { actorEmail: TEST_ADMIN_EMAIL } });
  await prisma.adminSession.deleteMany({ where: { adminUserId: existing.id } });
  await prisma.adminUser.delete({ where: { id: existing.id } });
}

test('Salem Star Speaker — Bulk Payment Link Sending Feature', async (t) => {
  await setupTestEnvironment();
  await removeTestAdmin();

  await prisma.adminUser.create({
    data: {
      email: TEST_ADMIN_EMAIL,
      name: 'Bulk Test Admin',
      passwordHash: await hashPassword(TEST_ADMIN_PASSWORD),
      role: 'ADMIN',
      mustChangePassword: false,
      isActive: true
    }
  });

  t.after(async () => {
    await removeTestAdmin();
    await teardownTestEnvironment();
  });

  let sessionCookie;
  let csrfToken;

  await t.test('Setup admin session', async () => {
    const loginRes = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers['set-cookie'];
    sessionCookie = cookieValue(setCookie, 'sss_admin_session');
    csrfToken = loginRes.body.csrfToken || cookieValue(setCookie, 'sss_admin_csrf');
    assert.ok(sessionCookie);
    assert.ok(csrfToken);
  });

  // Mock email transporter
  const sentEmails = [];
  setTransporter({
    sendMail: async (options) => {
      sentEmails.push(options);
      return { messageId: `bulk-msg-${Date.now()}-${Math.random()}` };
    }
  });

  const mockAdmin = {
    id: 'test-admin-bulk-id',
    email: 'admin@salemstarspeaker.test',
    role: 'ADMIN'
  };

  // ------------------------------------------------------------- Unit Eligibility Tests
  await t.test('1. checkPaymentInvitationEligibility validates business rules accurately', () => {
    // 1A. Eligible shortlisted applicant
    const eligibleApplicant = {
      reference: 'SSS-ELIGIBLE-1',
      status: 'SHORTLISTED',
      reviewDecision: 'SHORTLISTED',
      email: 'speaker1@example.invalid'
    };
    const resEligible = checkPaymentInvitationEligibility(eligibleApplicant);
    assert.equal(resEligible.eligible, true);
    assert.equal(resEligible.code, 'ELIGIBLE');

    // 1B. Pending review (unshortlisted) -> Ineligible
    const pendingApplicant = {
      reference: 'SSS-PENDING-1',
      status: 'PENDING_REVIEW',
      reviewDecision: null,
      email: 'speaker2@example.invalid'
    };
    const resPending = checkPaymentInvitationEligibility(pendingApplicant);
    assert.equal(resPending.eligible, false);
    assert.equal(resPending.code, 'NOT_SHORTLISTED');
    assert.ok(resPending.reason.includes('must be shortlisted'));

    // 1C. Rejected -> Ineligible
    const rejectedApplicant = {
      reference: 'SSS-REJ-1',
      status: 'REJECTED',
      reviewDecision: 'REJECTED',
      email: 'speaker3@example.invalid'
    };
    const resRejected = checkPaymentInvitationEligibility(rejectedApplicant);
    assert.equal(resRejected.eligible, false);
    assert.equal(resRejected.code, 'APPLICANT_REJECTED');

    // 1D. Already paid / confirmed -> Ineligible
    const paidApplicant = {
      reference: 'SSS-PAID-1',
      status: 'PAID',
      isConfirmed: true,
      email: 'speaker4@example.invalid'
    };
    const resPaid = checkPaymentInvitationEligibility(paidApplicant);
    assert.equal(resPaid.eligible, false);
    assert.equal(resPaid.code, 'ALREADY_PAID');

    // 1E. Invalid email -> Ineligible
    const badEmailApplicant = {
      reference: 'SSS-BADEMAIL-1',
      status: 'SHORTLISTED',
      reviewDecision: 'SHORTLISTED',
      email: 'not-an-email'
    };
    const resBadEmail = checkPaymentInvitationEligibility(badEmailApplicant);
    assert.equal(resBadEmail.eligible, false);
    assert.equal(resBadEmail.code, 'INVALID_EMAIL');
  });

  // ------------------------------------------------------------- Seed Test Registrations
  let refShortlisted1;
  let refShortlisted2;
  let refPendingReview;
  let refRejected;
  let refPaid;

  await t.test('2. Seed diverse registrations for bulk testing', async () => {
    // Shortlisted Kids (fee ₹99)
    const r1 = await prisma.registration.create({
      data: {
        reference: `SSS-BLK-KID-${Date.now()}`,
        fullName: 'Aarav Kids Eligible',
        email: `kid-${Date.now()}@example.invalid`,
        phone: '9876543001',
        dob: new Date('2014-06-15'),
        ageOnContest: 12,
        categorySlug: 'kid',
        occupation: 'Student',
        city: 'Salem',
        status: 'SHORTLISTED',
        reviewDecision: 'SHORTLISTED',
        amountPaise: 9900
      }
    });
    refShortlisted1 = r1.reference;

    // Shortlisted Teens (fee ₹199)
    const r2 = await prisma.registration.create({
      data: {
        reference: `SSS-BLK-TEEN-${Date.now()}`,
        fullName: 'Bhavna Teens Eligible',
        email: `teen-${Date.now()}@example.invalid`,
        phone: '9876543002',
        dob: new Date('2010-04-10'),
        ageOnContest: 16,
        categorySlug: 'teen',
        occupation: 'Student',
        city: 'Salem',
        status: 'SHORTLISTED',
        reviewDecision: 'SHORTLISTED',
        amountPaise: 19900
      }
    });
    refShortlisted2 = r2.reference;

    // Pending Review Adults (unshortlisted)
    const r3 = await prisma.registration.create({
      data: {
        reference: `SSS-BLK-PEND-${Date.now()}`,
        fullName: 'Chirag Pending Review',
        email: `adult-pending-${Date.now()}@example.invalid`,
        phone: '9876543003',
        dob: new Date('1995-01-20'),
        ageOnContest: 31,
        categorySlug: 'adult',
        occupation: 'Working Professional',
        city: 'Salem',
        status: 'PENDING_REVIEW',
        reviewDecision: null,
        amountPaise: 29900
      }
    });
    refPendingReview = r3.reference;

    // Rejected Applicant
    const r4 = await prisma.registration.create({
      data: {
        reference: `SSS-BLK-REJ-${Date.now()}`,
        fullName: 'Deepa Rejected',
        email: `rejected-${Date.now()}@example.invalid`,
        phone: '9876543004',
        dob: new Date('1998-02-14'),
        ageOnContest: 28,
        categorySlug: 'adult',
        occupation: 'Working Professional',
        city: 'Salem',
        status: 'REJECTED',
        reviewDecision: 'REJECTED',
        amountPaise: 29900
      }
    });
    refRejected = r4.reference;

    // Confirmed / Paid Applicant
    const r5 = await prisma.registration.create({
      data: {
        reference: `SSS-BLK-PAID-${Date.now()}`,
        fullName: 'Eshwar Already Paid',
        email: `paid-${Date.now()}@example.invalid`,
        phone: '9876543005',
        dob: new Date('2015-08-11'),
        ageOnContest: 11,
        categorySlug: 'kid',
        occupation: 'Student',
        city: 'Salem',
        status: 'CONFIRMED',
        amountPaise: 9900
      }
    });
    refPaid = r5.reference;
  });

  // ------------------------------------------------------------- Preview Endpoint Tests
  await t.test('3. POST /api/v1/admin/registrations/bulk-preview verifies eligibility & authoritative fee', async () => {
    const res = await request(app)
      .post('/api/v1/admin/registrations/bulk-preview')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({
        references: [refShortlisted1, refShortlisted2, refPendingReview, refRejected, refPaid]
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.eligibleCount, 2);
    assert.equal(res.body.ineligibleCount, 3);

    const kidItem = res.body.items.find((i) => i.reference === refShortlisted1);
    assert.ok(kidItem);
    assert.equal(kidItem.eligible, true);
    assert.equal(kidItem.amountPaise, 25000);
    assert.equal(kidItem.amountRupees, 250);

    const pendingItem = res.body.items.find((i) => i.reference === refPendingReview);
    assert.ok(pendingItem);
    assert.equal(pendingItem.eligible, false);
    assert.ok(pendingItem.reason.includes('shortlisted'));

    const rejectedItem = res.body.items.find((i) => i.reference === refRejected);
    assert.ok(rejectedItem);
    assert.equal(rejectedItem.eligible, false);

    const paidItem = res.body.items.find((i) => i.reference === refPaid);
    assert.ok(paidItem);
    assert.equal(paidItem.eligible, false);
  });

  // ------------------------------------------------------------- Bulk Send Execution Tests
  await t.test('4. POST /api/v1/admin/registrations/bulk-send-payment-links executes independent processing', async () => {
    const res = await request(app)
      .post('/api/v1/admin/registrations/bulk-send-payment-links')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({
        references: [refShortlisted1, refShortlisted2, refPendingReview, refRejected, refPaid],
        expiryDays: 7
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.summary.total, 5);
    assert.equal(res.body.summary.sent, 2, '2 eligible shortlisted applicants should succeed');
    assert.equal(res.body.summary.skipped, 3, '3 ineligible applicants should be skipped safely');
    assert.equal(res.body.summary.failed, 0);

    // Verify registration status transitions to PAYMENT_PENDING in DB
    const updatedR1 = await prisma.registration.findUnique({ where: { reference: refShortlisted1 } });
    assert.equal(updatedR1.status, 'PAYMENT_PENDING');

    const updatedR2 = await prisma.registration.findUnique({ where: { reference: refShortlisted2 } });
    assert.equal(updatedR2.status, 'PAYMENT_PENDING');

    // Ineligible statuses remain unchanged
    const updatedPending = await prisma.registration.findUnique({ where: { reference: refPendingReview } });
    assert.equal(updatedPending.status, 'PENDING_REVIEW');

    const updatedRej = await prisma.registration.findUnique({ where: { reference: refRejected } });
    assert.equal(updatedRej.status, 'REJECTED');

    const updatedPaid = await prisma.registration.findUnique({ where: { reference: refPaid } });
    assert.equal(updatedPaid.status, 'CONFIRMED');
  });

  // ------------------------------------------------------------- Active Link Reuse Test
  await t.test('5. Re-sending to applicants with unexpired invitations reuses the active links safely', async () => {
    const res = await request(app)
      .post('/api/v1/admin/registrations/bulk-send-payment-links')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({
        references: [refShortlisted1, refShortlisted2],
        expiryDays: 7,
        force: false
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.reused, 2, 'Both applicants should reuse their active unexpired links');
    assert.equal(res.body.summary.sent, 0);

    // Assert that the database does not contain duplicate active links
    const invCountR1 = await prisma.paymentInvitation.count({
      where: { registrationReference: refShortlisted1 }
    });
    assert.equal(invCountR1, 1, 'Idempotency: No duplicate invitation records created');
  });

  // ------------------------------------------------------------- Audit Log Test
  await t.test('6. Bulk action records an audit trail entry with metadata summary', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payment.invitation.bulk_sent' },
      orderBy: { createdAt: 'desc' }
    });

    assert.ok(audit, 'Audit log entry must be present');
    assert.ok(audit.metadata);
    assert.equal(audit.metadata.requestedCount, 2);
  });

  // ------------------------------------------------------------- Security & Auth Tests
  await t.test('7. Unauthorized requests are strictly refused', async () => {
    // No session cookie
    const resUnauth = await request(app)
      .post('/api/v1/admin/registrations/bulk-send-payment-links')
      .send({ references: [refShortlisted1] });
    assert.equal(resUnauth.status, 401);

    // Missing CSRF token
    const resNoCsrf = await request(app)
      .post('/api/v1/admin/registrations/bulk-send-payment-links')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .send({ references: [refShortlisted1] });
    assert.equal(resNoCsrf.status, 403);
  });
});
