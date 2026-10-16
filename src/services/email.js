import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { EVENT_CONFIG, WHATSAPP_GROUP_INVITE_URL } from '../config/event.js';
import { prisma } from '../db/prisma.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Reusable HTML helper for the official WhatsApp group invitation callout box in emails.
 */
export function renderWhatsAppEmailSectionHtml({
  heading = 'Stay Connected on WhatsApp',
  content = 'Join our official WhatsApp group to stay informed about important announcements, contest updates, and participant instructions.',
  buttonText = 'Join WhatsApp Group',
  url = WHATSAPP_GROUP_INVITE_URL
} = {}) {
  const safeHeading = escapeHtml(heading);
  const safeContent = escapeHtml(content);
  const safeButtonText = escapeHtml(buttonText);

  return `
    <!-- WhatsApp Invitation Section -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 24px 0; background-color: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 12px; overflow: hidden;">
      <tr>
        <td style="padding: 22px 24px; text-align: center;">
          <div style="font-size: 11px; text-transform: uppercase; color: #166534; font-weight: 700; letter-spacing: 1px; margin-bottom: 6px;">
            Official Community
          </div>
          <h3 style="margin: 0 0 8px 0; font-size: 17px; font-weight: 700; color: #14532D; letter-spacing: -0.2px;">
            ${safeHeading}
          </h3>
          <p style="margin: 0 0 16px 0; font-size: 14px; color: #374151; line-height: 1.5; max-width: 480px; margin-left: auto; margin-right: auto;">
            ${safeContent}
          </p>
          <div style="margin-bottom: 12px;">
            <a href="${url}" target="_blank" rel="noopener noreferrer" style="background-color: #16A34A; color: #FFFFFF; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 28px; border-radius: 50px; display: inline-block; box-shadow: 0 3px 10px rgba(22, 163, 74, 0.25);">
              ${safeButtonText} &rarr;
            </a>
          </div>
          <p style="margin: 0; font-size: 11.5px; color: #166534;">
            Official link: <a href="${url}" style="color: #166534; word-break: break-all; text-decoration: underline;">${url}</a>
          </p>
        </td>
      </tr>
    </table>
  `.trim();
}

/**
 * Reusable plain-text helper for the official WhatsApp group invitation block in emails.
 */
export function renderWhatsAppEmailSectionText({
  heading = 'Stay Connected on WhatsApp',
  content = 'Join our official WhatsApp group to stay informed about important announcements, contest updates, and participant instructions.',
  buttonText = 'Join WhatsApp Group',
  url = WHATSAPP_GROUP_INVITE_URL
} = {}) {
  return `
${heading.toUpperCase()}
${content}
${buttonText}:
${url}
`.trim();
}

export function getRulesPdfPath() {
  const candidates = [
    path.resolve(__dirname, '../../assets/Salem-Star-Speaker-Contest-Rules.pdf'),
    path.resolve(process.cwd(), 'assets/Salem-Star-Speaker-Contest-Rules.pdf'),
    path.resolve(process.cwd(), 'website/sss-api/assets/Salem-Star-Speaker-Contest-Rules.pdf'),
    path.resolve(process.cwd(), '../sss-api/assets/Salem-Star-Speaker-Contest-Rules.pdf'),
    'C:\\Users\\HP\\Downloads\\Salem Star Speaker_Contest_Rules.pdf'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

let transporterInstance = null;

export function getTransporter() {
  if (!transporterInstance) {
    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      transporterInstance = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS
        },
        tls: {
          rejectUnauthorized: env.NODE_ENV === 'production'
        }
      });
    }
  }
  return transporterInstance;
}

export function setTransporter(transporter) {
  transporterInstance = transporter;
}

/**
 * Generates polished HTML & plain-text confirmation emails.
 */
