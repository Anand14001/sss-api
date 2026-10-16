import dotenv from 'dotenv';
dotenv.config();

/**
 * Validates and exposes server-side environment variables.
 * Sensitive secrets are never exposed to clients or logged.
 */

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '4000', 10),

  // PostgreSQL Database via Prisma ORM
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Razorpay credentials
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  // SMTP Mail credentials
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '465', 10),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || 'Salem Star Speaker',
  MAIL_FROM_ADDRESS: process.env.MAIL_FROM_ADDRESS || 'noreply@salemstarspeaker.com',
  MAIL_REPLY_TO: process.env.MAIL_REPLY_TO || 'vivek@salemstarspeaker.com',

  // Admin dashboard session cookies.
  // SameSite must be 'none' when the dashboard is served from a different
  // origin than the API, which also forces Secure (and therefore HTTPS).
  ADMIN_COOKIE_SAMESITE: (process.env.ADMIN_COOKIE_SAMESITE || 'lax').toLowerCase(),
  ADMIN_COOKIE_DOMAIN: process.env.ADMIN_COOKIE_DOMAIN || '',

  // One-time administrator bootstrap, read by prisma/seedAdmin.js only.
  // Never referenced by a request handler and never returned to a client.
  ADMIN_BOOTSTRAP_EMAIL: process.env.ADMIN_BOOTSTRAP_EMAIL || '',
  ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD || '',
  ADMIN_BOOTSTRAP_NAME: process.env.ADMIN_BOOTSTRAP_NAME || 'Event Administrator',

  // Security and CORS
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [
        'https://opt.eventsinfinite.com',
        'https://sss.eventsinfinite.com',
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173'
      ],

  // Public frontend URL for booking links in emails
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://sss.eventsinfinite.com',

  // Admin dashboard URL for password reset and invitation links
  ADMIN_URL:
    process.env.ADMIN_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://opt.eventsinfinite.com'
      : 'http://localhost:5173'),

  // Coupon reservation TTL and background sweeper interval (minutes)
  COUPON_RESERVATION_TTL_MINUTES: parseInt(process.env.COUPON_RESERVATION_TTL_MINUTES || '30', 10),
  COUPON_SWEEPER_INTERVAL_MINUTES: parseInt(process.env.COUPON_SWEEPER_INTERVAL_MINUTES || '0', 10)
};

/**
 * Checks if required production configuration is in place.
 */
export function validateProductionConfig() {
  const missing = [];
  if (env.NODE_ENV === 'production') {
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID');
    if (!env.RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET');
    if (!env.RAZORPAY_WEBHOOK_SECRET) missing.push('RAZORPAY_WEBHOOK_SECRET');
    // A cross-origin dashboard over SameSite=none needs HTTPS to work at all.
    if (env.ADMIN_COOKIE_SAMESITE === 'none' && !env.ALLOWED_ORIGINS.some((o) => o.startsWith('https://'))) {
      missing.push('ALLOWED_ORIGINS (https origin required for SameSite=none cookies)');
    }
  }
  return missing;
}
