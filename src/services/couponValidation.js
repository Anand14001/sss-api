import { CATEGORIES, EVENT_CONFIG } from '../config/event.js';
import { normaliseCouponCode } from './couponCodes.js';
import { quotePrice } from './pricing.js';

/**
 * Format a Date object into IST human-readable format.
 * E.g. "20 October 2026, 11:59 PM IST"
 * 
 * @param {Date|string} dateInput
 * @returns {string}
 */
export function formatIstDateTime(dateInput) {
  if (!dateInput) return '';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date) + ' IST';
}

/**
 * Parses a date or date-time string as IST if no timezone/offset is provided.
 *
 * @param {string|Date|null} val
 * @returns {Date|null}
 */
export function parseIstDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val !== 'string') return null;

  const trimmed = val.trim();
  if (!trimmed) return null;

  // If already contains Z or +/- offset, standard Date parsing works
  if (trimmed.endsWith('Z') || /[+-]\d{2}(:?\d{2})?$/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  // Treat naive ISO (e.g. 2026-10-26T23:59:59 or 2026-10-26 23:59) as IST (+05:30)
  const separator = trimmed.includes('T') ? 'T' : ' ';
  const parts = trimmed.split(separator);
  if (parts.length === 1) {
    // Only date provided (e.g. 2026-10-26) -> 2026-10-26T00:00:00+05:30
    const d = new Date(`${trimmed}T00:00:00+05:30`);
    return isNaN(d.getTime()) ? null : d;
  }

  // Ensure seconds are included
  let timePart = parts[1];
  if (timePart.split(':').length === 2) {
    timePart = `${timePart}:00`;
  }
  const d = new Date(`${parts[0]}T${timePart}+05:30`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Validates admin input for creating or editing a coupon.
 * Never throws — returns { isValid, errors, cleaned, warnings }.
 *
 * @param {Object} input
 * @param {Object} [options]
 * @param {boolean} [options.isEdit=false]
 * @param {number} [options.currentRedeemedCount=0]
 * @returns {{ isValid: boolean, errors: Object, cleaned: Object, warnings: string[] }}
 */
export function validateCouponDefinition(input, { isEdit = false, currentRedeemedCount = 0 } = {}) {
  const errors = {};
  const cleaned = {};
  const warnings = [];

  const raw = input || {};

  // 1. Code & displayCode (required on create)
  if (!isEdit) {
    if (!raw.code || typeof raw.code !== 'string' || !raw.code.trim()) {
      errors.code = 'Coupon code is required.';
    } else {
      const normalised = normaliseCouponCode(raw.code);
      if (!/^[A-Z0-9]{4,24}$/.test(normalised)) {
        errors.code = 'Coupon code must be 4–24 letters or numbers (A–Z, 0–9).';
      } else if (/^SSS/i.test(normalised)) {
        // Reject codes matching booking reference prefix SSS-...
        errors.code = 'Coupon code cannot start with SSS to avoid confusion with booking references.';
      } else {
        cleaned.code = normalised;
        const display = (raw.displayCode || raw.code).trim();
        if (display.length > 32) {
          errors.displayCode = 'Display code must be at most 32 characters.';
        } else {
          cleaned.displayCode = display;
        }
      }
    }
  } else {
    // On edit, code and displayCode are immutable if redeemedCount > 0
    if (raw.displayCode !== undefined) {
      const display = String(raw.displayCode).trim();
      if (display.length > 32) {
        errors.displayCode = 'Display code must be at most 32 characters.';
      } else {
        cleaned.displayCode = display;
      }
    }
  }

  // 2. Description (optional, <= 200 chars)
  if (raw.description !== undefined && raw.description !== null) {
    const desc = String(raw.description).trim();
    if (desc.length > 200) {
      errors.description = 'Description must be at most 200 characters.';
    } else {
      cleaned.description = desc || null;
    }
  } else {
    cleaned.description = null;
  }

  // 3. Discount type
  const discountType = (raw.discountType || 'PERCENT').toUpperCase();
  if (discountType !== 'PERCENT') {
    errors.discountType = `Discount type ${discountType} is not supported. Only PERCENT is supported.`;
  } else {
    cleaned.discountType = 'PERCENT';
  }

  // 4. Discount value (integer 1-100)
  if (raw.discountValue === undefined || raw.discountValue === null || raw.discountValue === '') {
    errors.discountValue = 'Discount percentage is required.';
  } else {
    const val = Number(raw.discountValue);
    if (!Number.isInteger(val) || val < 1 || val > 100) {
      errors.discountValue = 'Discount percentage must be an integer between 1 and 100.';
    } else {
      cleaned.discountValue = val;
    }
  }

  // 5. Category slugs (subset of CATEGORIES, [] for all)
  if (raw.categorySlugs !== undefined && raw.categorySlugs !== null) {
    let slugs = Array.isArray(raw.categorySlugs) ? raw.categorySlugs : [raw.categorySlugs];
    // Deduplicate and filter empty
    slugs = Array.from(new Set(slugs.filter(Boolean)));
    const validCategoryKeys = Object.keys(CATEGORIES);
    const unknown = slugs.filter(s => !validCategoryKeys.includes(s));
    if (unknown.length > 0) {
      errors.categorySlugs = `Unknown category slugs: ${unknown.join(', ')}. Must be one of: ${validCategoryKeys.join(', ')}.`;
    } else {
      cleaned.categorySlugs = slugs;
    }
  } else {
    cleaned.categorySlugs = [];
  }

  // 6. maxRedemptions (null or integer 1..100000; on edit must be >= currentRedeemedCount)
  if (raw.maxRedemptions === undefined || raw.maxRedemptions === null || raw.maxRedemptions === '') {
    cleaned.maxRedemptions = null;
  } else {
    const maxR = Number(raw.maxRedemptions);
    if (!Number.isInteger(maxR) || maxR < 1 || maxR > 100000) {
      errors.maxRedemptions = 'Usage limit must be an integer between 1 and 100,000 or empty for unlimited.';
    } else if (isEdit && maxR < currentRedeemedCount) {
      errors.maxRedemptions = `Usage limit (${maxR}) cannot be lower than the number of existing redemptions (${currentRedeemedCount}).`;
    } else {
      cleaned.maxRedemptions = maxR;
    }
  }

  // 7. perEmailLimit (null or integer 1..20; must be <= maxRedemptions if both set)
  if (raw.perEmailLimit === undefined || raw.perEmailLimit === null || raw.perEmailLimit === '') {
    cleaned.perEmailLimit = null;
  } else {
    const pLimit = Number(raw.perEmailLimit);
    if (!Number.isInteger(pLimit) || pLimit < 1 || pLimit > 20) {
      errors.perEmailLimit = 'Per-email limit must be an integer between 1 and 20 or empty for unlimited.';
    } else if (cleaned.maxRedemptions !== null && cleaned.maxRedemptions !== undefined && pLimit > cleaned.maxRedemptions) {
      errors.perEmailLimit = `Per-email limit (${pLimit}) cannot exceed the coupon usage limit (${cleaned.maxRedemptions}).`;
    } else {
      cleaned.perEmailLimit = pLimit;
    }
  }

  // 8. startsAt (optional; may be in the past)
  if (raw.startsAt) {
    const sDate = parseIstDate(raw.startsAt);
    if (!sDate) {
      errors.startsAt = 'Start date is invalid.';
    } else {
      cleaned.startsAt = sDate;
    }
  } else {
    cleaned.startsAt = null;
  }

  // 9. expiresAt (optional; on create must be in the future; must be > startsAt)
  if (raw.expiresAt) {
    const eDate = parseIstDate(raw.expiresAt);
    if (!eDate) {
      errors.expiresAt = 'Expiry date is invalid.';
    } else {
      const now = new Date();
      if (!isEdit && eDate.getTime() <= now.getTime()) {
        errors.expiresAt = 'Expiry date must be in the future.';
      } else if (cleaned.startsAt && eDate.getTime() <= cleaned.startsAt.getTime()) {
        errors.expiresAt = 'Expiry date must be strictly after the start date.';
      } else {
        cleaned.expiresAt = eDate;
        // Warn if after registration deadline
        const deadlineDate = new Date(EVENT_CONFIG.deadline);
        if (eDate.getTime() > deadlineDate.getTime()) {
          warnings.push(`Expiry date (${formatIstDateTime(eDate)}) is after the registration deadline (${formatIstDateTime(deadlineDate)}). The coupon cannot be used after the deadline.`);
        }
      }
    }
  } else {
    cleaned.expiresAt = null;
  }

  // 10. status (ACTIVE | PAUSED)
  const status = (raw.status || 'ACTIVE').toUpperCase();
  if (!['ACTIVE', 'PAUSED'].includes(status)) {
    errors.status = 'Status must be either ACTIVE or PAUSED.';
  } else {
    cleaned.status = status;
  }

  const isValid = Object.keys(errors).length === 0;

  return {
    isValid,
    errors,
    cleaned,
    warnings
  };
}

/**
 * Validates request to generate a batch of coupons.
 *
 * @param {Object} input
 * @returns {{ isValid: boolean, errors: Object, cleaned: Object, warnings: string[] }}
 */
export function validateBatchGenerationRequest(input) {
  const errors = {};
  const cleaned = {};
  const warnings = [];

  const raw = input || {};

  // Count: 1-500
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    errors.count = 'Batch count must be an integer between 1 and 500.';
  } else {
    cleaned.count = count;
  }

  // Prefix: optional [A-Z0-9]{0,8}
  if (raw.prefix !== undefined && raw.prefix !== null && raw.prefix !== '') {
    const normPrefix = normaliseCouponCode(raw.prefix);
    if (normPrefix.length > 8 || !/^[A-Z0-9]*$/.test(normPrefix)) {
      errors.prefix = 'Prefix must be up to 8 alphanumeric characters (A–Z, 0–9).';
    } else {
      cleaned.prefix = normPrefix;
    }
  } else {
    cleaned.prefix = '';
  }

  // CodeLength: 6-12 (default 8)
  const codeLength = raw.codeLength !== undefined && raw.codeLength !== null && raw.codeLength !== ''
    ? Number(raw.codeLength)
    : 8;
  if (!Number.isInteger(codeLength) || codeLength < 6 || codeLength > 12) {
    errors.codeLength = 'Code length must be between 6 and 12 characters.';
  } else {
    cleaned.codeLength = codeLength;
  }

  // BatchLabel: optional <= 60 chars
  if (raw.batchLabel !== undefined && raw.batchLabel !== null) {
    const lbl = String(raw.batchLabel).trim();
    if (lbl.length > 60) {
      errors.batchLabel = 'Batch label must be at most 60 characters.';
    } else {
      cleaned.batchLabel = lbl || null;
    }
  } else {
    cleaned.batchLabel = null;
  }

  // Validate common coupon definition fields
  const subDef = validateCouponDefinition({
    ...raw,
    code: 'DUMMY' // placeholder so definition validation doesn't fail on code
  });

  // Copy errors from subDef, ignoring code/displayCode
  for (const [k, v] of Object.entries(subDef.errors)) {
    if (k !== 'code' && k !== 'displayCode') {
      errors[k] = v;
    }
  }
  warnings.push(...subDef.warnings);

  delete subDef.cleaned.code;
  delete subDef.cleaned.displayCode;
  cleaned.couponData = subDef.cleaned;

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    cleaned,
    warnings
  };
}

