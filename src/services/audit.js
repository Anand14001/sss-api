import { prisma } from '../db/prisma.js';

/**
 * Audit trail for privileged actions.
 *
 * Append-only by construction: nothing in the codebase updates or deletes a row
 * in audit_logs, and the dashboard exposes no route that could. Writes never
 * throw into the caller — an action that succeeded must not be reported as
 * failed because the log write failed — but the failure is logged to stderr so
 * it is not silent.
 */

const SENSITIVE_KEYS = /pass|secret|token|signature|key|authorization|cookie/i;

/**
 * Strips anything that looks like a credential before it reaches the database.
 * Audit metadata is written from several call sites; a single forgetful one
 * should not be able to persist a secret.
 */
export function sanitiseMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitiseMetadata(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : sanitiseMetadata(val, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}

export async function recordAudit({
  adminUserId = null,
  actorEmail,
  action,
  entityType = null,
  entityId = null,
  outcome = 'SUCCESS',
  metadata = null,
  ipAddress = null
}) {
  try {
    await prisma.auditLog.create({
      data: {
        adminUserId,
        actorEmail: String(actorEmail || 'unknown').slice(0, 255),
        action,
        entityType,
        entityId: entityId ? String(entityId).slice(0, 255) : null,
        outcome,
        metadata: metadata ? sanitiseMetadata(metadata) : null,
        ipAddress
      }
    });
  } catch (err) {
    console.error('[AUDIT] Failed to write audit entry:', err.message);
  }
}

/** Convenience wrapper for routes that already have `req.admin` attached. */
export function auditFromRequest(req, entry) {
  return recordAudit({
    adminUserId: req.admin?.id ?? null,
    actorEmail: req.admin?.email ?? 'anonymous',
    ipAddress: req.ip ? String(req.ip).slice(0, 64) : null,
    ...entry
  });
}

export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password.changed',
  REGISTRATION_CANCELLED: 'registration.cancelled',
  REGISTRATION_NOTE_ADDED: 'registration.note.added',
  REGISTRATION_CHECKED_IN: 'registration.checkin',
  PAYMENT_RECONCILED: 'payment.reconciled',
  EMAIL_RESENT: 'email.resent',
  EXPORT_GENERATED: 'export.generated',
  COUPON_CREATED: 'coupon.created',
  COUPON_BATCH_GENERATED: 'coupon.batch.generated',
  COUPON_UPDATED: 'coupon.updated',
  COUPON_PAUSED: 'coupon.paused',
  COUPON_RESUMED: 'coupon.resumed',
  COUPON_ARCHIVED: 'coupon.archived',
  COUPON_DELETED: 'coupon.deleted',
  COUPON_BATCH_ARCHIVED: 'coupon.batch.archived',
  COUPON_RESERVATIONS_SWEPT: 'coupon.reservations.swept',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_ACTIVATED: 'user.activated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_PASSWORD_RESET_INITIATED: 'user.password_reset_initiated',
  USER_PASSWORD_RESET_COMPLETED: 'user.password_reset_completed',
  USER_DELETED: 'user.deleted'
};
