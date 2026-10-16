import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/services/adminAuth.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

const ADMIN_EMAIL = 'inv-coupon-admin@example.invalid';
const ADMIN_PASSWORD = 'CouponAdmin@2026!';

function cookieValue(setCookie, name) {
  const header = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].split('=').slice(1).join('=') : null;
}

test('Invitation Coupon Application and Checkout Flow', async (t) => {
  await setupTestEnvironment();

  // Cleanup test users
  await prisma.adminSession.deleteMany({
    where: { adminUser: { email: ADMIN_EMAIL } }
  });
  await prisma.auditLog.deleteMany({
    where: { actorEmail: ADMIN_EMAIL }
  });
  await prisma.adminUser.deleteMany({
    where: { email: ADMIN_EMAIL }
  });

  // Create test admin
  await prisma.adminUser.create({
    data: {
      email: ADMIN_EMAIL,
      name: 'Coupon Admin',
      role: 'ADMIN',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      mustChangePassword: false,
      isActive: true
    }
  });

  t.after(async () => {
    await prisma.adminSession.deleteMany({
      where: { adminUser: { email: ADMIN_EMAIL } }
    });
    await prisma.auditLog.deleteMany({
      where: { actorEmail: ADMIN_EMAIL }
    });
    await prisma.adminUser.deleteMany({
      where: { email: ADMIN_EMAIL }
    });
    await teardownTestEnvironment();
  });

  let adminSessionCookie;
  let adminCsrfToken;

  // 1. Setup: Admin Login
  await t.test('Admin can login', async () => {
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    assert.strictEqual(res.status, 200);
    adminSessionCookie = cookieValue(res.headers['set-cookie'], 'sss_admin_session');
    adminCsrfToken = cookieValue(res.headers['set-cookie'], 'sss_admin_csrf');
    assert.ok(adminSessionCookie);
    assert.ok(adminCsrfToken);
  });

  // 2. Create coupon in database
  const couponCode = `INV${Date.now().toString().slice(-4)}`;
  let testCoupon;
  await t.test('Admin creates a test 20% coupon', async () => {
    const res = await request(app)
      .post('/api/v1/admin/coupons')
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({
        code: couponCode,
        displayCode: couponCode,
        discountType: 'PERCENT',
        discountValue: 20,
        categorySlugs: ['kid', 'teen', 'adult'],
        maxRedemptions: 10
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    testCoupon = res.body.coupon;
  });

  // 3. Participant submits registration without coupon
  let kidRef;
  const participantEmail = `coupon_flow_${Date.now()}@example.com`;
  await t.test('Registration submitted via POST /applications ignores any coupon and stays pending', async () => {
    const res = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Coupon Tester',
        email: participantEmail,
        phone: '9876543210',
        dob: '2016-05-15',
        category: 'kid',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Coupon Guardian',
        guardianRelationship: 'Father',
        guardianPhone: '9876543219',
        guardianEmail: 'coupon.guardian@example.com',
        couponCode: couponCode // Should be ignored during initial registration
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    kidRef = res.body.application.reference;

    // Verify DB: no coupon attached at registration time
    const reg = await prisma.registration.findUnique({ where: { reference: kidRef } });
    assert.strictEqual(reg.status, 'PENDING_REVIEW');
    assert.strictEqual(reg.couponId, null);
    assert.strictEqual(reg.couponCode, null);
    assert.strictEqual(reg.discountPaise, 0);
    assert.strictEqual(reg.amountPaise, 25000);
  });

  // 4. Admin shortlists and sends payment invitation
  let invitationToken;
  await t.test('Admin shortlists applicant and sends payment invitation', async () => {
    const shortlistRes = await request(app)
      .post(`/api/v1/admin/registrations/${kidRef}/shortlist`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ reviewNotes: 'Strong profile' });

    assert.strictEqual(shortlistRes.status, 200);

    const linkRes = await request(app)
      .post(`/api/v1/admin/registrations/${kidRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ expiryDays: 5 });

    assert.strictEqual(linkRes.status, 200);
    assert.ok(linkRes.body.invitation);
    invitationToken = linkRes.body.invitation.token;
  });

  // 5. Participant checks invitation before coupon
  await t.test('GET /invitations/:token returns initial fee without coupon', async () => {
    const res = await request(app).get(`/api/v1/invitations/${invitationToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const { invitation } = res.body;
    assert.strictEqual(invitation.amountPaise, 25000);
    assert.strictEqual(invitation.amountRupees, 250);
    assert.strictEqual(invitation.baseAmountRupees, 250);
    assert.strictEqual(invitation.discountRupees, 0);
    assert.strictEqual(invitation.coupon, null);
    assert.strictEqual(invitation.isPayable, true);
  });

  // 6. Test invalid coupon on invitation
  await t.test('POST /invitations/:token/apply-coupon rejects invalid code', async () => {
    const res = await request(app)
      .post(`/api/v1/invitations/${invitationToken}/apply-coupon`)
      .send({ couponCode: 'INVALID_CODE_999' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
  });

  // 7. Apply valid 20% coupon on invitation
  await t.test('POST /invitations/:token/apply-coupon calculates 20% discount server-side', async () => {
    const res = await request(app)
      .post(`/api/v1/invitations/${invitationToken}/apply-coupon`)
      .send({ couponCode });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const { invitation } = res.body;

    // 20% off 25000 paise is 5000 paise discount = 20000 paise (₹200) payable
    assert.strictEqual(invitation.baseAmountPaise, 25000);
    assert.strictEqual(invitation.discountPaise, 5000);
    assert.strictEqual(invitation.amountPaise, 20000);
    assert.strictEqual(invitation.amountRupees, 200);
    assert.strictEqual(invitation.coupon.code, couponCode);

    // Verify registration and invitation rows in DB
    const reg = await prisma.registration.findUnique({ where: { reference: kidRef } });
    assert.strictEqual(reg.amountPaise, 20000);
    assert.strictEqual(reg.discountPaise, 5000);
    assert.strictEqual(reg.couponId, testCoupon.id);

    const inv = await prisma.paymentInvitation.findUnique({ where: { token: invitationToken } });
    assert.strictEqual(inv.amountPaise, 20000);
  });

  // 8. Cannot stack coupons
  await t.test('Applying another coupon while one is active returns 409', async () => {
    const res = await request(app)
      .post(`/api/v1/invitations/${invitationToken}/apply-coupon`)
      .send({ couponCode });

    assert.strictEqual(res.status, 409);
  });

  // 9. Remove coupon restores original authoritative fee
  await t.test('DELETE /invitations/:token/coupon restores original fee', async () => {
    const res = await request(app)
      .delete(`/api/v1/invitations/${invitationToken}/coupon`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.invitation.amountPaise, 25000);
    assert.strictEqual(res.body.invitation.discountPaise, 0);
    assert.strictEqual(res.body.invitation.coupon, null);

    // Verify DB restored
    const reg = await prisma.registration.findUnique({ where: { reference: kidRef } });
    assert.strictEqual(reg.amountPaise, 25000);
    assert.strictEqual(reg.discountPaise, 0);
    assert.strictEqual(reg.couponId, null);

    const inv = await prisma.paymentInvitation.findUnique({ where: { token: invitationToken } });
    assert.strictEqual(inv.amountPaise, 25000);
  });

  // 10. Re-apply coupon and create checkout order
  let checkoutOrderId;
  await t.test('Checkout creates Razorpay order for coupon-discounted amount', async () => {
    // Re-apply coupon
    await request(app)
      .post(`/api/v1/invitations/${invitationToken}/apply-coupon`)
      .send({ couponCode });

    const orderRes = await request(app)
      .post(`/api/v1/invitations/${invitationToken}/checkout`);

    assert.strictEqual(orderRes.status, 200);
    assert.strictEqual(orderRes.body.success, true);
    assert.ok(orderRes.body.order.id);
    // Order amount MUST be ₹200 (20000 paise), not the unadjusted ₹250
    assert.strictEqual(orderRes.body.order.amount, 20000);
    checkoutOrderId = orderRes.body.order.id;
  });

  // 11. Verify payment confirms booking and marks coupon CONSUMED
  await t.test('Verify payment confirms booking and marks coupon CONSUMED', async () => {
    const crypto = await import('node:crypto');
    const secret = process.env.RAZORPAY_KEY_SECRET || 'test_secret_12345';
    const paymentId = `pay_inv_test_${Date.now()}`;
    const signature = crypto.default
      .createHmac('sha256', secret)
      .update(`${checkoutOrderId}|${paymentId}`)
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/payments/verify')
      .send({
        razorpay_order_id: checkoutOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        invitationToken
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.registration.status, 'CONFIRMED');

    // DB checks
    const reg = await prisma.registration.findUnique({ where: { reference: kidRef } });
    assert.strictEqual(reg.status, 'CONFIRMED');
    assert.strictEqual(reg.amountPaise, 20000);

    const inv = await prisma.paymentInvitation.findUnique({ where: { token: invitationToken } });
    assert.strictEqual(inv.status, 'PAID');

    const redemption = await prisma.couponRedemption.findFirst({
      where: { registrationId: reg.id, couponId: testCoupon.id },
      orderBy: { createdAt: 'desc' }
    });
    assert.ok(redemption);
    assert.strictEqual(redemption.status, 'CONSUMED');
  });

  // 12. Complimentary 100% coupon test
  const freeCouponCode = `FREE${Date.now().toString().slice(-4)}`;
  await t.test('100% complimentary coupon instantly confirms booking without Razorpay', async () => {
    // Create 100% coupon
    await request(app)
      .post('/api/v1/admin/coupons')
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({
        code: freeCouponCode,
        displayCode: freeCouponCode,
        discountType: 'PERCENT',
        discountValue: 100,
        categorySlugs: ['teen']
      });

    // Create teen registration
    const appRes = await request(app)
      .post('/api/v1/applications')
      .send({
        fullName: 'Free Tester',
        email: `free_${Date.now()}@example.com`,
        phone: '9876543211',
        dob: '2010-06-15',
        category: 'teen',
        occupation: 'Student',
        city: 'Salem',
        guardianName: 'Free Guardian',
        guardianRelationship: 'Mother',
        guardianPhone: '9876543218',
        guardianEmail: 'free.guardian@example.com'
      });

    const teenRef = appRes.body.application.reference;

    // Shortlist and send invitation
    await request(app)
      .post(`/api/v1/admin/registrations/${teenRef}/shortlist`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({});

    const linkRes = await request(app)
      .post(`/api/v1/admin/registrations/${teenRef}/send-payment-link`)
      .set('Cookie', [`sss_admin_session=${adminSessionCookie}`])
      .set('x-csrf-token', adminCsrfToken)
      .send({ expiryDays: 5 });

    const teenToken = linkRes.body.invitation.token;

    // Apply 100% free coupon
    const applyRes = await request(app)
      .post(`/api/v1/invitations/${teenToken}/apply-coupon`)
      .send({ couponCode: freeCouponCode });

    assert.strictEqual(applyRes.status, 200);
    assert.strictEqual(applyRes.body.success, true);
    assert.strictEqual(applyRes.body.freeRegistration, true);
    assert.strictEqual(applyRes.body.invitation.status, 'CONFIRMED');

    // DB verify
    const teenReg = await prisma.registration.findUnique({ where: { reference: teenRef } });
    assert.strictEqual(teenReg.status, 'CONFIRMED');
    assert.strictEqual(teenReg.amountPaise, 0);

    const teenInv = await prisma.paymentInvitation.findUnique({ where: { token: teenToken } });
    assert.strictEqual(teenInv.status, 'PAID');
  });
});