export function generateConfirmationEmailContent({ registration, payment }) {
  const basePaise = registration.baseAmountPaise ?? registration.amountPaise;
  const discountPaise = registration.discountPaise || 0;
  const paidPaise = payment.amountPaise ?? registration.amountPaise;
  const isFree = payment.settlementMode === 'COMPLIMENTARY' || paidPaise === 0;

  const baseRupees = (basePaise / 100).toFixed(0);
  const discountRupees = (discountPaise / 100).toFixed(0);
  const amountRupees = (paidPaise / 100).toFixed(0);

  const contactsHtml = EVENT_CONFIG.contacts
    .map((c) => `<strong>${c.name}:</strong> <a href="${c.tel}" style="color: #102E52; text-decoration: none;">${c.phone}</a>`)
    .join(' &nbsp;|&nbsp; ');
  const contactsText = EVENT_CONFIG.contacts
    .map((c) => `${c.name}: ${c.phone}`)
    .join(' | ');

  const fullName = registration.fullName || registration.full_name;
  const categorySlug = registration.categorySlug || registration.category_slug;
  const paymentId = isFree ? 'Complimentary' : (payment.razorpayPaymentId || payment.razorpay_payment_id || 'Verified');
  const bookingUrl = `${(env.FRONTEND_URL || 'https://sss.eventsinfinite.com').replace(/\/$/, '')}/booking/${registration.reference}`;

  // Breakdown rows for HTML
  let breakdownRowsHtml = `
    <tr style="border-bottom: 1px solid #F0EAE1;">
      <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Registration Fee</td>
      <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #102E52; text-align: right;">₹${baseRupees}</td>
    </tr>
  `;
  if (discountPaise > 0 && registration.couponCode) {
    breakdownRowsHtml += `
    <tr style="border-bottom: 1px solid #F0EAE1;">
      <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Coupon (${registration.couponCode})</td>
      <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #2E7D32; text-align: right;">-₹${discountRupees}</td>
    </tr>
    `;
  }
  breakdownRowsHtml += `
    <tr style="border-bottom: 1px solid #F0EAE1;">
      <td style="padding: 10px 0; font-size: 14px; font-weight: 700; color: #102E52;">${isFree ? 'Payable' : 'Amount Paid'}</td>
      <td style="padding: 10px 0; font-size: 14px; font-weight: 700; color: #102E52; text-align: right;">${isFree ? '₹0 — Complimentary' : `₹${amountRupees}`}</td>
    </tr>
  `;
  if (!isFree) {
    breakdownRowsHtml += `
    <tr style="border-bottom: 1px solid #F0EAE1;">
      <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Payment ID</td>
      <td style="padding: 10px 0; font-size: 14px; font-family: monospace; color: #5F6775; text-align: right;">${paymentId}</td>
    </tr>
    `;
  }

  // Breakdown text
  let breakdownText = `Registration Fee: ₹${baseRupees}\n`;
  if (discountPaise > 0 && registration.couponCode) {
    breakdownText += `Coupon (${registration.couponCode}): -₹${discountRupees}\n`;
  }
  breakdownText += `${isFree ? 'Payable: ₹0 — Complimentary' : `Amount Paid: ₹${amountRupees}`}\n`;
  if (!isFree) {
    breakdownText += `Payment ID: ${paymentId}\n`;
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registration ${isFree ? 'Confirmed (Complimentary)' : 'Confirmed'} — ${EVENT_CONFIG.name}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #102E52; line-height: 1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FAF7F1; padding: 30px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(16, 46, 82, 0.08); border: 1px solid #EBE4D5;">
          
          <!-- Header -->
          <tr>
            <td style="background-color: #102E52; padding: 36px 30px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                ${EVENT_CONFIG.shortName}
              </h1>
              <p style="margin: 6px 0 0 0; color: #E7C27A; font-size: 14px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">
                ${isFree ? 'Registration Confirmed (Complimentary)' : 'Registration & Payment Confirmed'}
              </p>
            </td>
          </tr>

          <!-- Hero Details -->
          <tr>
            <td style="padding: 30px;">
              <p style="margin: 0 0 16px 0; font-size: 17px; color: #102E52;">
                Dear <strong>${fullName}</strong>,
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; color: #5F6775;">
                ${isFree
                  ? `We are thrilled to confirm your complimentary registration for <strong>${EVENT_CONFIG.name}</strong>.`
                  : `We are thrilled to confirm your registration for <strong>${EVENT_CONFIG.name}</strong>. Your payment has been received successfully.`}
              </p>

              <!-- Reference Badge with Canonical Booking Link -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px; background-color: #F3EDE2; border-radius: 12px; border: 1px solid #E5DCCB;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <div style="font-size: 12px; text-transform: uppercase; color: #A8781F; font-weight: 700; letter-spacing: 1px;">
                      Registration Reference
                    </div>
                    <div style="font-size: 24px; font-weight: 800; color: #102E52; letter-spacing: 0.5px; margin-top: 4px;">
                      ${registration.reference}
                    </div>
                    <div style="margin-top: 10px; font-size: 13px;">
                      <a href="${bookingUrl}" style="color: #102E52; font-weight: 600; text-decoration: underline;">
                        View your booking details &amp; receipt online &rarr;
                      </a>
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Registration Summary -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #F0EAE1;">
                  <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Participant</td>
                  <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #102E52; text-align: right;">${fullName}</td>
                </tr>
                <tr style="border-bottom: 1px solid #F0EAE1;">
                  <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Category</td>
                  <td style="padding: 10px 0; font-size: 14px; font-weight: 600; color: #102E52; text-align: right;">${categorySlug.toUpperCase()}</td>
                </tr>
                ${breakdownRowsHtml}
              </table>

              <!-- Official WhatsApp Group Invitation (Stage F) -->
              ${renderWhatsAppEmailSectionHtml({
                heading: 'Join Our Official WhatsApp Group',
                content: 'Your payment has been verified. Join our official WhatsApp group to receive contest announcements and important participant instructions.',
                buttonText: 'Join WhatsApp Group',
                url: WHATSAPP_GROUP_INVITE_URL
              })}

              <!-- Event Details -->
              <div style="background-color: #FAF7F1; padding: 20px; border-radius: 12px; margin-bottom: 24px;">
                <h2 style="margin: 0 0 12px 0; font-size: 15px; text-transform: uppercase; color: #102E52; letter-spacing: 0.5px;">
                  Event Details
                </h2>
                <p style="margin: 0 0 8px 0; font-size: 14px; color: #102E52;">
                  <strong>Date:</strong> ${EVENT_CONFIG.dateDisplay}
                </p>
                <p style="margin: 0 0 8px 0; font-size: 14px; color: #102E52;">
                  <strong>Venue:</strong> ${EVENT_CONFIG.venue.name}, ${EVENT_CONFIG.venue.city}
                </p>
                <p style="margin: 0; font-size: 13px; color: #5F6775;">
                  ${EVENT_CONFIG.venue.note}
                </p>
              </div>

              <!-- Important Note -->
              <p style="margin: 0 0 20px 0; font-size: 14px; color: #5F6775; line-height: 1.5;">
                Please save this email for your records. The organisers will contact you with specific hall instructions, reporting timings, and schedule details prior to the contest date.
              </p>

              <!-- Contacts -->
              <div style="padding-top: 16px; border-top: 1px solid #EBE4D5; font-size: 13px; color: #5F6775;">
                <p style="margin: 0 0 4px 0; font-weight: 600; color: #102E52;">Questions or Assistance?</p>
                <p style="margin: 0;">${contactsHtml}</p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F3EDE2; padding: 20px 30px; text-align: center; font-size: 12px; color: #5F6775;">
              <p style="margin: 0 0 4px 0;">Presented by <strong>Salem Parenting Club</strong> &amp; <strong>Speak Up Salem Toastmasters Club</strong></p>
              <p style="margin: 0;">This is an automated confirmation of your contest registration.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  const text = `
${EVENT_CONFIG.name}
${isFree ? 'Registration Confirmed (Complimentary)' : 'Registration & Payment Confirmed'}

Dear ${fullName},

${isFree
  ? `Thank you for registering for ${EVENT_CONFIG.name}. Your complimentary registration is confirmed.`
  : `Thank you for registering for ${EVENT_CONFIG.name}. Your payment of ₹${amountRupees} has been verified and your registration is confirmed.`}

REGISTRATION REFERENCE: ${registration.reference}
Participant: ${fullName}
Category: ${categorySlug.toUpperCase()}
${breakdownText.trim()}

BOOKING DETAILS & RECEIPT:
${bookingUrl}

${renderWhatsAppEmailSectionText({
  heading: 'Join Our Official WhatsApp Group',
  content: 'Your payment has been verified. Join our official WhatsApp group to receive contest announcements and important participant instructions.',
  buttonText: 'Join WhatsApp Group',
  url: WHATSAPP_GROUP_INVITE_URL
})}

EVENT DETAILS:
Date: ${EVENT_CONFIG.dateDisplay}
Venue: ${EVENT_CONFIG.venue.name}, ${EVENT_CONFIG.venue.city}
${EVENT_CONFIG.venue.note}

Please retain this reference for registration on contest day.

Organiser Contacts:
${contactsText}

Presented by Salem Parenting Club & Speak Up Salem Toastmasters Club
  `.trim();

  return { html, text };
}

/**
 * Sends a payment confirmation email, ensuring idempotent delivery and recording attempts.
 */
export async function sendPaymentConfirmationEmail({ registration, payment, force = false }) {
  // Check if confirmation already sent to avoid duplicate emails. `force` is set
  // only by an administrator deliberately resending from the dashboard, where
  // the duplicate is the point; the automatic paths never set it.
  const existingDelivery = force
    ? null
    : await prisma.emailDelivery.findFirst({
        where: {
          registrationId: registration.id,
          emailType: 'PAYMENT_CONFIRMATION',
          status: 'SENT'
        }
      });

  if (existingDelivery) {
    return { skipped: true, reason: 'Already sent' };
  }

  const deliveryId = crypto.randomUUID();
  const subject = `Registration Confirmed: ${EVENT_CONFIG.shortName} (${registration.reference})`;
  const { html, text } = generateConfirmationEmailContent({ registration, payment });

  // Record initial pending state in DB
  const delivery = await prisma.emailDelivery.create({
    data: {
      id: deliveryId,
      registrationId: registration.id,
      registrationReference: registration.reference,
      recipientEmail: registration.email,
      emailType: 'PAYMENT_CONFIRMATION',
      subject,
      status: 'PENDING',
      attemptCount: 1,
      lastAttemptAt: new Date()
    }
  });

  const transporter = getTransporter();
  if (!transporter) {
    // If SMTP credentials not provided (e.g. dev/test without SMTP), record simulated delivery
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        errorMessage: 'Simulated delivery (SMTP credentials not configured)'
      }
    });
    return { success: true, simulated: true };
  }

  try {
    const mailOptions = {
      from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>`,
      to: registration.email,
      replyTo: env.MAIL_REPLY_TO,
      subject,
      text,
      html
    };

    const info = await transporter.sendMail(mailOptions);

    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT'
      }
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const safeError = err.message ? err.message.slice(0, 255) : 'Unknown SMTP delivery error';
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        errorMessage: safeError
      }
    });
    return { success: false, error: safeError };
  }
}

export async function sendPasswordResetEmail({ toEmail, name, resetLink }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { accepted: false, simulated: true };
  }
  try {
    const info = await transporter.sendMail({
      from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>`,
      to: toEmail,
      subject: 'Salem Star Speaker Admin - Password Reset',
      text: `Hello ${name},\n\nA password reset request was initiated for your Salem Star Speaker admin account.\n\nPlease visit the following link to set a new password:\n${resetLink}\n\nThis link is single-use and will expire in 24 hours.\n\nIf you did not request this, please contact your administrator.`,
      html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #102E52;">
        <h2>Salem Star Speaker — Admin Password Reset</h2>
        <p>Hello ${name},</p>
        <p>A password reset request was initiated for your Salem Star Speaker admin account.</p>
        <p style="margin: 24px 0;">
          <a href="${resetLink}" style="background-color: #102E52; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">Set New Password</a>
        </p>
        <p style="color: #666; font-size: 13px;">If the button does not work, copy and paste this link into your browser:<br/><a href="${resetLink}">${resetLink}</a></p>
        <p style="color: #666; font-size: 12px;">This link is single-use and valid for 24 hours.</p>
      </div>`
    });
    return { accepted: true, messageId: info.messageId };
  } catch (err) {
    console.error('[EMAIL] Failed to send password reset email:', err.message);
    return { accepted: false, error: err.message };
  }
}

/**
 * Generates polished HTML & plain-text payment invitation emails for shortlisted participants.
 */
export function generatePaymentInvitationEmailContent({ registration, invitation, paymentUrl, expiryDateDisplay }) {
  const feeRupees = ((invitation.amountPaise || registration.amountPaise) / 100).toFixed(0);
  const fullName = registration.fullName || registration.full_name;
  const categorySlug = (registration.categorySlug || registration.category_slug || '').toLowerCase();
  const categoryName = categorySlug === 'kid' ? 'Kids / Junior (10–13 years)' : categorySlug === 'teen' ? 'Teens (14–17 years)' : 'Adults (18+ years)';

  const contactsHtml = EVENT_CONFIG.contacts
    .map((c) => `<strong>${c.name}:</strong> <a href="${c.tel}" style="color: #102E52; text-decoration: none;">${c.phone}</a>`)
    .join(' &nbsp;|&nbsp; ');
  const contactsText = EVENT_CONFIG.contacts
    .map((c) => `${c.name}: ${c.phone}`)
    .join(' | ');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Invitation — ${EVENT_CONFIG.name}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #102E52; line-height: 1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FAF7F1; padding: 30px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(16, 46, 82, 0.08); border: 1px solid #EBE4D5;">
          
          <!-- Header -->
          <tr>
            <td style="background-color: #102E52; padding: 36px 30px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                ${EVENT_CONFIG.shortName}
              </h1>
              <p style="margin: 6px 0 0 0; color: #E7C27A; font-size: 14px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">
                Application Shortlisted · Payment Invitation
              </p>
            </td>
          </tr>

          <!-- Hero Details -->
          <tr>
            <td style="padding: 30px;">
              <p style="margin: 0 0 16px 0; font-size: 17px; color: #102E52;">
                Dear <strong>${fullName}</strong>,
              </p>
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151; line-height: 1.6;">
                Congratulations! We are delighted to inform you that your application for <strong>${EVENT_CONFIG.name}</strong> has been successfully reviewed and <strong>shortlisted</strong> by the organizing committee.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; color: #374151; line-height: 1.6;">
                To confirm your participant slot for the contest, please complete your registration fee payment using your secure personal invitation link below.
              </p>

              <!-- Application Summary Box -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px; background-color: #F8FAFC; border-radius: 12px; border: 1px solid #E2E8F0; border-collapse: collapse;">
                <tr>
                  <td style="padding: 16px 20px; border-bottom: 1px solid #E2E8F0;">
                    <div style="font-size: 12px; text-transform: uppercase; color: #64748B; font-weight: 700; letter-spacing: 1px;">
                      Application Reference
                    </div>
                    <div style="font-size: 22px; font-weight: 800; color: #102E52; font-family: monospace; margin-top: 4px;">
                      ${registration.reference}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="font-size: 14px; color: #64748B; padding-bottom: 8px;">Participant</td>
                        <td style="font-size: 14px; font-weight: 600; color: #102E52; text-align: right; padding-bottom: 8px;">${fullName}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; color: #64748B; padding-bottom: 8px;">Category</td>
                        <td style="font-size: 14px; font-weight: 600; color: #102E52; text-align: right; padding-bottom: 8px;">${categoryName}</td>
                      </tr>
                      <tr>
                        <td style="font-size: 14px; font-weight: 700; color: #102E52;">Registration Fee</td>
                        <td style="font-size: 18px; font-weight: 800; color: #102E52; text-align: right;">₹${feeRupees}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Call to Action Button -->
              <div style="text-align: center; margin: 30px 0 24px 0;">
                <a href="${paymentUrl}" style="background-color: #102E52; color: #FFFFFF; font-size: 16px; font-weight: 700; text-decoration: none; padding: 16px 36px; border-radius: 50px; display: inline-block; box-shadow: 0 4px 14px rgba(16, 46, 82, 0.25);">
                  Pay Registration Fee · ₹${feeRupees} &rarr;
                </a>
              </div>

              <!-- Expiry & Security Notice -->
              <div style="background-color: #FEF3C7; border: 1px solid #FCD34D; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; font-size: 13px; color: #92400E; line-height: 1.5;">
                <strong>Important:</strong> This payment invitation is valid until <strong>${expiryDateDisplay}</strong>. Slots are limited. Please complete payment before expiry to guarantee your participation.
              </div>

              <p style="margin: 0 0 20px 0; font-size: 13px; color: #64748B; line-height: 1.5;">
                <em>Security Notice:</em> This is a private, unique payment link generated specifically for your application. Please do not forward or share this link with anyone else.
              </p>

              <!-- Official WhatsApp Group Invitation (Stage D) -->
              ${renderWhatsAppEmailSectionHtml({
                heading: 'Keep Up With Contest Updates',
                content: 'Join our official WhatsApp group for contest announcements and important participant instructions.',
                buttonText: 'Join WhatsApp Group',
                url: WHATSAPP_GROUP_INVITE_URL
              })}

              <!-- Event Details Box -->
              <div style="background-color: #FAF7F1; padding: 20px; border-radius: 12px; margin-bottom: 24px;">
                <h2 style="margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; color: #102E52; letter-spacing: 0.5px;">
                  Event Information
                </h2>
                <p style="margin: 0 0 6px 0; font-size: 14px; color: #102E52;">
                  <strong>Contest Date:</strong> ${EVENT_CONFIG.dateDisplay}
                </p>
                <p style="margin: 0 0 6px 0; font-size: 14px; color: #102E52;">
                  <strong>Venue:</strong> ${EVENT_CONFIG.venue.name}, ${EVENT_CONFIG.venue.city}
                </p>
                <p style="margin: 0; font-size: 13px; color: #64748B;">
                  ${EVENT_CONFIG.venue.note}
                </p>
              </div>

              <!-- Contacts -->
              <div style="padding-top: 16px; border-top: 1px solid #EBE4D5; font-size: 13px; color: #5F6775;">
                <p style="margin: 0 0 4px 0; font-weight: 600; color: #102E52;">Questions or Assistance?</p>
                <p style="margin: 0;">${contactsHtml}</p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F3EDE2; padding: 20px 30px; text-align: center; font-size: 12px; color: #5F6775;">
              <p style="margin: 0 0 4px 0;">Presented by <strong>Salem Parenting Club</strong> &amp; <strong>Speak Up Salem Toastmasters Club</strong></p>
              <p style="margin: 0;">Salem Star Speaker — Official Payment Invitation</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  const text = `
${EVENT_CONFIG.name}
Application Shortlisted · Payment Invitation

Dear ${fullName},

Congratulations! Your application for ${EVENT_CONFIG.name} has been reviewed and shortlisted by the organizing committee.

APPLICATION DETAILS:
- Reference: ${registration.reference}
- Participant: ${fullName}
- Category: ${categoryName}
- Registration Fee: ₹${feeRupees}
- Valid Until: ${expiryDateDisplay}

To confirm your spot, please pay the entry fee using your private payment link:
${paymentUrl}

Important: This is a private link issued specifically for your application. Please do not share or forward this link.

${renderWhatsAppEmailSectionText({
  heading: 'Keep Up With Contest Updates',
  content: 'Join our official WhatsApp group for contest announcements and important participant instructions.',
  buttonText: 'Join WhatsApp Group',
  url: WHATSAPP_GROUP_INVITE_URL
})}

EVENT DETAILS:
- Date: ${EVENT_CONFIG.dateDisplay}
- Venue: ${EVENT_CONFIG.venue.name}, ${EVENT_CONFIG.venue.city}

Questions or Assistance?
${contactsText}
  `.trim();

  return { html, text };
}

/**
 * Dispatches the payment invitation email and records delivery outcome in both
 * EmailDelivery and PaymentInvitation records.
 */
export async function sendPaymentInvitationEmail({ registration, invitation, paymentUrl }) {
  const deliveryId = crypto.randomUUID();
  const subject = `You have been shortlisted! Complete your registration — ${EVENT_CONFIG.shortName} (${registration.reference})`;
  const expiryDateDisplay = invitation.expiresAt
    ? new Date(invitation.expiresAt).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      })
    : EVENT_CONFIG.deadlineDisplay;

  const { html, text } = generatePaymentInvitationEmailContent({
    registration,
    invitation,
    paymentUrl,
    expiryDateDisplay
  });

  const delivery = await prisma.emailDelivery.create({
    data: {
      id: deliveryId,
      registrationId: registration.id,
      registrationReference: registration.reference,
      recipientEmail: registration.email,
      emailType: 'PAYMENT_INVITATION',
      subject,
      status: 'PENDING',
      attemptCount: 1,
      lastAttemptAt: new Date()
    }
  });

  const transporter = getTransporter();
  if (!transporter) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        errorMessage: 'Simulated delivery (SMTP credentials not configured)'
      }
    });
    await prisma.paymentInvitation.update({
      where: { id: invitation.id },
      data: {
        status: 'SENT',
        deliveryStatus: 'SENT',
        sentAt: new Date(),
        deliveryError: 'Simulated delivery (SMTP credentials not configured)'
      }
    });
    return { success: true, simulated: true };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>`,
      to: registration.email,
      replyTo: env.MAIL_REPLY_TO,
      subject,
      text,
      html
    });

    await Promise.all([
      prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SENT' }
      }),
      prisma.paymentInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'SENT',
          deliveryStatus: 'SENT',
          sentAt: new Date(),
          deliveryError: null
        }
      })
    ]);

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const safeError = err.message ? err.message.slice(0, 255) : 'Unknown SMTP delivery error';
    await Promise.all([
      prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', errorMessage: safeError }
      }),
      prisma.paymentInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'FAILED',
          deliveryStatus: 'FAILED',
          deliveryError: safeError
        }
      })
    ]);
    return { success: false, error: safeError };
  }
}

