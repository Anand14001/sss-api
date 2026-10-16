import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { quotePrice } from '../src/services/pricing.js';
import {
  normaliseCouponCode,
  generateRandomCode,
  formatDisplayCode,
  COUPON_CHARSET
} from '../src/services/couponCodes.js';
import {
  validateCouponDefinition,
  validateBatchGenerationRequest,
  evaluateRedemptionRules,
  getEffectiveStatus,
  formatIstDateTime,
  parseIstDate
} from '../src/services/couponValidation.js';

describe('Pricing (quotePrice)', () => {
  test('returns full price with zero discount when no coupon is provided', () => {
    const quote = quotePrice({ categorySlug: 'kid' });
    assert.equal(quote.baseAmountPaise, 9900);
    assert.equal(quote.discountPaise, 0);
    assert.equal(quote.payableAmountPaise, 9900);
    assert.equal(quote.currency, 'INR');
  });

  test('floors percentage discounts in paise (never rounds up)', () => {
    // 25% of 19900 paise = 4975 paise exactly
    const q1 = quotePrice({ categorySlug: 'teen', coupon: { discountType: 'PERCENT', discountValue: 25 } });
    assert.equal(q1.baseAmountPaise, 19900);
    assert.equal(q1.discountPaise, 4975);
    assert.equal(q1.payableAmountPaise, 14925);

    // 33% of 9900 paise: 9900 * 0.33 = 3267 paise
    const q2 = quotePrice({ categorySlug: 'kid', coupon: { discountType: 'PERCENT', discountValue: 33 } });
    assert.equal(q2.discountPaise, 3267);
    assert.equal(q2.payableAmountPaise, 6633);

    // 17% of 29900 paise = 5083 paise (exact Math.floor of 5083.00)
    // 1% of 9900 paise = 99 paise
    const q3 = quotePrice({ categorySlug: 'kid', coupon: { discountType: 'PERCENT', discountValue: 1 } });
    assert.equal(q3.discountPaise, 99);
    assert.equal(q3.payableAmountPaise, 9801);
  });

  test('100% discount produces 0 payableAmountPaise', () => {
    const qAdult = quotePrice({ categorySlug: 'adult', coupon: { discountType: 'PERCENT', discountValue: 100 } });
    assert.equal(qAdult.baseAmountPaise, 29900);
    assert.equal(qAdult.discountPaise, 29900);
    assert.equal(qAdult.payableAmountPaise, 0);
  });

  test('rejects non-PERCENT discountType with NOT_SUPPORTED', () => {
    assert.throws(
      () => quotePrice({ categorySlug: 'kid', coupon: { discountType: 'FLAT', discountValue: 50 } }),
      (err) => err.code === 'NOT_SUPPORTED'
    );
  });

  test('rejects invalid percent values', () => {
    assert.throws(
      () => quotePrice({ categorySlug: 'kid', coupon: { discountType: 'PERCENT', discountValue: 0 } }),
      (err) => err.code === 'COUPON_VALIDATION_FAILED'
    );
    assert.throws(
      () => quotePrice({ categorySlug: 'kid', coupon: { discountType: 'PERCENT', discountValue: 101 } }),
      (err) => err.code === 'COUPON_VALIDATION_FAILED'
    );
  });
});

describe('Coupon codes & normalisation', () => {
  test('normalises code: uppercase, trimmed, hyphens/spaces stripped', () => {
    assert.equal(normaliseCouponCode(' summer-25 '), 'SUMMER25');
    assert.equal(normaliseCouponCode('SUMMER 25'), 'SUMMER25');
    assert.equal(normaliseCouponCode('Summer-25'), 'SUMMER25');
    assert.equal(normaliseCouponCode('s-u-m-m-e-r_25'), 'SUMMER25');
  });

  test('display code formatting preserves readability', () => {
    assert.equal(formatDisplayCode('SSS', 'K7M2P9QX'), 'SSS-K7M2P9QX');
    assert.equal(formatDisplayCode('', 'K7M2P9QX'), 'K7M2P9QX');
  });

  test('charset excludes ambiguous characters (0, O, 1, I)', () => {
    assert.equal(COUPON_CHARSET.includes('0'), false);
    assert.equal(COUPON_CHARSET.includes('O'), false);
    assert.equal(COUPON_CHARSET.includes('1'), false);
    assert.equal(COUPON_CHARSET.includes('I'), false);
  });

  test('generates codes with correct length and only valid characters', () => {
    for (let len = 6; len <= 12; len++) {
      const code = generateRandomCode(len);
      assert.equal(code.length, len);
      for (const char of code) {
        assert.ok(COUPON_CHARSET.includes(char), `Character ${char} must be in charset`);
      }
    }
  });

  test('generates no duplicates across 10,000 codes', () => {
    const set = new Set();
    const count = 10000;
    for (let i = 0; i < count; i++) {
      set.add(generateRandomCode(8));
    }
    assert.equal(set.size, count, 'Expected 10,000 unique codes with no collisions');
  });
});

