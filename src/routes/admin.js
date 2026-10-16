import { Router } from 'express';
import { requireAdmin, requirePasswordChanged, requireSuperAdmin } from '../middleware/adminAuth.js';
import { loginLimiter, adminLimiter } from '../middleware/rateLimiter.js';
import {
  loginHandler,
  logoutHandler,
  meHandler,
  changePasswordHandler,
  listSessionsHandler,
  revokeOtherSessionsHandler,
  resetPasswordHandler
} from '../controllers/adminAuth.controller.js';
import {
  overviewHandler,
  trendsHandler,
  listRegistrationsHandler,
  registrationDetailHandler,
  addNoteHandler,
  cancelRegistrationHandler,
  checkInHandler,
  listPaymentsHandler,
  reconcilePaymentHandler,
  listParticipantsHandler,
  duplicatesHandler,
  categoriesHandler,
  contestHandler,
  emailDeliveriesHandler,
  resendEmailHandler,
  auditLogHandler,
  settingsHandler,
  listReportsHandler,
  exportHandler,
  filterOptionsHandler,
  listCouponsHandler,
  couponsSummaryHandler,
  createCouponHandler,
  generateCouponsHandler,
  couponDetailHandler,
  updateCouponHandler,
  pauseCouponHandler,
  resumeCouponHandler,
  deleteCouponHandler,
  archiveCouponBatchHandler,
  listCouponRedemptionsHandler,
  couponIntegrityHandler,
  sweepStaleReservationsHandler,
  listAdminUsersHandler,
  getAdminUserDetailHandler,
  createAdminUserHandler,
  updateAdminUserHandler,
  updateAdminRoleHandler,
  initiateAdminPasswordResetHandler,
  deleteAdminUserHandler
} from '../controllers/admin.controller.js';

/**
 * Admin API, mounted at /api/v1/admin.
 *
 * Three layers, in order:
 *   loginLimiter / adminLimiter — rate limiting
 *   requireAdmin               — session + CSRF; this is the auth boundary
 *   requirePasswordChanged     — blocks work while the bootstrap password stands
 *
 * Only logout, /me and the password change itself skip the third layer: an
 * administrator who must change their password still has to be able to do it.
 */
const router = Router();

// ------------------------------------------------------------------- auth
router.post('/auth/login', loginLimiter, loginHandler);
router.post('/auth/reset-password', loginLimiter, resetPasswordHandler);
router.post('/auth/logout', adminLimiter, requireAdmin, logoutHandler);
router.get('/auth/me', adminLimiter, requireAdmin, meHandler);
router.post('/auth/change-password', loginLimiter, requireAdmin, changePasswordHandler);
router.get('/auth/sessions', adminLimiter, requireAdmin, listSessionsHandler);
router.post('/auth/sessions/revoke-others', adminLimiter, requireAdmin, revokeOtherSessionsHandler);

// Everything past this point requires a fully provisioned administrator.
router.use(adminLimiter, requireAdmin, requirePasswordChanged);

// --------------------------------------------------------------- dashboard
router.get('/overview', overviewHandler);
router.get('/trends', trendsHandler);
router.get('/filters', filterOptionsHandler);

// ------------------------------------------------------------ registrations
router.get('/registrations', listRegistrationsHandler);
router.get('/registrations/:reference', registrationDetailHandler);
router.post('/registrations/:reference/notes', addNoteHandler);
router.post('/registrations/:reference/cancel', cancelRegistrationHandler);
router.post('/registrations/:reference/check-in', checkInHandler);
router.post('/registrations/:reference/resend-confirmation', resendEmailHandler);

// ------------------------------------------------------------- participants
router.get('/participants', listParticipantsHandler);
router.get('/participants/duplicates', duplicatesHandler);

// ----------------------------------------------------------------- payments
router.get('/payments', listPaymentsHandler);
router.post('/payments/:orderId/reconcile', reconcilePaymentHandler);

// --------------------------------------------------- categories and contest
router.get('/categories', categoriesHandler);
router.get('/contest', contestHandler);

// ------------------------------------------------------------ communication
router.get('/emails', emailDeliveriesHandler);

// ---------------------------------------------------------- audit, reports
router.get('/audit', auditLogHandler);
router.get('/reports', listReportsHandler);
router.get('/reports/:reportId/export', exportHandler);

// ------------------------------------------------------------------ coupons
router.get('/coupons', listCouponsHandler);
router.get('/coupons/summary', couponsSummaryHandler);
router.post('/coupons', createCouponHandler);
router.post('/coupons/generate', generateCouponsHandler);
router.get('/coupons/integrity', couponIntegrityHandler);
router.post('/coupons/maintenance/release-stale', sweepStaleReservationsHandler);
router.post('/coupons/batches/:batchId/archive', archiveCouponBatchHandler);
router.get('/coupons/:id', couponDetailHandler);
router.patch('/coupons/:id', updateCouponHandler);
router.post('/coupons/:id/pause', pauseCouponHandler);
router.post('/coupons/:id/resume', resumeCouponHandler);
router.delete('/coupons/:id', deleteCouponHandler);
router.get('/coupons/:id/redemptions', listCouponRedemptionsHandler);

// --------------------------------------------------------------- settings
router.get('/settings', settingsHandler);

// -------------------------------------------------------- users
router.get('/users', listAdminUsersHandler);
router.post('/users', createAdminUserHandler);
router.get('/users/:id', getAdminUserDetailHandler);
router.patch('/users/:id', updateAdminUserHandler);
router.patch('/users/:id/role', updateAdminRoleHandler);
router.post('/users/:id/reset-password', initiateAdminPasswordResetHandler);
router.delete('/users/:id', deleteAdminUserHandler);

export default router;