/**
 * Generates polished HTML & plain-text registration acknowledgement emails.
 */
export function generateAcknowledgementEmailContent({ registration }) {
  const rawName = registration.fullName || registration.full_name || 'Participant';
  const participantName = escapeHtml(rawName);
  const rawReference = registration.reference || '';
  const applicationReference = escapeHtml(rawReference);

  const text = `
Dear ${rawName},

Thank you for registering for the Salem Star Speaker Contest!

We have successfully received your application. Your application reference number is ${rawReference}.

What happens next?
Your application will be reviewed by the contest organisers. Registration does not guarantee shortlisting or participation in the finals. If you are shortlisted, you will receive a separate email with instructions for completing the registration fee payment.

${renderWhatsAppEmailSectionText({
  heading: 'Stay Connected on WhatsApp',
  content: 'Join our official WhatsApp group to stay informed about important announcements, contest updates, and participant instructions.',
  buttonText: 'Join WhatsApp Group',
  url: WHATSAPP_GROUP_INVITE_URL
})}

Important dates:
- Registration deadline: Monday, 26 October 2026, at 11:59 PM.
- Online contestants' briefing and speaking order: Friday, 30 October 2026, at 8:30 PM.
- Preliminary rounds may be conducted online if registrations are high.

Please read the attached Salem Star Speaker Contest Rules and Regulations carefully. It contains important information about eligibility, speech duration, timing signals, and contest procedures.

We look forward to your participation and wish you the very best!

Regards,
Salem Star Speaker Organising Team
Salem Parenting Club | Speak Up Salem Toastmasters Club

*This email confirms receipt of your application only. It does not confirm shortlisting, finalist selection, or payment.*
  `.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registration Received — ${EVENT_CONFIG.name}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAF7F1; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #102E52; line-height: 1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FAF7F1; padding: 30px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(16, 46, 82, 0.08); border: 1px solid #EBE4D5;">
          
          <!-- Header -->
          <tr>
            <td style="background-color: #102E52; padding: 36px 30px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                ${EVENT_CONFIG.shortName}
              </h1>
              <p style="margin: 6px 0 0 0; color: #E7C27A; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">
                Application Received · Awaiting Review
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 30px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; color: #102E52;">
                Dear <strong>${participantName}</strong>,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #374151; line-height: 1.6;">
                Thank you for registering for the <strong>Salem Star Speaker Contest</strong>!
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; color: #374151; line-height: 1.6;">
                We have successfully received your application. Your application reference number is:
              </p>

              <!-- Reference Box -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px; background-color: #F8FAFC; border-radius: 12px; border: 1px solid #E2E8F0; text-align: center;">
                <tr>
                  <td style="padding: 18px 20px;">
                    <div style="font-size: 12px; text-transform: uppercase; color: #64748B; font-weight: 700; letter-spacing: 1px;">
                      Application Reference Number
                    </div>
                    <div style="font-size: 24px; font-weight: 800; color: #102E52; font-family: monospace; margin-top: 6px; letter-spacing: 1px;">
                      ${applicationReference}
                    </div>
                  </td>
                </tr>
              </table>

              <!-- What happens next -->
              <h3 style="margin: 24px 0 10px 0; font-size: 16px; color: #102E52; font-weight: 700;">
                What happens next?
              </h3>
              <p style="margin: 0 0 20px 0; font-size: 14px; color: #4B5563; line-height: 1.6;">
                Your application will be reviewed by the contest organisers. Registration does not guarantee shortlisting or participation in the finals. If you are shortlisted, you will receive a separate email with instructions for completing the registration fee payment.
              </p>

              <!-- Important dates -->
              <div style="background-color: #FAF5EA; border-left: 4px solid #E2B144; border-radius: 6px; padding: 16px 18px; margin-bottom: 24px;">
                <h4 style="margin: 0 0 10px 0; font-size: 14px; color: #102E52; font-weight: 700;">
                  Important Dates:
                </h4>
                <ul style="margin: 0; padding-left: 20px; font-size: 13.5px; color: #374151; line-height: 1.6;">
                  <li style="margin-bottom: 6px;"><strong>Registration deadline:</strong> Monday, 26 October 2026, at 11:59 PM.</li>
                  <li style="margin-bottom: 6px;"><strong>Online contestants&apos; briefing and speaking order:</strong> Friday, 30 October 2026, at 8:30 PM.</li>
                  <li>Preliminary rounds may be conducted online if registrations are high.</li>
                </ul>
              </div>

              <!-- Official WhatsApp Group Invitation (Stage B) -->
              ${renderWhatsAppEmailSectionHtml({
                heading: 'Stay Connected on WhatsApp',
                content: 'Join our official WhatsApp group to stay informed about important announcements, contest updates, and participant instructions.',
                buttonText: 'Join WhatsApp Group',
                url: WHATSAPP_GROUP_INVITE_URL
              })}

              <!-- Attachment Callout -->
              <div style="background-color: #F0F4F8; border-radius: 10px; border: 1px solid #D5E1ED; padding: 14px 16px; margin-bottom: 24px;">
                <p style="margin: 0; font-size: 13.5px; color: #102E52; line-height: 1.5;">
                  📎 <strong>Attached:</strong> Please read the attached <em>Salem Star Speaker Contest Rules and Regulations</em> carefully. It contains important information about eligibility, speech duration, timing signals, and contest procedures.
                </p>
              </div>

              <p style="margin: 0 0 20px 0; font-size: 14.5px; color: #374151; line-height: 1.6;">
                We look forward to your participation and wish you the very best!
              </p>

              <!-- Sign-off -->
              <p style="margin: 0 0 4px 0; font-size: 14px; color: #4B5563;">
                Regards,
              </p>
              <p style="margin: 0; font-size: 14px; font-weight: 700; color: #102E52;">
                Salem Star Speaker Organising Team
              </p>
              <p style="margin: 2px 0 0 0; font-size: 13px; color: #6B7280;">
                Salem Parenting Club | Speak Up Salem Toastmasters Club
              </p>

            </td>
          </tr>

          <!-- Footer Disclaimer -->
          <tr>
            <td style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 18px 30px; text-align: center; font-size: 12px; color: #64748B; font-style: italic;">
              This email confirms receipt of your application only. It does not confirm shortlisting, finalist selection, or payment.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return { html, text, subject: 'Registration Received — Salem Star Speaker Contest' };
}

