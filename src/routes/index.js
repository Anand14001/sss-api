import { Router } from 'express';
import { getHealth, getPublicEventConfig } from '../controllers/event.controller.js';
import {
  createRegistrationHandler,
  createApplicationHandler,
  getRegistrationStatusHandler,
  retryPaymentHandler,
  applyCouponHandler,
  removeCouponHandler,
  getInvitationHandler,
  createInvitationOrderHandler,
  applyInvitationCouponHandler,
  removeInvitationCouponHandler
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

// Applications & Registrations
router.post('/applications', registrationLimiter, createApplicationHandler);
router.get('/applications/:reference/status', generalLimiter, getRegistrationStatusHandler);
router.post('/registrations', registrationLimiter, createRegistrationHandler);
router.get('/registrations/:reference/status', generalLimiter, getRegistrationStatusHandler);
router.post('/registrations/:reference/retry-payment', paymentLimiter, retryPaymentHandler);
router.post('/registrations/:reference/apply-coupon', applyCouponLimiter, applyCouponHandler);
router.delete('/registrations/:reference/coupon', applyCouponLimiter, removeCouponHandler);

// Participant Payment Invitation Routes (/pay/:token)
router.get('/invitations/:token', generalLimiter, getInvitationHandler);
router.post('/invitations/:token/checkout', paymentLimiter, createInvitationOrderHandler);
router.post('/invitations/:token/apply-coupon', applyCouponLimiter, applyInvitationCouponHandler);
router.delete('/invitations/:token/coupon', applyCouponLimiter, removeInvitationCouponHandler);

// Payments
router.post('/payments/verify', paymentLimiter, verifyPaymentHandler);
router.post('/payments/webhook', webhookHandler);

export default router;

