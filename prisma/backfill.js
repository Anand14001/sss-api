import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Idempotent backfill script.
 * Sets baseAmountPaise = amountPaise for any pre-coupon Registration rows where baseAmountPaise is null.
 */
export async function backfill() {
  const result = await prisma.$executeRaw`
    UPDATE "registrations"
    SET "base_amount_paise" = "amount_paise"
    WHERE "base_amount_paise" IS NULL
  `;
  console.log(`[BACKFILL] Updated ${result} registrations with baseAmountPaise.`);
  return result;
}

if (process.argv[1]?.endsWith('backfill.js')) {
  backfill()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[BACKFILL] Error: ${err.message}`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
