import { Router } from 'express';
import { getHealth, getPublicEventConfig } from '../controllers/event.controller.js';
import {
  createRegistrationHandler,
  getRegistrationStatusHandler,
  retryPaymentHandler,
  applyCouponHandler,
  removeCouponHandler
} from '../controllers/registration.controller.js';
import { validateCouponHandler } from '../controllers/coupon.controller.js';
import { verifyPaymentHandler, webhookHandler } from '../controllers/payment.controller.js';
import {
  registrationLimiter,
  paymentLimiter,
  generalLimiter,
  couponLimiter,
  applyCouponLimiter
} from '../middleware/rateLimiter.js';

const router = Router();

// Health check (not rate-limited)
router.get('/health', getHealth);

// Public event & category config
router.get('/event', generalLimiter, getPublicEventConfig);

// Coupon validation preview
router.post('/coupons/validate', couponLimiter, validateCouponHandler);

// Registrations
router.post('/registrations', registrationLimiter, createRegistrationHandler);
router.get('/registrations/:reference/status', generalLimiter, getRegistrationStatusHandler);
router.post('/registrations/:reference/retry-payment', paymentLimiter, retryPaymentHandler);
router.post('/registrations/:reference/apply-coupon', applyCouponLimiter, applyCouponHandler);
router.delete('/registrations/:reference/coupon', applyCouponLimiter, removeCouponHandler);

// Payments
router.post('/payments/verify', paymentLimiter, verifyPaymentHandler);
router.post('/payments/webhook', webhookHandler);

export default router;
