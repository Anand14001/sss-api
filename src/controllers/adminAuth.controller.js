import { prisma } from '../db/prisma.js';
import {
  SESSION_COOKIE,
  clearSessionCookies,
  createSession,
  hashPassword,
  isLockedOut,
  recordFailedLogin,
  recordSuccessfulLogin,
  revokeAllSessionsFor,
  revokeSession,
  validatePassword,
  verifyPassword,
  clientIp,
  PASSWORD_RULES,
  consumePasswordResetToken
} from '../services/adminAuth.js';
import { recordAudit, auditFromRequest, AUDIT_ACTIONS } from '../services/audit.js';

/**
 * One message for every failed sign-in, whatever the cause.
 *
 * Saying "no such account" or "wrong password" would let anyone enumerate which
 * email addresses are administrators. The operator loses nothing: if they are
 * the real administrator, both answers mean the same thing to them.
 */
const GENERIC_LOGIN_FAILURE = 'Email or password is incorrect.';

function publicAdmin(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt
  };
}

export async function loginHandler(req, res, next) {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Enter both your email address and password.',
        code: 'MISSING_CREDENTIALS'
      });
    }

    const user = await prisma.adminUser.findUnique({ where: { email } });

    if (!user || !user.isActive) {
      // Still spend time hashing: returning instantly for an unknown address
      // tells an attacker the address is unknown.
      await verifyPassword(password, 'scrypt$32768$8$1$AAAA$AAAA');
      await recordAudit({
        actorEmail: email,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        outcome: 'FAILURE',
        metadata: { reason: 'unknown_or_inactive_account' },
        ipAddress: clientIp(req)
      });
      return res.status(401).json({ success: false, error: GENERIC_LOGIN_FAILURE, code: 'INVALID_CREDENTIALS' });
    }

    if (isLockedOut(user)) {
      await recordAudit({
        adminUserId: user.id,
        actorEmail: email,
        action: AUDIT_ACTIONS.LOGIN_LOCKED,
        outcome: 'FAILURE',
        ipAddress: clientIp(req)
      });
      return res.status(429).json({
        success: false,
        error: 'Too many failed attempts. This account is locked for a short while.',
        code: 'ACCOUNT_LOCKED',
        retryAt: user.lockedUntil
      });
    }

    const valid = await verifyPassword(password, user.passwordHash);

    if (!valid) {
      const { locked } = await recordFailedLogin(user);
      await recordAudit({
        adminUserId: user.id,
        actorEmail: email,
        action: locked ? AUDIT_ACTIONS.LOGIN_LOCKED : AUDIT_ACTIONS.LOGIN_FAILED,
        outcome: 'FAILURE',
        ipAddress: clientIp(req)
      });
      return res.status(401).json({ success: false, error: GENERIC_LOGIN_FAILURE, code: 'INVALID_CREDENTIALS' });
    }

    await recordSuccessfulLogin(user);
    const { csrfToken } = await createSession({ adminUserId: user.id, req, res });
    await recordAudit({
      adminUserId: user.id,
      actorEmail: user.email,
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      ipAddress: clientIp(req)
    });

    const fresh = await prisma.adminUser.findUnique({ where: { id: user.id } });
    // The CSRF token is returned in the body as well as the cookie. A dashboard
    // served from a different host than this API cannot read the cookie, so the
    // body is the only way it can obtain the value it must echo back.
    res.json({ success: true, admin: publicAdmin(fresh), csrfToken });
  } catch (err) {
    next(err);
  }
}

export async function logoutHandler(req, res, next) {
  try {
    await revokeSession(req.cookies?.[SESSION_COOKIE]);
    if (req.admin) {
      await auditFromRequest(req, { action: AUDIT_ACTIONS.LOGOUT });
    }
    clearSessionCookies(res);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function meHandler(req, res) {
  res.json({
    success: true,
    admin: publicAdmin(req.admin),
    // Recovered here after a reload, when the dashboard has lost its in-memory
    // copy and cannot read the cookie cross-origin.
    csrfToken: req.adminSession.csrfToken,
    session: {
      expiresAt: req.adminSession.expiresAt,
      createdAt: req.adminSession.createdAt,
      lastSeenAt: req.adminSession.lastSeenAt
    },
    passwordRules: PASSWORD_RULES.map((r) => ({ id: r.id, label: r.label }))
  });
}

export async function changePasswordHandler(req, res, next) {
  try {
    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');

    const valid = await verifyPassword(currentPassword, req.admin.passwordHash);
    if (!valid) {
      await auditFromRequest(req, {
        action: AUDIT_ACTIONS.PASSWORD_CHANGED,
        outcome: 'FAILURE',
        metadata: { reason: 'current_password_incorrect' }
      });
      return res.status(401).json({
        success: false,
        error: 'Your current password is incorrect.',
        code: 'INVALID_CURRENT_PASSWORD'
      });
    }

    const failures = validatePassword(newPassword);
    if (failures.length) {
      return res.status(400).json({
        success: false,
        error: 'That password does not meet the requirements.',
        code: 'WEAK_PASSWORD',
        details: failures
      });
    }

    if (await verifyPassword(newPassword, req.admin.passwordHash)) {
      return res.status(400).json({
        success: false,
        error: 'Choose a password you have not used before.',
        code: 'PASSWORD_REUSED'
      });
    }

    await prisma.adminUser.update({
      where: { id: req.admin.id },
      data: {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        passwordChangedAt: new Date()
      }
    });

    // Every other session for this account is dropped. If the password was
    // changed because someone else may have had it, leaving their session alive
    // would make the change pointless. The session doing the change survives,
    // so the operator is not thrown back to the login screen.
    await revokeAllSessionsFor(req.admin.id, { exceptToken: req.adminSessionToken });

    await auditFromRequest(req, { action: AUDIT_ACTIONS.PASSWORD_CHANGED });

    const fresh = await prisma.adminUser.findUnique({ where: { id: req.admin.id } });
    res.json({ success: true, admin: publicAdmin(fresh) });
  } catch (err) {
    next(err);
  }
}

export async function listSessionsHandler(req, res, next) {
  try {
    const sessions = await prisma.adminSession.findMany({
      where: { adminUserId: req.admin.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      take: 25
    });

    res.json({
      success: true,
      sessions: sessions.map((s) => ({
        id: s.id,
        current: s.id === req.adminSession.id,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
}

export async function revokeOtherSessionsHandler(req, res, next) {
  try {
    await revokeAllSessionsFor(req.admin.id, { exceptToken: req.adminSessionToken });
    await auditFromRequest(req, { action: 'auth.sessions.revoked' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function resetPasswordHandler(req, res, next) {
  try {
    const token = String(req.body?.token ?? '').trim();
    const newPassword = String(req.body?.newPassword ?? '');

    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Reset token and new password are required.',
        code: 'MISSING_FIELDS'
      });
    }

    const updatedUser = await consumePasswordResetToken(token, newPassword);

    await recordAudit({
      adminUserId: updatedUser.id,
      actorEmail: updatedUser.email,
      action: AUDIT_ACTIONS.USER_PASSWORD_RESET_COMPLETED,
      outcome: 'SUCCESS',
      ipAddress: clientIp(req)
    });

    res.json({
      success: true,
      message: 'Password has been reset successfully. You can now sign in with your new password.'
    });
  } catch (err) {
    next(err);
  }
}

