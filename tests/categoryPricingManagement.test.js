import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/adminAuth.js';

const TEST_EMAIL = 'pricing-test-admin@example.invalid';
const TEST_PASSWORD = 'TestAdmin@2026!';

function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

test('Category Entry Amount Management Feature', async (t) => {
  let sessionCookie;
  let csrfToken;

  // Clean up any previous test admin
  await prisma.adminSession.deleteMany({ where: { adminUser: { email: TEST_EMAIL } } });
  await prisma.auditLog.deleteMany({ where: { actorEmail: TEST_EMAIL } });
  await prisma.adminUser.deleteMany({ where: { email: TEST_EMAIL } });

  // Provision test admin
  await prisma.adminUser.create({
    data: {
      email: TEST_EMAIL,
      name: 'Pricing Test Admin',
      passwordHash: await hashPassword(TEST_PASSWORD),
      mustChangePassword: false,
      isActive: true,
      role: 'ADMIN'
    }
  });

  t.after(async () => {
    await prisma.adminSession.deleteMany({ where: { adminUser: { email: TEST_EMAIL } } });
    await prisma.auditLog.deleteMany({ where: { actorEmail: TEST_EMAIL } });
    await prisma.adminUser.deleteMany({ where: { email: TEST_EMAIL } });
  });

  // Login as admin
  const loginRes = await request(app)
    .post('/api/v1/admin/auth/login')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  assert.strictEqual(loginRes.status, 200);
  sessionCookie = cookieValue(loginRes.headers['set-cookie'], 'sss_admin_session');
  csrfToken = loginRes.body.csrfToken;
  assert.ok(sessionCookie);
  assert.ok(csrfToken);

  // Clean state: reset categories to standard defaults first
  await prisma.category.upsert({
    where: { slug: 'kid' },
    update: { feePaise: 9900 },
    create: {
      slug: 'kid',
      name: 'Kids',
      formLabel: 'Junior (10-13 years)',
      minAge: 10,
      maxAge: 13,
      feePaise: 9900,
      currency: 'INR',
      isActive: true
    }
  });
  await prisma.category.upsert({
    where: { slug: 'teen' },
    update: { feePaise: 19900 },
    create: {
      slug: 'teen',
      name: 'Teens',
      formLabel: 'Teens (14-17 years)',
      minAge: 14,
      maxAge: 17,
      feePaise: 19900,
      currency: 'INR',
      isActive: true
    }
  });
  await prisma.category.upsert({
    where: { slug: 'adult' },
    update: { feePaise: 29900 },
    create: {
      slug: 'adult',
      name: 'Adults',
      formLabel: 'Adults (18+)',
      minAge: 18,
      maxAge: 99,
      feePaise: 29900,
      currency: 'INR',
      isActive: true
    }
  });

  // 1. Update Kids amount; verify Teens and Adults amounts remain unchanged
  await t.test('Scenario 1: Update Kids amount; verify Teens and Adults remain unchanged', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: 120 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.category.feePaise, 12000);
    assert.strictEqual(res.body.category.feeRupees, 120);

    // Verify database state
    const kid = await prisma.category.findUnique({ where: { slug: 'kid' } });
    const teen = await prisma.category.findUnique({ where: { slug: 'teen' } });
    const adult = await prisma.category.findUnique({ where: { slug: 'adult' } });

    assert.strictEqual(kid.feePaise, 12000);
    assert.strictEqual(teen.feePaise, 19900, 'Teens must remain unchanged');
    assert.strictEqual(adult.feePaise, 29900, 'Adults must remain unchanged');
  });

  // 2. Update Teens amount; verify other categories remain unchanged
  await t.test('Scenario 2: Update Teens amount; verify other categories remain unchanged', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/categories/teen')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: 220 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.category.feePaise, 22000);
    assert.strictEqual(res.body.category.feeRupees, 220);

    const kid = await prisma.category.findUnique({ where: { slug: 'kid' } });
    const teen = await prisma.category.findUnique({ where: { slug: 'teen' } });
    const adult = await prisma.category.findUnique({ where: { slug: 'adult' } });

    assert.strictEqual(kid.feePaise, 12000, 'Kids must remain 12000');
    assert.strictEqual(teen.feePaise, 22000);
    assert.strictEqual(adult.feePaise, 29900, 'Adults must remain unchanged');
  });

  // 3. Update Adults amount; verify other categories remain unchanged
  await t.test('Scenario 3: Update Adults amount; verify other categories remain unchanged', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/categories/adult')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: 350 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.category.feePaise, 35000);

    const kid = await prisma.category.findUnique({ where: { slug: 'kid' } });
    const teen = await prisma.category.findUnique({ where: { slug: 'teen' } });
    const adult = await prisma.category.findUnique({ where: { slug: 'adult' } });

    assert.strictEqual(kid.feePaise, 12000);
    assert.strictEqual(teen.feePaise, 22000);
    assert.strictEqual(adult.feePaise, 35000);
  });

  // 4. Apply common amount; verify every category is updated
  await t.test('Scenario 4: Apply common amount; verify every category is updated', async () => {
    const res = await request(app)
      .post('/api/v1/admin/categories/common-amount')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: 275 });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.categories.length, 3);

    for (const c of res.body.categories) {
      assert.strictEqual(c.feePaise, 27500);
      assert.strictEqual(c.feeRupees, 275);
    }

    const allInDb = await prisma.category.findMany();
    for (const cat of allInDb) {
      assert.strictEqual(cat.feePaise, 27500, `Category ${cat.slug} must be updated to 27500 paise`);
    }

    // Verify audit log
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'category.fee.updated_all' },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(audit);
    assert.strictEqual(audit.entityId, 'ALL');
    assert.strictEqual(audit.metadata.newFeeRupees, 275);
  });

  // 6. Submit invalid, missing, or negative amounts; verify rejection
  await t.test('Scenario 6: Server rejects missing, non-numeric, negative, or invalid amounts', async () => {
    // Missing
    const missingRes = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({});
    assert.strictEqual(missingRes.status, 400);

    // Negative
    const negRes = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: -100 });
    assert.strictEqual(negRes.status, 400);

    // Non-numeric
    const nonNumRes = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: 'abc' });
    assert.strictEqual(nonNumRes.status, 400);

    // Excessive decimal places
    const decRes = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: '99.999' });
    assert.strictEqual(decRes.status, 400);

    // Common amount negative
    const commonNegRes = await request(app)
      .post('/api/v1/admin/categories/common-amount')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: -50 });
    assert.strictEqual(commonNegRes.status, 400);
  });

  // 8. Amounts persist across requests
  await t.test('Scenario 8: Amounts persist across new requests and GET /categories', async () => {
    const res = await request(app)
      .get('/api/v1/admin/categories')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`]);

    assert.strictEqual(res.status, 200);
    const fees = Object.fromEntries(res.body.categories.map((c) => [c.slug, c.feePaise]));
    assert.strictEqual(fees.kid, 27500);
    assert.strictEqual(fees.teen, 27500);
    assert.strictEqual(fees.adult, 27500);
  });

  // 9. Public event config endpoint reflects the database prices
  await t.test('Scenario 9: Public /event endpoint returns updated fees from database', async () => {
    const res = await request(app).get('/api/v1/event');
    assert.strictEqual(res.status, 200);
    const fees = Object.fromEntries(res.body.categories.map((c) => [c.slug, c.feePaise]));
    assert.strictEqual(fees.kid, 27500);
    assert.strictEqual(fees.teen, 27500);
    assert.strictEqual(fees.adult, 27500);
  });

  // 10. Payment invitation workflow uses updated fee and handles pricing changes safely
  await t.test('Scenario 10: Payment invitation workflow derives new fee and prevents stale link reuse', async () => {
    // 1. Submit an application in 'teen' category
    const appRes = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Pricing Test Participant',
        email: 'pricing.test@example.com',
        phone: '9840199999',
        dob: '2010-05-15',
        category: 'teen',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Pricing Guardian',
        guardianRelationship: 'Mother',
        guardianPhone: '9840188888',
        guardianEmail: 'pricing.guardian@example.com'
      });

    assert.strictEqual(appRes.status, 201);
    const ref = appRes.body.registration?.reference || appRes.body.reference;
    assert.ok(ref, 'Reference must exist in response');

    // 2. Shortlist applicant
    const shortlistRes = await request(app)
      .post(`/api/v1/admin/registrations/${ref}/shortlist`)
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ notes: 'Shortlisted for pricing verification' });
    assert.strictEqual(shortlistRes.status, 200);

    // 3. Send payment link when teen fee is 27500 paise
    const linkRes1 = await request(app)
      .post(`/api/v1/admin/registrations/${ref}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({});
    assert.strictEqual(linkRes1.status, 200);
    assert.strictEqual(linkRes1.body.invitation.amountPaise, 27500, 'Invitation must use configured 27500 fee');
    const firstToken = linkRes1.body.invitation.token;

    // 4. Administrator updates Teens amount to 320 (32000 paise)
    await request(app)
      .patch('/api/v1/admin/categories/teen')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({ amountRupees: 320 });

    // 5. Send payment link again: Because fee changed, old link must not be silently reused!
    // A fresh invitation with 32000 paise must be issued and old one cancelled.
    const linkRes2 = await request(app)
      .post(`/api/v1/admin/registrations/${ref}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .set('x-csrf-token', csrfToken)
      .send({});
    assert.strictEqual(linkRes2.status, 200);
    assert.strictEqual(linkRes2.body.invitation.amountPaise, 32000, 'New invitation must reflect updated ₹320 fee');
    assert.notStrictEqual(linkRes2.body.invitation.token, firstToken, 'Must generate new link rather than reusing stale amount');

    // Confirm old invitation is marked CANCELLED
    const oldInv = await prisma.paymentInvitation.findUnique({ where: { token: firstToken } });
    assert.strictEqual(oldInv.status, 'CANCELLED');
  });

  // 11. Unauthorized API requests cannot update pricing
  await t.test('Scenario 11: Unauthorized requests are rejected', async () => {
    // No session
    const noAuthRes = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .send({ amountRupees: 100 });
    assert.strictEqual(noAuthRes.status, 401);

    // Common amount without session
    const noAuthCommon = await request(app)
      .post('/api/v1/admin/categories/common-amount')
      .send({ amountRupees: 100 });
    assert.strictEqual(noAuthCommon.status, 401);

    // Without CSRF token
    const noCsrfRes = await request(app)
      .patch('/api/v1/admin/categories/kid')
      .set('Cookie', [`sss_admin_session=${sessionCookie}`])
      .send({ amountRupees: 100 });
    assert.strictEqual(noCsrfRes.status, 403);
  });

  // Cleanup: Restore standard default amounts (250, 250, 250)
  await prisma.category.update({ where: { slug: 'kid' }, data: { feePaise: 25000 } });
  await prisma.category.update({ where: { slug: 'teen' }, data: { feePaise: 25000 } });
  await prisma.category.update({ where: { slug: 'adult' }, data: { feePaise: 25000 } });
});
