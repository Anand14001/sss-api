import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { EVENT_CONFIG } from '../config/event.js';
import { prisma } from '../db/prisma.js';

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
  const amountRupees = ((payment.amountPaise || payment.amount_paise) / 100).toFixed(0);
  const contactsHtml = EVENT_CONFIG.contacts
    .map((c) => `<strong>${c.name}:</strong> <a href="${c.tel}" style="color: #102E52; text-decoration: none;">${c.phone}</a>`)
    .join(' &nbsp;|&nbsp; ');
  const contactsText = EVENT_CONFIG.contacts
    .map((c) => `${c.name}: ${c.phone}`)
    .join(' | ');

  const fullName = registration.fullName || registration.full_name;
  const categorySlug = registration.categorySlug || registration.category_slug;
  const paymentId = payment.razorpayPaymentId || payment.razorpay_payment_id || 'Verified';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Registration & Payment Confirmed — ${EVENT_CONFIG.name}</title>
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
                Registration & Payment Confirmed
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
                We are thrilled to confirm your registration for <strong>${EVENT_CONFIG.name}</strong>. Your payment has been received successfully.
              </p>

              <!-- Reference Badge -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px; background-color: #F3EDE2; border-radius: 12px; border: 1px solid #E5DCCB;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <div style="font-size: 12px; text-transform: uppercase; color: #A8781F; font-weight: 700; letter-spacing: 1px;">
                      Registration Reference
                    </div>
                    <div style="font-size: 24px; font-weight: 800; color: #102E52; letter-spacing: 0.5px; margin-top: 4px;">
                      ${registration.reference}
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
                <tr style="border-bottom: 1px solid #F0EAE1;">
                  <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Amount Paid</td>
                  <td style="padding: 10px 0; font-size: 14px; font-weight: 700; color: #102E52; text-align: right;">₹${amountRupees}</td>
                </tr>
                <tr style="border-bottom: 1px solid #F0EAE1;">
                  <td style="padding: 10px 0; font-size: 14px; color: #5F6775;">Payment ID</td>
                  <td style="padding: 10px 0; font-size: 14px; font-family: monospace; color: #5F6775; text-align: right;">${paymentId}</td>
                </tr>
              </table>

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
Registration & Payment Confirmed

Dear ${fullName},

Thank you for registering for ${EVENT_CONFIG.name}. Your payment of ₹${amountRupees} has been verified and your registration is confirmed.

REGISTRATION REFERENCE: ${registration.reference}
Participant: ${fullName}
Category: ${categorySlug.toUpperCase()}
Amount Paid: ₹${amountRupees}
Payment ID: ${paymentId}

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
export async function sendPaymentConfirmationEmail({ registration, payment }) {
  // Check if confirmation already sent to avoid duplicate emails
  const existingDelivery = await prisma.emailDelivery.findFirst({
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
