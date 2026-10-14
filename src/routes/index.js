import { Router } from 'express';
import { getHealth, getPublicEventConfig } from '../controllers/event.controller.js';
import {
  createRegistrationHandler,
  getRegistrationStatusHandler,
  retryPaymentHandler
} from '../controllers/registration.controller.js';
import { verifyPaymentHandler, webhookHandler } from '../controllers/payment.controller.js';
import {
  registrationLimiter,
  paymentLimiter,
  generalLimiter
} from '../middleware/rateLimiter.js';

const router = Router();

// Health check (not rate-limited)
router.get('/health', getHealth);

// Public event & category config
router.get('/event', generalLimiter, getPublicEventConfig);

// Registrations
router.post('/registrations', registrationLimiter, createRegistrationHandler);
router.get('/registrations/:reference/status', generalLimiter, getRegistrationStatusHandler);
router.post('/registrations/:reference/retry-payment', paymentLimiter, retryPaymentHandler);

// Payments
router.post('/payments/verify', paymentLimiter, verifyPaymentHandler);
router.post('/payments/webhook', webhookHandler);

export default router;
