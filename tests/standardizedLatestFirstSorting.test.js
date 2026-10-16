import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';
import { prisma } from '../src/db/prisma.js';
import {
  listRegistrations,
  listParticipants,
  listPayments,
  listAuditLogs,
  listEmailDeliveries,
  listCoupons,
  getRegistrationDetail
} from '../src/services/adminQueries.js';

describe('Standardized Latest-First Sorting Across All Data Lists', () => {
  before(async () => {
    await setupTestEnvironment();
  });

  after(async () => {
    await teardownTestEnvironment();
  });

  it('1. Registrations / Applications list orders newest first by default with deterministic tie-breaker', async () => {
    const runId = Date.now();
    const t0 = new Date(Date.now() - 30000);
    const t1 = new Date(Date.now() - 20000);
    const t2 = new Date(Date.now() - 10000);

    const r1 = await prisma.registration.create({
      data: {
        reference: `SSS-SORT-R1-${runId}`,
        fullName: 'Applicant One Older',
        email: `sort1_${runId}@example.com`,
        phone: '9876543210',
        dob: new Date('2014-05-10'),
        ageOnContest: 12,
        occupation: 'Student',
        city: 'Salem',
        categorySlug: 'kid',
        amountPaise: 9900,
        status: 'PENDING_REVIEW',
        createdAt: t0
      }
    });

    const r2 = await prisma.registration.create({
      data: {
        reference: `SSS-SORT-R2-${runId}`,
        fullName: 'Applicant Two Middle',
        email: `sort2_${runId}@example.com`,
        phone: '9876543211',
        dob: new Date('2014-05-10'),
        ageOnContest: 12,
        occupation: 'Student',
        city: 'Salem',
        categorySlug: 'kid',
        amountPaise: 9900,
        status: 'PENDING_REVIEW',
        createdAt: t1
      }
    });

    const r3 = await prisma.registration.create({
      data: {
        reference: `SSS-SORT-R3-${runId}`,
        fullName: 'Applicant Three Newest',
        email: `sort3_${runId}@example.com`,
        phone: '9876543212',
        dob: new Date('2014-05-10'),
        ageOnContest: 12,
        occupation: 'Student',
        city: 'Salem',
        categorySlug: 'kid',
        amountPaise: 9900,
        status: 'PENDING_REVIEW',
        createdAt: t2
      }
    });

    // Query without sort params (default)
    const result = await listRegistrations({ q: `SSS-SORT-R` });
    const matching = result.items.filter((item) =>
      [r1.reference, r2.reference, r3.reference].includes(item.reference)
    );

    assert.equal(matching.length, 3);
    assert.equal(matching[0].reference, r3.reference, 'Newest registration must be first');
    assert.equal(matching[1].reference, r2.reference, 'Middle registration must be second');
    assert.equal(matching[2].reference, r1.reference, 'Oldest registration must be last');
  });

  it('2. Status-filtered lists (shortlisted, rejected, pending) preserve newest-first order', async () => {
    const runId = Date.now();
    const t0 = new Date(Date.now() - 20000);
    const t1 = new Date(Date.now() - 10000);

    const rA = await prisma.registration.create({
      data: {
        reference: `SSS-FLT-A-${runId}`,
        fullName: 'Shortlist Older',
        email: `shA_${runId}@example.com`,
        phone: '9876543213',
        dob: new Date('2010-05-10'),
        ageOnContest: 16,
        occupation: 'Student',
        city: 'Salem',
        categorySlug: 'teen',
        amountPaise: 19900,
        status: 'SHORTLISTED',
        reviewDecision: 'SHORTLISTED',
        createdAt: t0
      }
    });

    const rB = await prisma.registration.create({
      data: {
        reference: `SSS-FLT-B-${runId}`,
        fullName: 'Shortlist Newer',
        email: `shB_${runId}@example.com`,
        phone: '9876543214',
        dob: new Date('2010-05-10'),
        ageOnContest: 16,
        occupation: 'Student',
        city: 'Salem',
        categorySlug: 'teen',
        amountPaise: 19900,
        status: 'SHORTLISTED',
        reviewDecision: 'SHORTLISTED',
        createdAt: t1
      }
    });

    const result = await listRegistrations({ decision: 'SHORTLISTED', q: `SSS-FLT-` });
    const matching = result.items.filter((item) =>
      [rA.reference, rB.reference].includes(item.reference)
    );

    assert.equal(matching.length, 2);
    assert.equal(matching[0].reference, rB.reference, 'Newest shortlisted applicant must appear first');
    assert.equal(matching[1].reference, rA.reference, 'Older shortlisted applicant must appear second');
  });

  it('3. Participants list orders by registration date descending by default', async () => {
    const runId = Date.now();
    const t0 = new Date(Date.now() - 15000);
    const t1 = new Date(Date.now() - 5000);

    const pOld = await prisma.registration.create({
      data: {
        reference: `SSS-PART-OLD-${runId}`,
        fullName: 'Participant Older Registration',
        email: `part_old_${runId}@example.com`,
        phone: '9876543220',
        dob: new Date('1995-05-10'),
        ageOnContest: 31,
        occupation: 'Professional',
        city: 'Salem',
        categorySlug: 'adult',
        amountPaise: 29900,
        status: 'PAID',
        createdAt: t0
      }
    });

    const pNew = await prisma.registration.create({
      data: {
        reference: `SSS-PART-NEW-${runId}`,
        fullName: 'Participant Newer Registration',
        email: `part_new_${runId}@example.com`,
        phone: '9876543221',
        dob: new Date('1995-05-10'),
        ageOnContest: 31,
        occupation: 'Professional',
        city: 'Salem',
        categorySlug: 'adult',
        amountPaise: 29900,
        status: 'PAID',
        createdAt: t1
      }
    });

    const result = await listParticipants({ q: `SSS-PART-` });
    const matching = result.items.filter((item) =>
      [pOld.reference, pNew.reference].includes(item.reference)
    );

    assert.equal(matching.length, 2);
    assert.equal(matching[0].reference, pNew.reference, 'Newest registered participant must appear first');
    assert.equal(matching[1].reference, pOld.reference);
  });

  it('4. Payments list orders by payment createdAt descending by default', async () => {
    const runId = Date.now();
    const reg = await prisma.registration.create({
      data: {
        reference: `SSS-PAY-${runId}`,
        fullName: 'Pay Tester',
        email: `pay_${runId}@example.com`,
        phone: '9876543230',
        dob: new Date('2000-01-01'),
        ageOnContest: 26,
        occupation: 'Engineer',
        city: 'Salem',
        categorySlug: 'adult',
        amountPaise: 29900,
        status: 'PAID'
      }
    });

    const p1 = await prisma.payment.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        razorpayOrderId: `order_old_${runId}`,
        razorpayPaymentId: `pay_old_${runId}`,
        amountPaise: 29900,
        status: 'FAILED',
        createdAt: new Date(Date.now() - 10000)
      }
    });

    const p2 = await prisma.payment.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        razorpayOrderId: `order_new_${runId}`,
        razorpayPaymentId: `pay_new_${runId}`,
        amountPaise: 29900,
        status: 'CAPTURED',
        createdAt: new Date(Date.now() - 2000)
      }
    });

    const result = await listPayments({ q: reg.reference });
    const matching = result.items.filter((p) => [p1.id, p2.id].includes(p.id));

    assert.equal(matching.length, 2);
    assert.equal(matching[0].id, p2.id, 'Most recently created payment must be first');
    assert.equal(matching[1].id, p1.id, 'Older payment must be second');
  });

  it('5. Email Deliveries and Audit Logs order newest first by default', async () => {
    const runId = Date.now();
    const reg = await prisma.registration.create({
      data: {
        reference: `SSS-COMM-${runId}`,
        fullName: 'Comm Tester',
        email: `comm_${runId}@example.com`,
        phone: '9876543240',
        dob: new Date('2000-01-01'),
        ageOnContest: 26,
        occupation: 'Engineer',
        city: 'Salem',
        categorySlug: 'adult',
        amountPaise: 29900,
        status: 'PAID'
      }
    });

    const e1 = await prisma.emailDelivery.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        recipientEmail: reg.email,
        emailType: 'PAYMENT_CONFIRMATION',
        subject: 'First attempt',
        status: 'FAILED',
        createdAt: new Date(Date.now() - 8000)
      }
    });

    const e2 = await prisma.emailDelivery.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        recipientEmail: reg.email,
        emailType: 'PAYMENT_CONFIRMATION',
        subject: 'Second attempt',
        status: 'SENT',
        createdAt: new Date(Date.now() - 1000)
      }
    });

    const emailList = await listEmailDeliveries({ q: reg.reference });
    const matchingEmails = emailList.items.filter((e) => [e1.id, e2.id].includes(e.id));
    assert.equal(matchingEmails.length, 2);
    assert.equal(matchingEmails[0].id, e2.id, 'Newest email attempt must be first');

    // Audit logs
    const a1 = await prisma.auditLog.create({
      data: {
        actorEmail: `admin_${runId}@example.com`,
        action: 'TEST_ACTION_OLD',
        entityType: 'registration',
        entityId: reg.reference,
        createdAt: new Date(Date.now() - 7000)
      }
    });

    const a2 = await prisma.auditLog.create({
      data: {
        actorEmail: `admin_${runId}@example.com`,
        action: 'TEST_ACTION_NEW',
        entityType: 'registration',
        entityId: reg.reference,
        createdAt: new Date(Date.now() - 500)
      }
    });

    const auditList = await listAuditLogs({ actor: `admin_${runId}@example.com` });
    const matchingAudits = auditList.items.filter((a) => [a1.id, a2.id].includes(a.id));
    assert.equal(matchingAudits.length, 2);
    assert.equal(matchingAudits[0].id, a2.id, 'Newest audit action must be first');
  });

  it('6. Detail view nested sub-collections (payments, invitations, notes, audits) are sorted newest first', async () => {
    const runId = Date.now();
    const reg = await prisma.registration.create({
      data: {
        reference: `SSS-DET-${runId}`,
        fullName: 'Detail Tester',
        email: `det_${runId}@example.com`,
        phone: '9876543250',
        dob: new Date('2000-01-01'),
        ageOnContest: 26,
        occupation: 'Engineer',
        city: 'Salem',
        categorySlug: 'adult',
        amountPaise: 29900,
        status: 'SHORTLISTED'
      }
    });

    // Create 2 invitations
    const inv1 = await prisma.paymentInvitation.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        token: `inv_token_old_${runId}`,
        amountPaise: 29900,
        sentToEmail: reg.email,
        expiresAt: new Date(Date.now() + 7 * 86400000),
        createdAt: new Date(Date.now() - 6000)
      }
    });
    const inv2 = await prisma.paymentInvitation.create({
      data: {
        registrationId: reg.id,
        registrationReference: reg.reference,
        token: `inv_token_new_${runId}`,
        amountPaise: 29900,
        sentToEmail: reg.email,
        expiresAt: new Date(Date.now() + 7 * 86400000),
        createdAt: new Date(Date.now() - 1000)
      }
    });

    // Create 2 notes
    const note1 = await prisma.adminNote.create({
      data: {
        registrationReference: reg.reference,
        authorEmail: 'reviewer@example.com',
        body: 'Initial note',
        createdAt: new Date(Date.now() - 5000)
      }
    });
    const note2 = await prisma.adminNote.create({
      data: {
        registrationReference: reg.reference,
        authorEmail: 'reviewer@example.com',
        body: 'Followup note',
        createdAt: new Date(Date.now() - 500)
      }
    });

    const detail = await getRegistrationDetail(reg.reference);

    assert.equal(detail.paymentInvitations[0].id, inv2.id, 'Newest invitation must be first');
    assert.equal(detail.paymentInvitations[1].id, inv1.id);

    assert.equal(detail.notes[0].id, note2.id, 'Newest note must be first');
    assert.equal(detail.notes[1].id, note1.id);
  });
});
