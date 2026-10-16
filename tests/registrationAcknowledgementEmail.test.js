import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import {
  setTransporter,
  getTransporter,
  getRulesPdfPath,
  generateAcknowledgementEmailContent,
  sendRegistrationAcknowledgementEmail
} from '../src/services/email.js';
import { setupTestEnvironment } from './helpers/testDb.js';

test('Salem Star Speaker — Registration Confirmation Email with PDF Attachment', async (t) => {
  await setupTestEnvironment();

  // Test 1: Rules PDF file exists and has valid PDF header
  await t.test('Rules PDF asset exists and has valid PDF header (%PDF)', () => {
    const pdfPath = getRulesPdfPath();
    assert.ok(pdfPath, 'Rules PDF path must be resolved');
    assert.ok(fs.existsSync(pdfPath), `File must exist at ${pdfPath}`);
    const buffer = fs.readFileSync(pdfPath);
    assert.ok(buffer.length > 1000, 'PDF should have reasonable size');
    const header = buffer.subarray(0, 5).toString('ascii');
    assert.equal(header.startsWith('%PDF'), true, 'File must have valid %PDF signature');
  });

  // Test 2: generateAcknowledgementEmailContent generates required plain text and HTML
  await t.test('generateAcknowledgementEmailContent produces required sections and escapes values', () => {
    const registration = {
      fullName: 'Ananya <Script>alert(1)</Script> Sharma',
      reference: 'SSS-2026-TESTACK',
      email: 'ananya@example.invalid'
    };
    const content = generateAcknowledgementEmailContent({ registration });

    assert.equal(content.subject, 'Registration Received — Salem Star Speaker Contest');
    assert.ok(content.html.includes('&lt;Script&gt;'), 'HTML must escape malicious characters');
    assert.ok(!content.html.includes('<Script>'), 'Raw unescaped script tag must not appear');
    assert.ok(content.html.includes('SSS-2026-TESTACK'), 'HTML must include reference number');
    assert.ok(content.html.includes('Monday, 26 October 2026'), 'HTML must include registration deadline');
    assert.ok(content.html.includes('Friday, 30 October 2026'), 'HTML must include briefing date');
    assert.ok(content.html.includes('Salem Star Speaker Contest Rules and Regulations'), 'HTML must mention attached rules');

    assert.ok(content.text.includes('SSS-2026-TESTACK'), 'Text must include reference number');
    assert.ok(content.text.includes('Monday, 26 October 2026'), 'Text must include registration deadline');
    assert.ok(content.text.includes('Friday, 30 October 2026'), 'Text must include briefing date');
  });

  // Test 3: Submitting application triggers acknowledgement email with PDF attachment
  await t.test('Successful application submission triggers acknowledgement email with PDF attachment', async () => {
    const sentEmails = [];
    const mockTransporter = {
      sendMail: async (options) => {
        sentEmails.push(options);
        return { messageId: `msg-${Date.now()}` };
      }
    };
    setTransporter(mockTransporter);

    const testEmail = `ack-test-${Date.now()}@example.invalid`;
    const res = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Aarav Kumar',
        email: testEmail,
        phone: '9876543210',
        dob: '2014-05-15',
        category: 'kid',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Kumar Senior',
        guardianRelationship: 'Father',
        guardianPhone: '9876543211',
        guardianEmail: 'kumar.senior@example.com'
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    const reference = res.body.application.reference;
    assert.ok(reference);

    // Wait for async email dispatch
    for (let i = 0; i < 25; i++) {
      if (sentEmails.find((m) => m.to === testEmail)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Verify email was dispatched
    const email = sentEmails.find((m) => m.to === testEmail);
    assert.ok(email, 'Acknowledgement email must be sent to registered participant email');
    assert.equal(email.subject, 'Registration Received — Salem Star Speaker Contest');
    assert.ok(email.text.includes(reference), 'Email text must include reference number');
    assert.ok(email.html.includes(reference), 'Email HTML must include reference number');

    // Verify attachment
    assert.ok(Array.isArray(email.attachments), 'Email must have attachments array');
    const pdfAttachment = email.attachments.find((a) => a.filename === 'Salem-Star-Speaker-Contest-Rules.pdf');
    assert.ok(pdfAttachment, 'Email must have Salem-Star-Speaker-Contest-Rules.pdf attached');
    assert.equal(pdfAttachment.contentType, 'application/pdf');
    assert.ok(fs.existsSync(pdfAttachment.path), 'Attachment path must exist on disk');

    // Verify EmailDelivery row in PostgreSQL
    const delivery = await prisma.emailDelivery.findFirst({
      where: { registrationReference: reference, emailType: 'REGISTRATION_ACKNOWLEDGEMENT' }
    });
    assert.ok(delivery, 'EmailDelivery record must be created in PostgreSQL');
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.recipientEmail, testEmail);

    setTransporter(null); // restore
  });

  // Test 4: Failed validation does not trigger an email
  await t.test('Failed validation does not save registration or trigger acknowledgement email', async () => {
    let emailSent = false;
    setTransporter({
      sendMail: async () => {
        emailSent = true;
        return { messageId: 'invalid' };
      }
    });

    const res = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: '', // invalid
        email: 'invalid-email',
        category: 'kid'
      });

    assert.equal(res.status, 400);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(emailSent, false, 'Email must not be sent on validation failure');
    setTransporter(null);
  });

  // Test 5: SMTP failure does not rollback saved application and records FAILED status
  await t.test('SMTP failure does not invalidate saved application and logs delivery failure', async () => {
    const failingTransporter = {
      sendMail: async () => {
        throw new Error('Connection timeout to mail.eventsinfinite.com:465');
      }
    };
    setTransporter(failingTransporter);

    const testEmail = `smtp-fail-${Date.now()}@example.invalid`;
    const res = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Kavitha Devi',
        email: testEmail,
        phone: '9876543212',
        dob: '2010-08-10',
        category: 'teen',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Devi Senior',
        guardianRelationship: 'Mother',
        guardianPhone: '9876543213',
        guardianEmail: 'devi.senior@example.com'
      });

    assert.equal(res.status, 201, 'Application must still be created successfully');
    const reference = res.body.application.reference;

    // Wait for async error handling
    await new Promise((r) => setTimeout(r, 200));

    // Verify application is still safely stored in DB
    const saved = await prisma.registration.findUnique({ where: { reference } });
    assert.ok(saved, 'Registration record must remain intact in PostgreSQL');
    assert.equal(saved.status, 'PENDING_REVIEW');

    // Verify EmailDelivery record recorded FAILED
    const delivery = await prisma.emailDelivery.findFirst({
      where: { registrationReference: reference, emailType: 'REGISTRATION_ACKNOWLEDGEMENT' }
    });
    assert.ok(delivery, 'EmailDelivery record must exist');
    assert.equal(delivery.status, 'FAILED');
    assert.ok(delivery.errorMessage.includes('timeout'));

    setTransporter(null);
  });

  // Test 6: Idempotent resend / duplicate submission does not send uncontrolled duplicate emails
  await t.test('Repeated acknowledgement email send is idempotent and does not duplicate', async () => {
    let sendCount = 0;
    setTransporter({
      sendMail: async () => {
        sendCount++;
        return { messageId: 'm1' };
      }
    });

    const testEmail = `idempotent-${Date.now()}@example.invalid`;
    const res = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Suresh Raina',
        email: testEmail,
        phone: '9876543214',
        dob: '1995-10-10',
        category: 'adult',
        occupation: 'Working Professional',
        city: 'Salem'
      });

    assert.equal(res.status, 201);
    const reference = res.body.application.reference;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sendCount, 1);

    const saved = await prisma.registration.findUnique({ where: { reference } });

    // Calling sendRegistrationAcknowledgementEmail again without force should be skipped
    const retryResult = await sendRegistrationAcknowledgementEmail({ registration: saved, force: false });
    assert.equal(retryResult.skipped, true);
    assert.equal(retryResult.reason, 'Already sent');
    assert.equal(sendCount, 1, 'Should not send duplicate email');

    // With force: true, retry sends exactly once more
    const forcedResult = await sendRegistrationAcknowledgementEmail({ registration: saved, force: true });
    assert.equal(forcedResult.success, true);
    assert.equal(sendCount, 2, 'Forced resend should deliver once');

    setTransporter(null);
  });
});