describe('Coupon validation rules', () => {
  test('validates valid custom coupon definition', () => {
    const res = validateCouponDefinition({
      code: 'early-bird-25',
      displayCode: 'EARLY-BIRD-25',
      description: '25% off for early registrants',
      discountType: 'PERCENT',
      discountValue: 25,
      categorySlugs: ['teen', 'adult'],
      maxRedemptions: 50,
      perEmailLimit: 1,
      startsAt: '2026-10-01T00:00:00+05:30',
      expiresAt: '2026-10-25T23:59:59+05:30',
      status: 'ACTIVE'
    });

    assert.equal(res.isValid, true);
    assert.equal(res.cleaned.code, 'EARLYBIRD25');
    assert.equal(res.cleaned.displayCode, 'EARLY-BIRD-25');
    assert.equal(res.cleaned.discountValue, 25);
    assert.deepEqual(res.cleaned.categorySlugs, ['teen', 'adult']);
    assert.equal(res.cleaned.maxRedemptions, 50);
    assert.equal(res.cleaned.perEmailLimit, 1);
  });

  test('rejects code matching booking reference pattern SSS-...', () => {
    const res = validateCouponDefinition({
      code: 'SSS-2026-ABCDEF',
      discountValue: 10
    });
    assert.equal(res.isValid, false);
    assert.ok(res.errors.code.includes('SSS'));
  });

  test('rejects discountValue outside 1-100', () => {
    const resZero = validateCouponDefinition({ code: 'DISC0', discountValue: 0 });
    assert.equal(resZero.isValid, false);
    assert.ok(resZero.errors.discountValue);

    const resOver = validateCouponDefinition({ code: 'DISC101', discountValue: 101 });
    assert.equal(resOver.isValid, false);
    assert.ok(resOver.errors.discountValue);
  });

  test('rejects maxRedemptions edit below existing redeemedCount', () => {
    const res = validateCouponDefinition({
      discountValue: 20,
      maxRedemptions: 5
    }, { isEdit: true, currentRedeemedCount: 10 });

    assert.equal(res.isValid, false);
    assert.ok(res.errors.maxRedemptions.includes('lower than'));
  });

  test('rejects perEmailLimit greater than maxRedemptions', () => {
    const res = validateCouponDefinition({
      code: 'LIMIT10',
      discountValue: 20,
      maxRedemptions: 5,
      perEmailLimit: 10
    });
    assert.equal(res.isValid, false);
    assert.ok(res.errors.perEmailLimit.includes('cannot exceed'));
  });

  test('rejects expiresAt <= startsAt', () => {
    const res = validateCouponDefinition({
      code: 'BADWINDOW',
      discountValue: 20,
      startsAt: '2026-10-20T12:00:00+05:30',
      expiresAt: '2026-10-20T11:00:00+05:30'
    });
    assert.equal(res.isValid, false);
    assert.ok(res.errors.expiresAt.includes('after the start date'));
  });

  test('warns when expiry is after event registration deadline', () => {
    const res = validateCouponDefinition({
      code: 'LATEEXPIRY',
      discountValue: 20,
      expiresAt: '2026-10-29T23:59:59+05:30'
    });
    assert.equal(res.isValid, true);
    assert.equal(res.warnings.length, 1);
    assert.ok(res.warnings[0].includes('registration deadline'));
  });

  test('validates batch generation requests within 1-500 ceiling', () => {
    const valid = validateBatchGenerationRequest({
      count: 100,
      prefix: 'VIP',
      codeLength: 8,
      discountValue: 50,
      batchLabel: 'School partners'
    });
    assert.equal(valid.isValid, true);
    assert.equal(valid.cleaned.count, 100);
    assert.equal(valid.cleaned.prefix, 'VIP');

    const invalid = validateBatchGenerationRequest({
      count: 501,
      discountValue: 50
    });
    assert.equal(invalid.isValid, false);
    assert.ok(invalid.errors.count.includes('500'));
  });
});

