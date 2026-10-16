import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import {
  EVENT_CONFIG,
  WHATSAPP_GROUP_INVITE_URL
} from '../src/config/event.js';
import {
  generateAcknowledgementEmailContent,
  generatePaymentInvitationEmailContent,
  generateConfirmationEmailContent,
  renderWhatsAppEmailSectionHtml,
  renderWhatsAppEmailSectionText,
  setTransporter
} from '../src/services/email.js';
import { setupTestEnvironment } from './helpers/testDb.js';

test('Salem Star Speaker — WhatsApp Group Invitation Across Registration Journey', async (t) => {
  await setupTestEnvironment();

  const EXPECTED_URL = 'https://chat.whatsapp.com/Jbsi0DQ7xFRDyi5ylydf15?s=sw&p=a&mlu=4&ilr=4';

  // 1. Centralized configuration check
  await t.test('1. Centralized WHATSAPP_GROUP_INVITE_URL matches official invite link and preserves query params', () => {
    assert.equal(WHATSAPP_GROUP_INVITE_URL, EXPECTED_URL);
    assert.equal(EVENT_CONFIG.whatsappGroupInviteUrl, EXPECTED_URL);
  });

  // 2. Public /event API endpoint includes whatsappGroupInviteUrl
  await t.test('2. /api/v1/event exposes whatsappGroupInviteUrl without exposing secrets', async () => {
    const res = await request(app).get('/api/v1/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.event.whatsappGroupInviteUrl, EXPECTED_URL);
  });

  // 3. Reusable email helper renders valid HTML and plain text with exact URL
  await t.test('3. Reusable email helpers generate valid HTML & plain text with exact URL', () => {
    const html = renderWhatsAppEmailSectionHtml({
      heading: 'Stay Connected on WhatsApp',
      content: 'Join our official WhatsApp group.',
      buttonText: 'Join WhatsApp Group'
    });
    assert.ok(html.includes(EXPECTED_URL), 'HTML must contain official URL verbatim');
    assert.ok(html.includes('Stay Connected on WhatsApp'), 'HTML must include heading');
    assert.ok(html.includes('Join WhatsApp Group'), 'HTML must include button label');

    const text = renderWhatsAppEmailSectionText({
      heading: 'Stay Connected on WhatsApp',
      content: 'Join our official WhatsApp group.',
      buttonText: 'Join WhatsApp Group'
    });
    assert.ok(text.includes(EXPECTED_URL), 'Text must contain official URL verbatim');
    assert.ok(text.includes('STAY CONNECTED ON WHATSAPP'), 'Text must include heading');
  });

  // 4. Stage B: Registration Acknowledgement Email
  await t.test('4. Registration acknowledgement email includes Stage B WhatsApp invitation', () => {
    const registration = {
      fullName: 'Meera Krishnan',
      reference: 'SSS-2026-WA-TEST',
      email: 'meera@example.invalid'
    };
    const content = generateAcknowledgementEmailContent({ registration });

    // HTML assertions
    assert.ok(content.html.includes(EXPECTED_URL), 'HTML must contain official WhatsApp URL');
    assert.ok(content.html.includes('Stay Connected on WhatsApp'), 'HTML must contain Stage B heading');
    assert.ok(content.html.includes('Join WhatsApp Group'), 'HTML must contain CTA button text');
    assert.ok(content.html.includes('SSS-2026-WA-TEST'), 'HTML must preserve application reference');

    // Plain text assertions
    assert.ok(content.text.includes(EXPECTED_URL), 'Text must contain official WhatsApp URL');
    assert.ok(content.text.includes('STAY CONNECTED ON WHATSAPP'), 'Text must contain heading');
    assert.ok(content.text.includes('SSS-2026-WA-TEST'), 'Text must preserve reference');
  });

  // 5. Stage D: Payment Invitation Email
  await t.test('5. Payment invitation email includes Stage D WhatsApp invitation without replacing payment CTA', () => {
    const registration = {
      id: 'reg-wa-1',
      fullName: 'Rohan Sharma',
      reference: 'SSS-2026-PAY-WA',
      email: 'rohan@example.invalid',
      categorySlug: 'teen',
      amountPaise: 19900
    };
    const invitation = {
      amountPaise: 19900,
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    };
    const paymentUrl = 'https://sss.eventsinfinite.com/pay/mock-token-xyz';

    const content = generatePaymentInvitationEmailContent({
      registration,
      invitation,
      paymentUrl,
      expiryDateDisplay: 'Friday, 23 October 2026'
    });

    // Primary payment CTA must remain intact
    assert.ok(content.html.includes(paymentUrl), 'HTML must contain distinct payment URL');
    assert.ok(content.text.includes(paymentUrl), 'Text must contain distinct payment URL');
    assert.ok(content.html.includes('Pay Registration Fee · ₹199'), 'HTML must contain primary payment CTA');

    // WhatsApp CTA must be present with official URL
    assert.ok(content.html.includes(EXPECTED_URL), 'HTML must contain official WhatsApp URL');
    assert.ok(content.html.includes('Keep Up With Contest Updates'), 'HTML must contain Stage D heading');
    assert.ok(content.text.includes(EXPECTED_URL), 'Text must contain official WhatsApp URL');
    assert.ok(content.text.includes('KEEP UP WITH CONTEST UPDATES'), 'Text must contain Stage D heading');
  });

  // 6. Stage F: Payment / Booking Confirmation Email
  await t.test('6. Payment confirmation email includes Stage F WhatsApp invitation', () => {
    const registration = {
      id: 'reg-wa-confirmed',
      fullName: 'Deepak V',
      reference: 'SSS-2026-CONF-WA',
      email: 'deepak@example.invalid',
      categorySlug: 'adult',
      amountPaise: 29900,
      baseAmountPaise: 29900,
      discountPaise: 0
    };
    const payment = {
      amountPaise: 29900,
      razorpayPaymentId: 'pay_test_confirmed_wa123'
    };

    const content = generateConfirmationEmailContent({ registration, payment });

    // HTML assertions
    assert.ok(content.html.includes(EXPECTED_URL), 'Confirmation HTML must contain official WhatsApp URL');
    assert.ok(content.html.includes('Join Our Official WhatsApp Group'), 'Confirmation HTML must contain heading');
    assert.ok(content.html.includes('pay_test_confirmed_wa123'), 'Confirmation HTML must preserve transaction ID');
    assert.ok(content.html.includes('SSS-2026-CONF-WA'), 'Confirmation HTML must preserve reference');

    // Text assertions
    assert.ok(content.text.includes(EXPECTED_URL), 'Confirmation text must contain official WhatsApp URL');
    assert.ok(content.text.includes('JOIN OUR OFFICIAL WHATSAPP GROUP'), 'Confirmation text must contain heading');
    assert.ok(content.text.includes('SSS-2026-CONF-WA'), 'Confirmation text must preserve reference');
  });

  // 7. Full registration dispatch includes WhatsApp CTA in sent mail
  await t.test('7. New application submission dispatches acknowledgement with WhatsApp CTA and rules PDF', async () => {
    const sentEmails = [];
    setTransporter({
      sendMail: async (options) => {
        sentEmails.push(options);
        return { messageId: `msg-wa-${Date.now()}` };
      }
    });

    const testEmail = `wa-journey-${Date.now()}@example.invalid`;
    const res = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Kavitha Ram',
        email: testEmail,
        phone: '9845012345',
        dob: '2009-08-10',
        category: 'teen',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Ram Parent',
        guardianRelationship: 'Father',
        guardianPhone: '9845012346',
        guardianEmail: 'ram.parent@example.com'
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    const reference = res.body.application.reference;

    // Await async email send
    for (let i = 0; i < 25; i++) {
      if (sentEmails.find((m) => m.to === testEmail)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const email = sentEmails.find((m) => m.to === testEmail);
    assert.ok(email, 'Email must have been dispatched');
    assert.ok(email.html.includes(EXPECTED_URL), 'Dispatched email HTML must contain official WhatsApp URL');
    assert.ok(email.text.includes(EXPECTED_URL), 'Dispatched email text must contain official WhatsApp URL');
    assert.ok(email.attachments.some((a) => a.filename === 'Salem-Star-Speaker-Contest-Rules.pdf'), 'PDF attachment preserved');
  });
});
