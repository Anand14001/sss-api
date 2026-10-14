import { prisma } from '../../src/db/prisma.js';
import { seed } from '../../prisma/seed.js';
import { setRazorpayClient } from '../../src/services/razorpay.js';
import { env } from '../../src/config/env.js';

export async function setupTestEnvironment() {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_testkey';
  process.env.RAZORPAY_KEY_SECRET = 'test_secret_12345';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret_12345';

  env.RAZORPAY_KEY_ID = 'rzp_test_testkey';
  env.RAZORPAY_KEY_SECRET = 'test_secret_12345';
  env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret_12345';

  await prisma.$connect();
  await seed();

  // Mock Razorpay client so tests do not make external network requests
  const mockRazorpay = {
    orders: {
      create: async (opts) => ({
        id: `order_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        entity: 'order',
        amount: opts.amount,
        amount_paid: 0,
        amount_due: opts.amount,
        currency: opts.currency,
        receipt: opts.receipt,
        status: 'created',
        notes: opts.notes
      })
    }
  };
  setRazorpayClient(mockRazorpay);
}

export async function teardownTestEnvironment() {
  await prisma.$disconnect();
}
