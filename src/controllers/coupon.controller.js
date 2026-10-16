import { prisma } from '../db/prisma.js';
import { validateAndQuoteCoupon } from '../services/coupons.js';
import { CATEGORIES } from '../config/event.js';

/**
 * Public preview endpoint for coupon validation.
 * POST /api/v1/coupons/validate
 * 
 * Returns 200 with valid: true or valid: false. Never reserves a slot.
 */
export async function validateCouponHandler(req, res, next) {
  try {
    const { code, email } = req.body || {};
    const category = req.body?.category || req.body?.categorySlug;

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(200).json({
        success: true,
        valid: false,
        code: 'COUPON_INVALID',
        error: "That coupon code isn't valid.",
        message: "That coupon code isn't valid."
      });
    }

    if (!category || !CATEGORIES[category]) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CATEGORY',
        error: 'A valid category is required to validate a coupon.',
        message: 'A valid category is required to validate a coupon.'
      });
    }

    const result = await validateAndQuoteCoupon(prisma, {
      code,
      categorySlug: category,
      email: email || null
    });

    if (!result.valid) {
      return res.status(200).json({
        success: true,
        valid: false,
        code: result.code,
        error: result.error,
        message: result.error
      });
    }

    return res.status(200).json({
      success: true,
      valid: true,
      coupon: result.coupon,
      quote: {
        ...result.quote,
        couponId: result.coupon.id,
        code: result.coupon.displayCode || result.coupon.code,
        displayCode: result.coupon.displayCode,
        discountType: result.coupon.discountType,
        discountValue: result.coupon.discountValue,
        isFree: result.isFree
      },
      isFree: result.isFree
    });
  } catch (err) {
    next(err);
  }
}
