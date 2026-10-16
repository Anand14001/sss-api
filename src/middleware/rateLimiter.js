import rateLimit from 'express-rate-limit';

/**
 * Collapses an IPv6 address to its /64 prefix for rate-limit keying.
 *
 * A single residential IPv6 allocation is routinely a /64 or wider, so keying
 * on the full address would let one client step through addresses it already
 * owns and collect a fresh budget for each one. IPv4 is returned unchanged.
 */
function normaliseIp(ip = '') {
  const addr = String(ip).replace(/^::ffff:/, '');
  if (!addr.includes(':')) return addr;
  return `${addr.split(':').slice(0, 4).join(':')}::/64`;
}

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // limit each IP to 150 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.'
  }
});

export const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit registration submissions to 20 per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many registration attempts from this IP. Please try again later.'
  }
});

export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // limit payment verifications to 30 per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many payment verification attempts. Please try again later.'
  }
});

/**
 * Sign-in and password change.
 *
 * Tighter than anything on the public side, and counted per IP + email so one
 * attacker cannot lock the organisers out of their own dashboard by burning the
 * shared venue IP's budget against an address they do not own. Successful
 * sign-ins do not count, so an administrator working normally never meets it.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').toLowerCase().slice(0, 100);
    return `${normaliseIp(req.ip)}:${email}`;
  },
  message: {
    success: false,
    error: 'Too many sign-in attempts. Wait a few minutes and try again.',
    code: 'RATE_LIMITED'
  }
});

/** General ceiling for an authenticated dashboard session. Generous: the
 *  dashboard polls nothing, but a busy operator opening records quickly should
 *  never see a limit. */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please slow down.',
    code: 'RATE_LIMITED'
  }
});

/**
 * Public coupon validation rate limiter (D7).
 * 10 attempts per 10 minutes per IP to mitigate enumeration and brute force.
 */
export const couponLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => normaliseIp(req.ip),
  message: {
    success: false,
    error: 'Too many coupon validation attempts. Please try again later.',
    code: 'RATE_LIMITED'
  }
});

/**
 * Apply coupon to registration endpoint limiter.
 * Tighter cap keyed by IP and registration reference.
 */
export const applyCouponLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${normaliseIp(req.ip)}:${req.params?.reference || ''}`,
  message: {
    success: false,
    error: 'Too many coupon application attempts for this booking. Please try again later.',
    code: 'RATE_LIMITED'
  }
});