describe('Redemption rules evaluation order', () => {
  const baseCoupon = {
    code: 'TEST25',
    status: 'ACTIVE',
    isArchived: false,
    discountType: 'PERCENT',
    discountValue: 25,
    categorySlugs: ['teen'],
    maxRedemptions: 10,
    redeemedCount: 0,
    perEmailLimit: 1,
    startsAt: new Date('2026-10-01T00:00:00+05:30'),
    expiresAt: new Date('2026-10-25T23:59:59+05:30')
  };

  test('order 2: missing or archived coupon -> COUPON_INVALID', () => {
    const r1 = evaluateRedemptionRules({ coupon: null, categorySlug: 'teen' });
    assert.equal(r1.valid, false);
    assert.equal(r1.code, 'COUPON_INVALID');

    const r2 = evaluateRedemptionRules({ coupon: { ...baseCoupon, isArchived: true }, categorySlug: 'teen' });
    assert.equal(r2.valid, false);
    assert.equal(r2.code, 'COUPON_INVALID');
  });

  test('order 3: paused coupon -> COUPON_PAUSED', () => {
    const r = evaluateRedemptionRules({ coupon: { ...baseCoupon, status: 'PAUSED' }, categorySlug: 'teen' });
    assert.equal(r.valid, false);
    assert.equal(r.code, 'COUPON_PAUSED');
  });

  test('order 4: not started -> COUPON_NOT_STARTED with IST date', () => {
    const futureStart = new Date('2026-10-20T10:00:00+05:30');
    const r = evaluateRedemptionRules({
      coupon: { ...baseCoupon, startsAt: futureStart },
      categorySlug: 'teen',
      now: new Date('2026-10-19T10:00:00+05:30')
    });
    assert.equal(r.valid, false);
    assert.equal(r.code, 'COUPON_NOT_STARTED');
    assert.ok(r.error.includes('IST'));
  });

  test('order 5: expired -> COUPON_EXPIRED with IST date', () => {
    const expiry = new Date('2026-10-15T12:00:00+05:30');
    // 1 second before expiry is valid
    const validBefore = evaluateRedemptionRules({
      coupon: { ...baseCoupon, expiresAt: expiry },
      categorySlug: 'teen',
      now: new Date('2026-10-15T11:59:59+05:30')
    });
    assert.equal(validBefore.valid, true);

    // Exact expiry second is expired
    const expiredAt = evaluateRedemptionRules({
      coupon: { ...baseCoupon, expiresAt: expiry },
      categorySlug: 'teen',
      now: expiry
    });
    assert.equal(expiredAt.valid, false);
    assert.equal(expiredAt.code, 'COUPON_EXPIRED');
    assert.ok(expiredAt.error.includes('IST'));
  });

  test('order 6: wrong category -> COUPON_WRONG_CATEGORY naming eligible categories', () => {
    const r = evaluateRedemptionRules({
      coupon: { ...baseCoupon, categorySlugs: ['teen'] },
      categorySlug: 'kid'
    });
    assert.equal(r.valid, false);
    assert.equal(r.code, 'COUPON_WRONG_CATEGORY');
    assert.ok(r.error.includes('Teens'));
  });

  test('order 7: usage limit reached -> COUPON_LIMIT_REACHED', () => {
    const r = evaluateRedemptionRules({
      coupon: { ...baseCoupon, maxRedemptions: 5, redeemedCount: 5 },
      categorySlug: 'teen'
    });
    assert.equal(r.valid, false);
    assert.equal(r.code, 'COUPON_LIMIT_REACHED');
  });

  test('order 8: per-email limit reached -> COUPON_EMAIL_LIMIT_REACHED', () => {
    const r = evaluateRedemptionRules({
      coupon: { ...baseCoupon, perEmailLimit: 2 },
      categorySlug: 'teen',
      emailRedemptionCount: 2
    });
    assert.equal(r.valid, false);
    assert.equal(r.code, 'COUPON_EMAIL_LIMIT_REACHED');
  });

  test('order 9: valid coupon quotes accurately and flags 100% as free', () => {
    const r25 = evaluateRedemptionRules({
      coupon: baseCoupon,
      categorySlug: 'teen'
    });
    assert.equal(r25.valid, true);
    assert.equal(r25.isFree, false);
    assert.equal(r25.quote.payableAmountPaise, 14925);

    const r100 = evaluateRedemptionRules({
      coupon: { ...baseCoupon, discountValue: 100 },
      categorySlug: 'teen'
    });
    assert.equal(r100.valid, true);
    assert.equal(r100.isFree, true);
    assert.equal(r100.quote.payableAmountPaise, 0);
  });
});

describe('Effective status derivation (D8)', () => {
  const base = {
    status: 'ACTIVE',
    isArchived: false,
    maxRedemptions: 10,
    redeemedCount: 0,
    startsAt: null,
    expiresAt: null
  };

  test('derives ARCHIVED, PAUSED, SCHEDULED, EXPIRED, EXHAUSTED, ACTIVE', () => {
    assert.equal(getEffectiveStatus({ ...base, isArchived: true }), 'ARCHIVED');
    assert.equal(getEffectiveStatus({ ...base, status: 'PAUSED' }), 'PAUSED');

    const future = new Date('2026-10-20T00:00:00+05:30');
    assert.equal(getEffectiveStatus({ ...base, startsAt: future }, new Date('2026-10-18T00:00:00+05:30')), 'SCHEDULED');

    const past = new Date('2026-10-10T00:00:00+05:30');
    assert.equal(getEffectiveStatus({ ...base, expiresAt: past }, new Date('2026-10-12T00:00:00+05:30')), 'EXPIRED');

    assert.equal(getEffectiveStatus({ ...base, maxRedemptions: 5, redeemedCount: 5 }), 'EXHAUSTED');
    assert.equal(getEffectiveStatus(base), 'ACTIVE');
  });
});
