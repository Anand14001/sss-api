import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';
import { AUDIT_ACTIONS } from '../src/services/audit.js';

const ADMIN_EMAIL = 'coupon-test-admin@example.invalid';
const ADMIN_PASSWORD = 'TestPassword@2026!';

function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

describe('Coupon Admin API', () => {
  let sessionCookie = null;
  let csrfToken = null;
  let testAdminId = null;

  const createdCouponIds = [];
  const createdRegistrationIds = [];

  before(async () => {
    await setupTestEnvironment();

    // Clean up any previous test admin
    const prev = await prisma.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });
    if (prev) {
      await prisma.auditLog.deleteMany({ where: { adminUserId: prev.id } });
      await prisma.adminSession.deleteMany({ where: { adminUserId: prev.id } });
      await prisma.adminUser.delete({ where: { id: prev.id } });
    }

    const admin = await prisma.adminUser.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'Coupon Test Admin',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        mustChangePassword: false,
        isActive: true
      }
    });
    testAdminId = admin.id;

    // Login to obtain session cookie and CSRF token
    const loginRes = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    assert.equal(loginRes.status, 200);
    csrfToken = loginRes.body.csrfToken;
    const cookieRaw = cookieValue(loginRes.headers['set-cookie'], 'sss_admin_session');
    sessionCookie = `sss_admin_session=${cookieRaw}`;
  });

  after(async () => {
    // Teardown test fixtures
    if (createdRegistrationIds.length > 0) {
      await prisma.emailDelivery.deleteMany({
        where: { registrationId: { in: createdRegistrationIds } }
      });
      await prisma.couponRedemption.deleteMany({
        where: { registrationId: { in: createdRegistrationIds } }
      });
      await prisma.payment.deleteMany({
        where: { registrationId: { in: createdRegistrationIds } }
      });
      await prisma.registration.deleteMany({
        where: { id: { in: createdRegistrationIds } }
      });
    }
    if (createdCouponIds.length > 0) {
      await prisma.couponRedemption.deleteMany({
        where: { couponId: { in: createdCouponIds } }
      });
      await prisma.coupon.deleteMany({
        where: { id: { in: createdCouponIds } }
      });
    }

    if (testAdminId) {
      await prisma.auditLog.deleteMany({ where: { adminUserId: testAdminId } });
      await prisma.adminSession.deleteMany({ where: { adminUserId: testAdminId } });
      await prisma.adminUser.delete({ where: { id: testAdminId } });
    }

    await teardownTestEnvironment();
  });

  test('every coupon admin route rejects unauthenticated requests', async () => {
    const unauthList = await request(app).get('/api/v1/admin/coupons');
    assert.equal(unauthList.status, 401);

    const unauthSummary = await request(app).get('/api/v1/admin/coupons/summary');
    assert.equal(unauthSummary.status, 401);

    const unauthPost = await request(app).post('/api/v1/admin/coupons').send({ code: 'TEST' });
    assert.equal(unauthPost.status, 401);
  });

  test('state-changing routes reject requests without CSRF token', async () => {
    const res = await request(app)
      .post('/api/v1/admin/coupons')
      .set('Cookie', [sessionCookie])
      .send({ code: 'TESTCSRF', discountValue: 25 });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CSRF_FAILED');
  });

  let createdCouponId = null;

  test('creates a custom coupon and records audit log', async () => {
    const code = `ADM${Date.now().toString().slice(-6)}`;
    const res = await request(app)
      .post('/api/v1/admin/coupons')
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken)
      .send({
        code,
        displayCode: code,
        description: 'Admin created promo',
        discountType: 'PERCENT',
        discountValue: 20,
        categorySlugs: ['teen'],
        maxRedemptions: 50,
        perEmailLimit: 2,
        status: 'ACTIVE'
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.coupon.discountValue, 20);
    assert.equal(res.body.coupon.code, code);

    createdCouponId = res.body.coupon.id;
    createdCouponIds.push(createdCouponId);

    // Verify audit log
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: AUDIT_ACTIONS.COUPON_CREATED,
        entityId: createdCouponId
      }
    });
    assert.ok(audit, 'Audit log must record coupon.created');
    assert.equal(audit.actorEmail, ADMIN_EMAIL);
  });

  test('generates a batch of coupons and records audit log', async () => {
    const res = await request(app)
      .post('/api/v1/admin/coupons/generate')
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken)
      .send({
        count: 5,
        prefix: 'VIP',
        codeLength: 6,
        batchLabel: 'VIP Partners',
        discountValue: 30,
        categorySlugs: []
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.batchId);
    assert.equal(res.body.coupons.length, 5);

    for (const c of res.body.coupons) {
      createdCouponIds.push(c.id);
      assert.ok(c.code.startsWith('VIP'));
    }

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: AUDIT_ACTIONS.COUPON_BATCH_GENERATED,
        entityId: res.body.batchId
      }
    });
    assert.ok(audit, 'Audit log must record coupon.batch.generated');
  });

  test('lists coupons with effectiveStatus, remaining, and aggregations', async () => {
    const res = await request(app)
      .get('/api/v1/admin/coupons')
      .set('Cookie', [sessionCookie]);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.pagination);

    const found = res.body.items.find((c) => c.id === createdCouponId);
    assert.ok(found);
    assert.equal(found.effectiveStatus, 'ACTIVE');
    assert.equal(found.remaining, 50);
    assert.equal(found.consumedCount, 0);
  });

  test('coupons summary endpoint returns tiles and metrics', async () => {
    const res = await request(app)
      .get('/api/v1/admin/coupons/summary')
      .set('Cookie', [sessionCookie]);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.summary.totalCoupons >= 6);
    assert.ok(res.body.summary.activeCoupons >= 6);
    assert.ok(Array.isArray(res.body.summary.topCoupons));
  });

  test('detail view returns config, stats, and redemptions', async () => {
    const res = await request(app)
      .get(`/api/v1/admin/coupons/${createdCouponId}`)
      .set('Cookie', [sessionCookie]);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.coupon.id, createdCouponId);
    assert.ok(res.body.stats);
    assert.ok(Array.isArray(res.body.recentRedemptions));
  });

  test('pause and resume coupon toggles operator intent and audits', async () => {
    const pauseRes = await request(app)
      .post(`/api/v1/admin/coupons/${createdCouponId}/pause`)
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken);

    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.body.coupon.status, 'PAUSED');

    const resumeRes = await request(app)
      .post(`/api/v1/admin/coupons/${createdCouponId}/resume`)
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken);

    assert.equal(resumeRes.status, 200);
    assert.equal(resumeRes.body.coupon.status, 'ACTIVE');
  });

  test('immutable rule: editing code or discountValue when redeemedCount > 0 is rejected with COUPON_IMMUTABLE', async () => {
    // Manually set redeemedCount = 1 to simulate a coupon that has been redeemed
    await prisma.coupon.update({
      where: { id: createdCouponId },
      data: { redeemedCount: 1 }
    });

    const editRes = await request(app)
      .patch(`/api/v1/admin/coupons/${createdCouponId}`)
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken)
      .send({ discountValue: 50 });

    assert.equal(editRes.status, 409);
    assert.equal(editRes.body.code, 'COUPON_IMMUTABLE');
    assert.ok(editRes.body.error.includes('can no longer be changed'));

    // Reset redeemedCount to 0
    await prisma.coupon.update({
      where: { id: createdCouponId },
      data: { redeemedCount: 0 }
    });
  });

  test('integrity endpoint detects corrupted counter drift and stale reservations', async () => {
    // Corrupt the counter of createdCouponId: set redeemedCount = 5 without ledger rows
    await prisma.coupon.update({
      where: { id: createdCouponId },
      data: { redeemedCount: 5 }
    });

    const res = await request(app)
      .get('/api/v1/admin/coupons/integrity')
      .set('Cookie', [sessionCookie]);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.integrity.inSync, false);
    assert.ok(res.body.integrity.driftCount >= 1);

    const issue = res.body.integrity.issues.find((i) => i.couponId === createdCouponId);
    assert.ok(issue);
    assert.equal(issue.redeemedCount, 5);
    assert.equal(issue.ledgerCount, 0);
    assert.equal(issue.drift, 5);

    // Fix counter back
    await prisma.coupon.update({
      where: { id: createdCouponId },
      data: { redeemedCount: 0 }
    });
  });

  test('manual sweeper maintenance endpoint releases stale holds and audits', async () => {
    const res = await request(app)
      .post('/api/v1/admin/coupons/maintenance/release-stale')
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken)
      .send({ ttlMinutes: 30 });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.sweptCount === 'number');

    const audit = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.COUPON_RESERVATIONS_SWEPT }
    });
    assert.ok(audit);
  });

  test('deleting an unused coupon hard-deletes it; deleting a used coupon archives it', async () => {
    // 1. Unused coupon -> DELETED
    const unusedRes = await request(app)
      .delete(`/api/v1/admin/coupons/${createdCouponId}`)
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken);

    assert.equal(unusedRes.status, 200);
    assert.equal(unusedRes.body.action, 'DELETED');

    const checkDel = await prisma.coupon.findUnique({ where: { id: createdCouponId } });
    assert.equal(checkDel, null);

    // 2. Used coupon -> ARCHIVED
    const codeUsed = `USED${Date.now().toString().slice(-6)}`;
    const usedCpn = await prisma.coupon.create({
      data: {
        code: codeUsed,
        displayCode: codeUsed,
        discountType: 'PERCENT',
        discountValue: 15,
        redeemedCount: 1,
        status: 'ACTIVE'
      }
    });
    createdCouponIds.push(usedCpn.id);

    const usedRes = await request(app)
      .delete(`/api/v1/admin/coupons/${usedCpn.id}`)
      .set('Cookie', [sessionCookie])
      .set('x-csrf-token', csrfToken);

    assert.equal(usedRes.status, 200);
    assert.equal(usedRes.body.action, 'ARCHIVED');

    const checkArchived = await prisma.coupon.findUnique({ where: { id: usedCpn.id } });
    assert.equal(checkArchived.isArchived, true);
    assert.ok(checkArchived.archivedAt);
  });

  test('CSV exports for coupons and coupon-redemptions have headers, BOM, and row count', async () => {
    const cpnExport = await request(app)
      .get('/api/v1/admin/reports/coupons/export')
      .set('Cookie', [sessionCookie]);

    assert.equal(cpnExport.status, 200);
    assert.equal(cpnExport.headers['content-type'], 'text/csv; charset=utf-8');
    assert.ok(cpnExport.headers['x-row-count']);
    assert.ok(cpnExport.text.startsWith('\uFEFF')); // UTF-8 BOM
    assert.ok(cpnExport.text.includes('Code,Display code,Description,Discount type'));

    const redExport = await request(app)
      .get('/api/v1/admin/reports/coupon-redemptions/export')
      .set('Cookie', [sessionCookie]);

    assert.equal(redExport.status, 200);
    assert.equal(redExport.headers['content-type'], 'text/csv; charset=utf-8');
    assert.ok(redExport.headers['x-row-count']);
    assert.ok(redExport.text.startsWith('\uFEFF'));
    assert.ok(redExport.text.includes('Reference,Participant,Email,Category'));
  });
});
