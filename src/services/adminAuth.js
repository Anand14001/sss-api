import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

const scrypt = promisify(crypto.scrypt);

/**
 * Password hashing.
 *
 * scrypt from node:crypto rather than argon2 or bcrypt. It is a memory-hard
 * KDF in the same class as those two, it is maintained as part of Node itself,
 * and — the deciding factor for this deployment — it needs no native build
 * step, which cPanel shared hosting does not reliably provide.
 *
 * Parameters follow the current OWASP minimum for scrypt (N=2^15, r=8, p=1).
 * They are stored inside the hash string, so raising them later still verifies
 * every existing password.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

export async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');

  let derived;
  try {
    derived = await scrypt(plain, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Password policy. Deliberately simple and explained to the user rather than a
 * regex wall: length does more work than character classes, but the bootstrap
 * password the organisers were given uses classes, so both are checked.
 */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 10 characters', test: (v) => v.length >= 10 },
  { id: 'lower', label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { id: 'upper', label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'digit', label: 'A number', test: (v) => /\d/.test(v) },
  { id: 'symbol', label: 'A symbol', test: (v) => /[^A-Za-z0-9]/.test(v) }
];

/**
 * `bootstrap` relaxes the length floor from 10 to 8.
 *
 * The provisioning password is a delivery mechanism, not a credential: it is
 * typed once, it is already known to whoever configured the server, and the
 * account cannot do anything until it has been replaced. The organisers asked
 * for a specific 9-character bootstrap password, which is fine for that single
 * use. The full rule still governs every password an administrator chooses —
 * which is the one that actually protects the data.
 */
export function validatePassword(value = '', { bootstrap = false } = {}) {
  if (typeof value !== 'string') return ['Password must be text.'];
  const minLength = bootstrap ? 8 : 10;
  const failed = PASSWORD_RULES.filter((rule) =>
    rule.id === 'length' ? value.length < minLength : !rule.test(value)
  ).map((r) => (r.id === 'length' ? `At least ${minLength} characters` : r.label));
  if (value.length > 200) failed.push('At most 200 characters');
  return failed;
}

// --------------------------------------------------------------------- sessions

export const SESSION_COOKIE = 'sss_admin_session';
export const CSRF_COOKIE = 'sss_admin_csrf';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const SESSION_IDLE_MS = 60 * 60 * 1000; // rolling: refresh expiry if older than this

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Cookie options.
 *
 * The dashboard is a separate origin from the API in production, so the session
 * cookie has to be SameSite=None to be sent at all — which in turn forces
 * Secure. Same-origin deployments can set ADMIN_COOKIE_SAMESITE=lax and drop
 * the CSRF surface that None reopens; the double-submit token below covers it
 * either way.
 */
function cookieOptions({ httpOnly = true, maxAge = SESSION_TTL_MS, req } = {}) {
  const sameSite = env.ADMIN_COOKIE_SAMESITE;
  const host = req ? (req.hostname || req.headers?.host || '') : '';
  const isLocal = !req || host.includes('localhost') || host.includes('127.0.0.1') || env.NODE_ENV !== 'production';

  return {
    httpOnly,
    secure: sameSite === 'none' ? true : env.NODE_ENV === 'production',
    sameSite,
    maxAge,
    path: '/',
    ...(!isLocal && env.ADMIN_COOKIE_DOMAIN ? { domain: env.ADMIN_COOKIE_DOMAIN } : {})
  };
}

export async function createSession({ adminUserId, req, res }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');

  await prisma.adminSession.create({
    data: {
      adminUserId,
      tokenHash: sha256(token),
      csrfToken,
      userAgent: (req.headers['user-agent'] || '').slice(0, 255) || null,
      ipAddress: clientIp(req),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS)
    }
  });

  res.cookie(SESSION_COOKIE, token, cookieOptions({ req }));
  // Still set as a readable cookie, which is all a same-origin deployment
  // needs. It is NOT sufficient on its own when the dashboard is on a
  // different host from the API: this cookie is host-only to the API's domain,
  // so script on the dashboard's origin cannot read it. That is why the token
  // is also returned in the login and /auth/me response bodies, and why the
  // dashboard prefers the value it was handed over the one in the cookie.
  res.cookie(CSRF_COOKIE, csrfToken, cookieOptions({ httpOnly: false, req }));

  return { token, csrfToken };
}