/**
 * Sends a registration acknowledgement email with the Contest Rules PDF attached.
 */
export async function sendRegistrationAcknowledgementEmail({ registration, force = false }) {
  if (!registration || !registration.email) {
    return { skipped: true, reason: 'No recipient email' };
  }

  // Check if acknowledgement already sent to avoid duplicate emails unless forced
  const existingDelivery = force
    ? null
    : await prisma.emailDelivery.findFirst({
        where: {
          registrationId: registration.id,
          emailType: 'REGISTRATION_ACKNOWLEDGEMENT',
          status: 'SENT'
        }
      });

  if (existingDelivery) {
    return { skipped: true, reason: 'Already sent' };
  }

  const deliveryId = crypto.randomUUID();
  const { html, text, subject } = generateAcknowledgementEmailContent({ registration });

  // Record initial pending state in DB
  const delivery = await prisma.emailDelivery.create({
    data: {
      id: deliveryId,
      registrationId: registration.id,
      registrationReference: registration.reference,
      recipientEmail: registration.email,
      emailType: 'REGISTRATION_ACKNOWLEDGEMENT',
      subject,
      status: 'PENDING',
      attemptCount: 1,
      lastAttemptAt: new Date()
    }
  });

  const attachments = [];
  const pdfPath = getRulesPdfPath();
  if (pdfPath && fs.existsSync(pdfPath)) {
    attachments.push({
      filename: 'Salem-Star-Speaker-Contest-Rules.pdf',
      path: pdfPath,
      contentType: 'application/pdf'
    });
  } else {
    console.warn('[EMAIL] Salem-Star-Speaker-Contest-Rules.pdf not found in assets, sending email without attachment');
  }

  const transporter = getTransporter();
  if (!transporter) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SENT',
        errorMessage: 'Simulated delivery (SMTP credentials not configured)'
      }
    });
    return { success: true, simulated: true, hasAttachment: attachments.length > 0 };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>`,
      to: registration.email,
      replyTo: env.MAIL_REPLY_TO,
      subject,
      text,
      html,
      attachments
    });

    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT' }
    });

    return { success: true, messageId: info.messageId, hasAttachment: attachments.length > 0 };
  } catch (err) {
    const safeError = err.message ? err.message.slice(0, 255) : 'Unknown SMTP delivery error';
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        errorMessage: safeError
      }
    });
    return { success: false, error: safeError, hasAttachment: attachments.length > 0 };
  }
}



