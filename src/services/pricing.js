import { CATEGORIES } from '../config/event.js';

/**
 * Single authoritative pure pricing function.
 * 
 * Money decision:
 * Percentage discounts round down (Math.floor) in paise. Rounding down favours
 * the participant by at most one paise and can never produce a total above the
 * base fee or exceed 100% of the base amount. Do not "fix" or change this to Math.round.
 *
 * @param {Object} params
 * @param {string} params.categorySlug
 * @param {Object|null} [params.coupon]
 * @returns {{ baseAmountPaise: number, discountPaise: number, payableAmountPaise: number, currency: string }}
 */
export function quotePrice({ categorySlug, coupon = null }) {
  const category = CATEGORIES[categorySlug];
  if (!category) {
    const error = new Error(`Unknown category: ${categorySlug}`);
    error.code = 'INVALID_CATEGORY';
    error.status = 400;
    throw error;
  }

  const baseAmountPaise = category.feePaise;
  const currency = category.currency || 'INR';

  if (!coupon) {
    return {
      baseAmountPaise,
      discountPaise: 0,
      payableAmountPaise: baseAmountPaise,
      currency
    };
  }

  if (coupon.discountType && coupon.discountType !== 'PERCENT') {
    const error = new Error(`Discount type ${coupon.discountType} is not supported. Only PERCENT is supported.`);
    error.code = 'NOT_SUPPORTED';
    error.status = 400;
    throw error;
  }

  const percent = Number(coupon.discountValue);
  if (isNaN(percent) || percent < 1 || percent > 100) {
    const error = new Error('Discount value must be a percentage between 1 and 100.');
    error.code = 'COUPON_VALIDATION_FAILED';
    error.status = 400;
    throw error;
  }

  // Math.floor in paise guarantees we never overcharge or overshoot baseAmountPaise.
  let discountPaise = Math.floor((baseAmountPaise * percent) / 100);
  discountPaise = Math.min(discountPaise, baseAmountPaise);
  const payableAmountPaise = baseAmountPaise - discountPaise;

  return {
    baseAmountPaise,
    discountPaise,
    payableAmountPaise,
    currency
  };
}
