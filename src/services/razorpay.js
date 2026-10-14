import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env.js';

let razorpayInstance = null;

export function getRazorpayClient() {
  if (!razorpayInstance) {
    if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
      razorpayInstance = new Razorpay({
        key_id: env.RAZORPAY_KEY_ID,
        key_secret: env.RAZORPAY_KEY_SECRET
      });
    }
  }
  return razorpayInstance;
}

export function setRazorpayClient(client) {
  razorpayInstance = client;
}

/**
 * Creates a Razorpay Order on the server.
 */
export async function createRazorpayOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
  const rzp = getRazorpayClient();
  if (!rzp) {
    throw new Error('Razorpay credentials not configured on the server.');
  }

  const options = {
    amount: amountPaise,
    currency,
    receipt,
    notes
  };

  const order = await rzp.orders.create(options);
  return order;
}

/**
 * Verifies Razorpay checkout payment signature.
 */
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) {
    return false;
  }

  const secret = env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    throw new Error('Razorpay key secret not configured on the server.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');

  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * Verifies Razorpay webhook signature against the raw request body.
 */
export function verifyWebhookSignature({ rawBody, signature }) {
  if (!rawBody || !signature) {
    return false;
  }

  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('Razorpay webhook secret not configured on the server.');
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');

  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
