import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

/**
 * Admin API integration tests.
 *
 * These run against whatever DATABASE_URL points at, like the rest of this
 * suite. They create one administrator under a reserved address and remove it,
 * its sessions and its audit rows afterwards, so they add nothing permanent to
 * the data — but point DATABASE_URL at a scratch database before running the
 * full suite regardless: the registration tests here create live-looking
 * registration and payment rows that nothing cleans up.
 */

const TEST_EMAIL = 'automated-test-admin@example.invalid';
const TEST_PASSWORD = 'TestAdmin@2026!';

/** Pulls one cookie's value out of a set-cookie header array. */
function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

async function removeTestAdmin() {
  const existing = await prisma.adminUser.findUnique({ where: { email: TEST_EMAIL } });
  if (!existing) return;
  await prisma.auditLog.deleteMany({ where: { adminUserId: existing.id } });
  await prisma.auditLog.deleteMany({ where: { actorEmail: TEST_EMAIL } });
  await prisma.adminNote.deleteMany({ where: { adminUserId: existing.id } });
  await prisma.adminSession.deleteMany({ where: { adminUserId: existing.id } });
  await prisma.adminUser.delete({ where: { id: existing.id } });
}

test('Admin API', async (t) => {
  await setupTestEnvironment();
  await removeTestAdmin();

  await prisma.adminUser.create({
    data: {
      email: TEST_EMAIL,
      name: 'Automated Test Admin',
      passwordHash: await hashPassword(TEST_PASSWORD),
      mustChangePassword: false,
      isActive: true
    }
  });

  t.after(async () => {
    await removeTestAdmin();
    await teardownTestEnvironment();
  });

  // ------------------------------------------------------------- unauthenticated

  await t.test('every admin route refuses an unauthenticated request', async () => {
    const routes = [
      '/api/v1/admin/overview',
      '/api/v1/admin/registrations',
      '/api/v1/admin/payments',
      '/api/v1/admin/participants',
      '/api/v1/admin/categories',
      '/api/v1/admin/contest',
      '/api/v1/admin/emails',
      '/api/v1/admin/audit',
      '/api/v1/admin/settings',
      '/api/v1/admin/reports',
      '/api/v1/admin/reports/registrations/export'
    ];

    for (const route of routes) {
      const res = await request(app).get(route);
      assert.strictEqual(res.status, 401, `${route} must require authentication`);
      assert.strictEqual(res.body.code, 'SESSION_EXPIRED');
    }
  });

  await t.test('a forged session cookie does not authenticate', async () => {
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', ['sss_admin_session=not-a-real-token']);
    assert.strictEqual(res.status, 401);
  });

  // --------------------------------------------------------------------- login

  await t.test('rejects a wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_EMAIL, password: 'WrongPassword@2026' });

    const unknownAccount = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'nobody@example.invalid', password: 'WrongPassword@2026' });

    assert.strictEqual(wrongPassword.status, 401);
    assert.strictEqual(unknownAccount.status, 401);
    // Identical wording, so the response cannot be used to enumerate admins.
    assert.strictEqual(wrongPassword.body.error, unknownAccount.body.error);
    assert.strictEqual(wrongPassword.body.code, 'INVALID_CREDENTIALS');
  });

  await t.test('requires both fields', async () => {
    const res = await request(app).post('/api/v1/admin/auth/login').send({ email: TEST_EMAIL });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'MISSING_CREDENTIALS');
  });

  let sessionCookie;
  let csrfToken;

  await t.test('signs in with correct credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.admin.email, TEST_EMAIL);

    const setCookie = res.headers['set-cookie'];
    const sessionHeader = setCookie.find((c) => c.startsWith('sss_admin_session='));
    const csrfHeader = setCookie.find((c) => c.startsWith('sss_admin_csrf='));

    // The session cookie must be unreadable to JavaScript; the CSRF cookie must
    // be readable, because the dashboard has to echo it back in a header.
    assert.match(sessionHeader, /HttpOnly/i);
    assert.ok(!/HttpOnly/i.test(csrfHeader), 'the CSRF cookie must be script-readable');

    sessionCookie = cookieValue(setCookie, 'sss_admin_session');
    csrfToken = cookieValue(setCookie, 'sss_admin_csrf');
    assert.ok(sessionCookie && sessionCookie.length > 20);
  });

  await t.test('returns the CSRF token in the login body, not only as a cookie', async () => {
    // A dashboard on a different host than this API cannot read the CSRF
    // cookie — it is scoped to the API's host. Without the token in the body,
    // every mutating request from such a deployment fails with CSRF_FAILED.
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.csrfToken, 'login must return a csrfToken in the body');
    assert.strictEqual(res.body.csrfToken, cookieValue(res.headers['set-cookie'], 'sss_admin_csrf'));
  });

  await t.test('accepts the body-supplied CSRF token with no CSRF cookie sent', async () => {
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    const session = cookieValue(login.headers['set-cookie'], 'sss_admin_session');
    const token = login.body.csrfToken;

    // Deliberately sends ONLY the session cookie, reproducing a cross-host
    // dashboard that cannot see the CSRF cookie at all.
    const res = await request(app)
      .post('/api/v1/admin/registrations/SSS-2026-NOTREAL/notes')
      .set('Cookie', [`sss_admin_session=${session}`])
      .set('x-csrf-token', token)
      .send({ body: 'csrf accepted' });

    // 404 means it passed CSRF and reached the handler, which then could not
    // find that registration. Anything 403 would mean CSRF rejected it.
    assert.notStrictEqual(res.status, 403, 'the body-supplied token must be accepted');
    assert.strictEqual(res.status, 404);
  });

  await t.test('/auth/me returns the CSRF token so a page reload can recover it', async () => {
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const session = cookieValue(login.headers['set-cookie'], 'sss_admin_session');

    const me = await request(app)
      .get('/api/v1/admin/auth/me')
      .set('Cookie', [`sss_admin_session=${session}`]);

    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.csrfToken, login.body.csrfToken);
  });

  await t.test('never returns a password hash to the client', async () => {
    const res = await request(app)
      .get('/api/v1/admin/auth/me')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('passwordHash'), 'the hash must never leave the server');
    assert.ok(!body.includes('scrypt$'), 'no hash material may appear in a response');
    assert.ok(!body.includes(TEST_PASSWORD), 'the password must never be echoed');
  });

  // ---------------------------------------------------------------------- CSRF

  await t.test('rejects a state-changing request with no CSRF header', async () => {
    const res = await request(app)
      .post('/api/v1/admin/registrations/SSS-2026-NOTREAL/notes')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .send({ body: 'should never be written' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'CSRF_FAILED');
  });

  await t.test('rejects a wrong CSRF token', async () => {
    const res = await request(app)
      .post('/api/v1/admin/registrations/SSS-2026-NOTREAL/notes')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', 'wrong-token')
      .send({ body: 'should never be written' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'CSRF_FAILED');
  });

  await t.test('allows a read without a CSRF header', async () => {
    const res = await request(app)
      .get('/api/v1/admin/registrations')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);
    assert.strictEqual(res.status, 200);
  });

  // ------------------------------------------------------------------- metrics

  await t.test('reports revenue from captured payments only', async () => {
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);

    const [capturedSum, capturedCount] = await Promise.all([
      prisma.payment.aggregate({ where: { status: 'CAPTURED' }, _sum: { amountPaise: true } }),
      prisma.payment.count({ where: { status: 'CAPTURED' } })
    ]);

    assert.strictEqual(
      res.body.metrics.revenue.collectedPaise,
      Number(capturedSum._sum.amountPaise ?? 0)
    );
    assert.strictEqual(res.body.metrics.revenue.capturedCount, capturedCount);

    // An uncaptured order is not money. If this ever stops holding, the
    // dashboard is reporting revenue that was never collected.
    const notCaptured = await prisma.payment.aggregate({
      where: { status: { not: 'CAPTURED' } },
      _sum: { amountPaise: true }
    });
    if (Number(notCaptured._sum.amountPaise ?? 0) > 0) {
      assert.notStrictEqual(
        res.body.metrics.revenue.collectedPaise,
        Number(capturedSum._sum.amountPaise ?? 0) + Number(notCaptured._sum.amountPaise ?? 0)
      );
    }
  });

  await t.test('keeps registration status and payment status distinct', async () => {
    const res = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    const confirmed = await prisma.registration.count({ where: { status: 'PAID' } });
    assert.strictEqual(res.body.metrics.registrations.confirmed, confirmed);
    assert.ok('payments' in res.body.metrics);
    assert.ok('registrations' in res.body.metrics);
  });

  // ------------------------------------------------------------------ listings

  await t.test('filters registrations by category', async () => {
    const res = await request(app)
      .get('/api/v1/admin/registrations?category=teen&pageSize=50')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    for (const item of res.body.items) {
      assert.strictEqual(item.category, 'teen');
    }
  });

  await t.test('filters registrations by status', async () => {
    const res = await request(app)
      .get('/api/v1/admin/registrations?status=PAID&pageSize=50')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    for (const item of res.body.items) {
      assert.strictEqual(item.status, 'PAID');
    }
  });

  await t.test('ignores an unknown status rather than returning nothing', async () => {
    const res = await request(app)
      .get('/api/v1/admin/registrations?status=NOT_A_STATUS')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    const total = await prisma.registration.count();
    assert.strictEqual(res.body.pagination.total, total);
  });

  await t.test('caps the page size so one request cannot pull the whole table', async () => {
    const res = await request(app)
      .get('/api/v1/admin/registrations?pageSize=100000')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.pagination.pageSize <= 100);
  });

  await t.test('paginates consistently', async () => {
    const first = await request(app)
      .get('/api/v1/admin/registrations?pageSize=2&page=1')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);
    const second = await request(app)
      .get('/api/v1/admin/registrations?pageSize=2&page=2')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(first.body.pagination.total, second.body.pagination.total);

    if (first.body.items.length && second.body.items.length) {
      const firstIds = first.body.items.map((i) => i.id);
      for (const item of second.body.items) {
        assert.ok(!firstIds.includes(item.id), 'pages must not repeat a record');
      }
    }
  });

  await t.test('returns 404 for a registration that does not exist', async () => {
    const res = await request(app)
      .get('/api/v1/admin/registrations/SSS-2026-NOTREAL')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 404);
  });

  await t.test('does not expose a Razorpay signature value in a payment listing', async () => {
    const res = await request(app)
      .get('/api/v1/admin/payments?pageSize=50')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    for (const item of res.body.items) {
      assert.ok(!('razorpaySignature' in item), 'the signature value must not be returned');
      assert.strictEqual(typeof item.signatureOnFile, 'boolean');
    }
  });

  // -------------------------------------------------------------------- export

  await t.test('exports CSV with a filename, a row count and a BOM', async () => {
    const res = await request(app)
      .get('/api/v1/admin/reports/collections/export')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="sss-collections-/);
    assert.ok('x-row-count' in res.headers);
    assert.ok(res.text.startsWith('﻿'));
  });

  await t.test('refuses an unknown report rather than inventing one', async () => {
    const res = await request(app)
      .get('/api/v1/admin/reports/not-a-report/export')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'UNKNOWN_REPORT');
  });

  await t.test('records the export in the audit log', async () => {
    const before = await prisma.auditLog.count({
      where: { actorEmail: TEST_EMAIL, action: 'export.generated' }
    });

    await request(app)
      .get('/api/v1/admin/reports/registrations/export')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    const after = await prisma.auditLog.count({
      where: { actorEmail: TEST_EMAIL, action: 'export.generated' }
    });

    assert.strictEqual(after, before + 1, 'taking personal data out must leave a trace');
  });

  await t.test('never writes a search term into the audit log', async () => {
    await request(app)
      .get('/api/v1/admin/reports/registrations/export?q=SensitiveSearchTerm')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    const entry = await prisma.auditLog.findFirst({
      where: { actorEmail: TEST_EMAIL, action: 'export.generated' },
      orderBy: { createdAt: 'desc' }
    });

    assert.ok(!JSON.stringify(entry.metadata).includes('SensitiveSearchTerm'));
  });

  // ------------------------------------------------------------ settings leak

  await t.test('reports integration status without disclosing any secret', async () => {
    const res = await request(app)
      .get('/api/v1/admin/settings')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    const body = JSON.stringify(res.body);

    for (const secret of [
      process.env.RAZORPAY_KEY_SECRET,
      process.env.RAZORPAY_WEBHOOK_SECRET,
      process.env.DATABASE_URL,
      process.env.SMTP_PASS
    ]) {
      if (secret) assert.ok(!body.includes(secret), 'a secret value leaked into /settings');
    }

    // Presence is operational information; the values are not.
    assert.strictEqual(typeof res.body.system.integrations.razorpay, 'boolean');
    assert.strictEqual(typeof res.body.system.integrations.smtp, 'boolean');
  });

  // ------------------------------------------------- categories are read-only

  await t.test('declares categories read-only and names the source of truth', async () => {
    const res = await request(app)
      .get('/api/v1/admin/categories')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.editable, false);
    assert.ok(res.body.sourceOfTruth.includes('config/event.js'));
    assert.strictEqual(res.body.categories.length, 3);

    const fees = Object.fromEntries(res.body.categories.map((c) => [c.slug, c.feePaise]));
    assert.strictEqual(fees.kid, 9900);
    assert.strictEqual(fees.teen, 19900);
    assert.strictEqual(fees.adult, 29900);
  });

  // ------------------------------------------------------- password + logout

  await t.test('refuses a password change with the wrong current password', async () => {
    const res = await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ currentPassword: 'NotMyPassword@2026', newPassword: 'Another@Password2026' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'INVALID_CURRENT_PASSWORD');
  });

  await t.test('refuses a new password that fails the policy', async () => {
    const res = await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'weak' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'WEAK_PASSWORD');
    assert.ok(Array.isArray(res.body.details));
  });

  await t.test('refuses reusing the current password', async () => {
    const res = await request(app)
      .post('/api/v1/admin/auth/change-password')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'PASSWORD_REUSED');
  });

  await t.test('signing out invalidates the session immediately', async () => {
    const logout = await request(app)
      .post('/api/v1/admin/auth/logout')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken);

    assert.strictEqual(logout.status, 200);

    const afterLogout = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(afterLogout.status, 401, 'a revoked session must not keep working');
    assert.strictEqual(afterLogout.body.code, 'SESSION_EXPIRED');
  });

  // ---------------------------------------------- forced first password change

  await t.test('blocks dashboard routes while the bootstrap password stands', async () => {
    await prisma.adminUser.update({
      where: { email: TEST_EMAIL },
      data: { mustChangePassword: true }
    });

    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    assert.strictEqual(login.body.admin.mustChangePassword, true);
    const cookie = cookieValue(login.headers['set-cookie'], 'sss_admin_session');

    const blocked = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', [`sss_admin_session=${cookie}`]);

    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');

    // The routes needed to resolve it must stay reachable, or the account is
    // locked out of fixing itself.
    const me = await request(app)
      .get('/api/v1/admin/auth/me')
      .set('Cookie', [`sss_admin_session=${cookie}`]);
    assert.strictEqual(me.status, 200);
  });
});
