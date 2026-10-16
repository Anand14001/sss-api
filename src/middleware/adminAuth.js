import {
  SESSION_COOKIE,
  resolveSession,
  verifyCsrf
} from '../services/adminAuth.js';

/**
 * Server-side authentication for every /api/v1/admin route.
 *
 * This is the authorisation boundary. The dashboard also hides pages it cannot
 * use, but that is a courtesy to the operator — it is not what keeps anyone
 * out. Every protected handler sits behind this function.
 */
export async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = await resolveSession(token);

    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Your session has expired. Please sign in again.',
        code: 'SESSION_EXPIRED'
      });
    }

    // Double-submit CSRF check on anything that changes state. GET and HEAD are
    // exempt because they must not change state in the first place.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!verifyCsrf(session, req.headers['x-csrf-token'])) {
        return res.status(403).json({
          success: false,
          error: 'Request could not be verified. Please refresh and try again.',
          code: 'CSRF_FAILED'
        });
      }
    }

    req.admin = session.adminUser;
    req.adminSession = session;
    req.adminSessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Blocks ordinary dashboard work until the bootstrap password has been
 * replaced. Applied after requireAdmin, and deliberately not applied to the
 * password-change and logout routes themselves.
 */
export function requirePasswordChanged(req, res, next) {
  if (req.admin?.mustChangePassword) {
    return res.status(403).json({
      success: false,
      error: 'You must set a new password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED'
    });
  }
  next();
}

/**
 * Role-based authorization middleware.
 * Ensures the authenticated admin user has one of the allowed roles.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.',
        code: 'UNAUTHENTICATED'
      });
    }

    if (!allowedRoles.includes(req.admin.role)) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to perform this action. Super-admin privileges required.',
        code: 'FORBIDDEN_SUPER_ADMIN_REQUIRED'
      });
    }

    next();
  };
}

export const requireSuperAdmin = requireRole('SUPER_ADMIN');

