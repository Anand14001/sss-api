import crypto from 'node:crypto';

/**
 * Unambiguous character set matching generateReference() in registration.js.
 * Excludes 0, O, 1, I to prevent transcription errors when dictated over the phone
 * or typed from printouts.
 */
export const COUPON_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Normalises a coupon code string:
 * - Trims whitespace
 * - Strips internal whitespace, dashes, and underscores
 * - Converts to uppercase
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseCouponCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/[\s\-_]+/g, '');
}

/**
 * Formats display code from raw input or components.
 * 
 * @param {string} prefix
 * @param {string} body
 * @returns {string}
 */
export function formatDisplayCode(prefix, body) {
  const cleanPrefix = normaliseCouponCode(prefix || '');
  const cleanBody = normaliseCouponCode(body || '');
  if (!cleanPrefix) return cleanBody;
  return `${cleanPrefix}-${cleanBody}`;
}

/**
 * Generates an unambiguous random string of given length using crypto.randomInt.
 * 
 * Note on randomInt vs Math.random:
 * crypto.randomInt is cryptographically secure and eliminates the modulo bias
 * and PRNG state predictability of Math.random(), making coupon codes unguessable.
 *
 * @param {number} length
 * @returns {string}
 */
export function generateRandomCode(length = 8) {
  const chars = [];
  const charsetLen = COUPON_CHARSET.length;
  for (let i = 0; i < length; i++) {
    const idx = crypto.randomInt(0, charsetLen);
    chars.push(COUPON_CHARSET[idx]);
  }
  return chars.join('');
}

/**
 * Generates a batch of unique coupon definitions.
 * Performs collision checking in rounds (up to 5 rounds) against database coupons.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {Object} params
 * @param {number} params.count
 * @param {string} [params.prefix]
 * @param {number} [params.codeLength=8]
 * @param {string} [params.batchLabel]
 * @param {Object} params.couponData
 * @param {string} [adminEmail]
 * @returns {Promise<{ batchId: string, coupons: Array<any> }>}
 */
export async function generateCouponBatch(prisma, {
  count,
  prefix = '',
  codeLength = 8,
  batchLabel = null,
  couponData
}, adminEmail = null) {
  if (count < 1 || count > 500) {
    const err = new Error('Batch count must be between 1 and 500.');
    err.code = 'INVALID_BATCH_COUNT';
    err.status = 400;
    throw err;
  }

  const cleanPrefix = normaliseCouponCode(prefix);
  const batchId = crypto.randomUUID();
  const generatedMap = new Map(); // normalizedCode -> { id, code, displayCode }

  let attempts = 0;
  const maxAttempts = 5;

  while (generatedMap.size < count && attempts < maxAttempts) {
    attempts++;
    const needed = count - generatedMap.size;
    const candidates = [];

    for (let i = 0; i < needed * 2; i++) {
      const body = generateRandomCode(codeLength);
      const code = cleanPrefix ? `${cleanPrefix}${body}` : body;
      const displayCode = cleanPrefix ? `${cleanPrefix}-${body}` : body;
      if (!generatedMap.has(code)) {
        candidates.push({ code, displayCode });
      }
    }

    if (candidates.length === 0) continue;

    // Check existing in DB
    const candidateCodes = candidates.map(c => c.code);
    const existing = await prisma.coupon.findMany({
      where: { code: { in: candidateCodes } },
      select: { code: true }
    });
    const existingSet = new Set(existing.map(e => e.code));

    for (const cand of candidates) {
      if (!existingSet.has(cand.code) && !generatedMap.has(cand.code)) {
        generatedMap.set(cand.code, {
          id: crypto.randomUUID(),
          code: cand.code,
          displayCode: cand.displayCode
        });
        if (generatedMap.size === count) break;
      }
    }
  }

  if (generatedMap.size < count) {
    const err = new Error(`Could not generate ${count} unique coupon codes after ${maxAttempts} rounds.`);
    err.code = 'COUPON_GENERATION_FAILED';
    err.status = 500;
    throw err;
  }

  const items = Array.from(generatedMap.values()).map(item => ({
    id: item.id,
    code: item.code,
    displayCode: item.displayCode,
    description: couponData.description || null,
    discountType: couponData.discountType || 'PERCENT',
    discountValue: couponData.discountValue,
    categorySlugs: couponData.categorySlugs || [],
    maxRedemptions: couponData.maxRedemptions ?? null,
    redeemedCount: 0,
    perEmailLimit: couponData.perEmailLimit ?? null,
    startsAt: couponData.startsAt ?? null,
    expiresAt: couponData.expiresAt ?? null,
    status: couponData.status || 'ACTIVE',
    isArchived: false,
    batchId,
    batchLabel: batchLabel || null,
    createdByEmail: adminEmail,
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  // Atomic batch insertion
  await prisma.$transaction(async (tx) => {
    await tx.coupon.createMany({
      data: items
    });
  });

  return {
    batchId,
    coupons: items
  };
}
