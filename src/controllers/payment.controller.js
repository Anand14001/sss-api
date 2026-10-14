import { verifyPayment, processWebhookEvent } from '../services/registration.js';
import { verifyWebhookSignature } from '../services/razorpay.js';

export async function verifyPaymentHandler(req, res, next) {
  try {
    const {
      registrationReference,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    const result = await verifyPayment({
      registrationReference,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function webhookHandler(req, res, next) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody;

    if (!signature || !rawBody) {
      return res.status(400).json({
        success: false,
        error: 'Missing webhook signature or raw body'
      });
    }

    // Verify webhook signature
    const isValid = verifyWebhookSignature({ rawBody, signature });
    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook signature'
      });
    }

    // Process event idempotently
    const outcome = await processWebhookEvent(req.body);
    res.json({
      status: 'ok',
      ...outcome
    });
  } catch (err) {
    next(err);
  }
}