/**
 * Pure evaluation of redemption rules (fail-fast, §5 order).
 * 
 * 1. code present and normalises -> else COUPON_INVALID
 * 2. coupon exists and !isArchived -> else COUPON_INVALID
 * 3. status === 'ACTIVE' -> else COUPON_PAUSED
 * 4. startsAt == null || now >= startsAt -> else COUPON_NOT_STARTED
 * 5. expiresAt == null || now < expiresAt -> else COUPON_EXPIRED
 * 6. category in scope -> else COUPON_WRONG_CATEGORY
 * 7. maxRedemptions == null || redeemedCount < maxRedemptions -> else COUPON_LIMIT_REACHED
 * 8. per-email count below perEmailLimit -> else COUPON_EMAIL_LIMIT_REACHED
 * 9. quote price: 0 -> free; 0 < payable < 100 -> COUPON_RESULTS_IN_INVALID_AMOUNT
 *
 * @param {Object} params
 * @param {Object|null} params.coupon
 * @param {string} params.categorySlug
 * @param {number} [params.emailRedemptionCount=0]
 * @param {Date} [params.now=new Date()]
 * @returns {{ valid: boolean, code?: string, error?: string, quote?: Object, isFree?: boolean }}
 */
export function evaluateRedemptionRules({
  coupon,
  categorySlug,
  emailRedemptionCount = 0,
  now = new Date(),
  baseAmountPaise = null
}) {
  if (!coupon || coupon.isArchived) {
    return {
      valid: false,
      code: 'COUPON_INVALID',
      error: "That coupon code isn't valid."
    };
  }

  if (coupon.status !== 'ACTIVE') {
    return {
      valid: false,
      code: 'COUPON_PAUSED',
      error: 'This coupon is temporarily paused.'
    };
  }

  if (coupon.startsAt && now.getTime() < new Date(coupon.startsAt).getTime()) {
    return {
      valid: false,
      code: 'COUPON_NOT_STARTED',
      error: `This coupon will become active on ${formatIstDateTime(coupon.startsAt)}.`
    };
  }

  if (coupon.expiresAt && now.getTime() >= new Date(coupon.expiresAt).getTime()) {
    return {
      valid: false,
      code: 'COUPON_EXPIRED',
      error: `This coupon expired on ${formatIstDateTime(coupon.expiresAt)}.`
    };
  }

  if (coupon.categorySlugs && coupon.categorySlugs.length > 0) {
    if (!coupon.categorySlugs.includes(categorySlug)) {
      const allowedNames = coupon.categorySlugs
        .map(slug => CATEGORIES[slug]?.formLabel || slug)
        .join(', ');
      return {
        valid: false,
        code: 'COUPON_WRONG_CATEGORY',
        error: `This coupon is valid only for: ${allowedNames}.`
      };
    }
  }

  if (coupon.maxRedemptions !== null && coupon.maxRedemptions !== undefined) {
    if (coupon.redeemedCount >= coupon.maxRedemptions) {
      return {
        valid: false,
        code: 'COUPON_LIMIT_REACHED',
        error: 'This coupon has been fully claimed.'
      };
    }
  }

  if (coupon.perEmailLimit !== null && coupon.perEmailLimit !== undefined) {
    if (emailRedemptionCount >= coupon.perEmailLimit) {
      return {
        valid: false,
        code: 'COUPON_EMAIL_LIMIT_REACHED',
        error: `This coupon has already been redeemed the maximum number of times (${coupon.perEmailLimit}) by this email address.`
      };
    }
  }

  // Quote price and check bounds
  const quote = quotePrice({ categorySlug, coupon, baseAmountPaise });

  if (quote.payableAmountPaise === 0) {
    return {
      valid: true,
      quote,
      isFree: true
    };
  }

  if (quote.payableAmountPaise > 0 && quote.payableAmountPaise < 100) {
    return {
      valid: false,
      code: 'COUPON_RESULTS_IN_INVALID_AMOUNT',
      error: 'Coupon results in an invalid payable amount below ₹1.'
    };
  }

  return {
    valid: true,
    quote,
    isFree: false
  };
}

/**
 * Computes derived effective status for admin payloads (D8).
 * effectiveStatus: ACTIVE | SCHEDULED | PAUSED | EXPIRED | EXHAUSTED | ARCHIVED
 *
 * @param {Object} coupon
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function getEffectiveStatus(coupon, now = new Date()) {
  if (coupon.isArchived) return 'ARCHIVED';
  if (coupon.status === 'PAUSED') return 'PAUSED';
  if (coupon.startsAt && now.getTime() < new Date(coupon.startsAt).getTime()) return 'SCHEDULED';
  if (coupon.expiresAt && now.getTime() >= new Date(coupon.expiresAt).getTime()) return 'EXPIRED';
  if (coupon.maxRedemptions !== null && coupon.maxRedemptions !== undefined && coupon.redeemedCount >= coupon.maxRedemptions) {
    return 'EXHAUSTED';
  }
  return 'ACTIVE';
}