export function clearSessionCookies(res, req) {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions({ req }), maxAge: undefined });
  res.clearCookie(CSRF_COOKIE, { ...cookieOptions({ httpOnly: false, req }), maxAge: undefined });
}

export async function revokeSession(token) {
  if (!token) return;
  await prisma.adminSession.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function revokeAllSessionsFor(adminUserId, { exceptToken } = {}) {
  await prisma.adminSession.updateMany({
    where: {
      adminUserId,
      revokedAt: null,
      ...(exceptToken ? { NOT: { tokenHash: sha256(exceptToken) } } : {})
    },
    data: { revokedAt: new Date() }
  });
}

export async function resolveSession(token) {
  if (!token) return null;

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { adminUser: true }
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.adminUser?.isActive) return null;
  if (session.adminUser?.deletedAt) return null;

  // Rolling expiry, written at most once an hour so a busy dashboard does not
  // issue a database write per request.
  if (Date.now() - session.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    await prisma.adminSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }
    });
  }

  return session;
}

export function verifyCsrf(session, headerToken) {
  if (!headerToken || typeof headerToken !== 'string') return false;
  const expected = Buffer.from(session.csrfToken, 'utf8');
  const actual = Buffer.from(headerToken, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function clientIp(req) {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return raw ? String(raw).slice(0, 64) : null;
}

// ------------------------------------------------------------------- lockout

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

export function isLockedOut(user) {
  return Boolean(user?.lockedUntil && user.lockedUntil.getTime() > Date.now());
}

export async function recordFailedLogin(user) {
  const failedAttempts = user.failedAttempts + 1;
  const locks = failedAttempts >= MAX_FAILED_ATTEMPTS;
  await prisma.adminUser.update({
    where: { id: user.id },
    data: {
      failedAttempts: locks ? 0 : failedAttempts,
      lockedUntil: locks ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil
    }
  });
  return { locked: locks, remaining: Math.max(0, MAX_FAILED_ATTEMPTS - failedAttempts) };
}

export async function recordSuccessfulLogin(user) {
  await prisma.adminUser.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }
  });
}

export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

// ----------------------------------------------------------- password reset

export const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function createPasswordResetToken(adminUserId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await prisma.adminUser.update({
    where: { id: adminUserId },
    data: {
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: expiresAt
    }
  });

  return { token, expiresAt };
}

export async function verifyPasswordResetToken(token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = sha256(token);

  const user = await prisma.adminUser.findFirst({
    where: {
      resetTokenHash: tokenHash,
      resetTokenExpiresAt: { gt: new Date() },
      isActive: true,
      deletedAt: null
    }
  });

  return user;
}

export async function consumePasswordResetToken(token, newPassword) {
  const user = await verifyPasswordResetToken(token);
  if (!user) {
    const error = new Error('The password reset token is invalid or has expired.');
    error.status = 400;
    error.code = 'INVALID_OR_EXPIRED_RESET_TOKEN';
    throw error;
  }

  const weaknesses = validatePassword(newPassword);
  if (weaknesses.length > 0) {
    const error = new Error(`Password does not meet security requirements: ${weaknesses.join(', ')}.`);
    error.status = 400;
    error.code = 'WEAK_PASSWORD';
    error.details = weaknesses;
    throw error;
  }

  const newHash = await hashPassword(newPassword);

  const updatedUser = await prisma.$transaction(async (tx) => {
    return tx.adminUser.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        failedAttempts: 0,
        lockedUntil: null
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        updatedAt: true
      }
    });
  });

  // Revoke all active sessions so any old session cannot be used
  await revokeAllSessionsFor(user.id);

  return updatedUser;
}
