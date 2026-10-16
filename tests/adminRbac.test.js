import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { hashPassword, createSession } from '../src/services/adminAuth.js';
import { seedAdmin } from '../prisma/seedAdmin.js';
import { seed } from '../prisma/seed.js';
import { setupTestEnvironment, teardownTestEnvironment } from './helpers/testDb.js';

const SUPER_ADMIN_EMAIL = 'test_super_admin@example.com';
const SECOND_SUPER_ADMIN_EMAIL = 'test_second_super_admin@example.com';
const STANDARD_ADMIN_EMAIL = 'test_standard_admin@example.com';
const TEST_PASSWORD = 'Password@12345';

async function cleanupTestAdmins() {
  const emails = [
    SUPER_ADMIN_EMAIL,
    SECOND_SUPER_ADMIN_EMAIL,
    STANDARD_ADMIN_EMAIL,
    'new_admin_by_super@example.com',
    'new_super_by_super@example.com',
    'new_admin_by_admin@example.com',
    'delete_target@example.com',
    'deactivate_target@example.com',
    'reset_target@example.com',
    'duplicate_check@example.com'
  ];

  for (const email of emails) {
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) {
      await prisma.auditLog.deleteMany({ where: { adminUserId: existing.id } });
      await prisma.auditLog.deleteMany({ where: { actorEmail: email } });
      await prisma.adminSession.deleteMany({ where: { adminUserId: existing.id } });
      await prisma.adminUser.delete({ where: { id: existing.id } });
    }
  }
}

test('Role-Based Access Control (RBAC) & Production User Management', async (t) => {
  await setupTestEnvironment();
  await cleanupTestAdmins();

  const passwordHash = await hashPassword(TEST_PASSWORD);

  // Seed two super-admins and one standard admin
  const superAdmin = await prisma.adminUser.create({
    data: {
      email: SUPER_ADMIN_EMAIL,
      name: 'Super Admin One',
      passwordHash,
      role: 'SUPER_ADMIN',
      mustChangePassword: false,
      isActive: true
    }
  });

  const secondSuperAdmin = await prisma.adminUser.create({
    data: {
      email: SECOND_SUPER_ADMIN_EMAIL,
      name: 'Super Admin Two',
      passwordHash,
      role: 'SUPER_ADMIN',
      mustChangePassword: false,
      isActive: true
    }
  });

  const standardAdmin = await prisma.adminUser.create({
    data: {
      email: STANDARD_ADMIN_EMAIL,
      name: 'Standard Admin',
      passwordHash,
      role: 'ADMIN',
      mustChangePassword: false,
      isActive: true
    }
  });

  t.after(async () => {
    await cleanupTestAdmins();
    await teardownTestEnvironment();
  });

  async function login(email) {
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email, password: TEST_PASSWORD });
    assert.strictEqual(res.status, 200, `Login for ${email} must succeed`);
    const cookie = res.headers['set-cookie']
      .find((c) => c.startsWith('sss_admin_session='))
      ?.split(';')[0];
    return { cookie, csrfToken: res.body.csrfToken, user: res.body.admin };
  }

  // 1. Existing dashboard access: SUPER_ADMIN
  await t.test('SUPER_ADMIN can access all existing dashboard features', async () => {
    const { cookie } = await login(SUPER_ADMIN_EMAIL);

    const [overview, registrations, coupons, settings] = await Promise.all([
      request(app).get('/api/v1/admin/overview').set('Cookie', [cookie]),
      request(app).get('/api/v1/admin/registrations').set('Cookie', [cookie]),
      request(app).get('/api/v1/admin/coupons').set('Cookie', [cookie]),
      request(app).get('/api/v1/admin/settings').set('Cookie', [cookie])
    ]);

    assert.strictEqual(overview.status, 200);
    assert.strictEqual(registrations.status, 200);
    assert.strictEqual(coupons.status, 200);
    assert.strictEqual(settings.status, 200);
  });

  // 2. Existing dashboard access: ADMIN
  await t.test('ADMIN can access all existing dashboard features exactly like SUPER_ADMIN', async () => {
    const { cookie } = await login(STANDARD_ADMIN_EMAIL);

    const [overview, registrations, coupons, settings] = await Promise.all([
      request(app).get('/api/v1/admin/overview').set('Cookie', [cookie]),
      request(app).get('/api/v1/admin/registrations').set('Cookie', [cookie]),
      request(app).get('/api/v1/admin/coupons').set('Cookie', [cookie]),
      request(app).get('/api/v1/admin/settings').set('Cookie', [cookie])
    ]);

    assert.strictEqual(overview.status, 200);
    assert.strictEqual(registrations.status, 200);
    assert.strictEqual(coupons.status, 200);
    assert.strictEqual(settings.status, 200);
  });

  // 3. Both roles can view and search users
  await t.test('Both SUPER_ADMIN and ADMIN can view and search users', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);
    const adminLogin = await login(STANDARD_ADMIN_EMAIL);

    const superRes = await request(app)
      .get('/api/v1/admin/users?search=standard')
      .set('Cookie', [superLogin.cookie]);
    assert.strictEqual(superRes.status, 200);
    assert.strictEqual(superRes.body.success, true);
    assert.ok(superRes.body.users.some((u) => u.email === STANDARD_ADMIN_EMAIL));

    const adminRes = await request(app)
      .get('/api/v1/admin/users?role=ADMIN')
      .set('Cookie', [adminLogin.cookie]);
    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(adminRes.body.success, true);
    assert.ok(adminRes.body.users.some((u) => u.email === STANDARD_ADMIN_EMAIL));
  });

  // 4. Both roles can create users with the ADMIN role
  await t.test('Both roles can create users with the ADMIN role', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);
    const adminLogin = await login(STANDARD_ADMIN_EMAIL);

    // Super admin creates admin
    const superCreate = await request(app)
      .post('/api/v1/admin/users')
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken)
      .send({
        name: 'New Admin By Super',
        email: 'new_admin_by_super@example.com',
        role: 'ADMIN',
        password: TEST_PASSWORD
      });
    assert.strictEqual(superCreate.status, 201);
    assert.strictEqual(superCreate.body.user.role, 'ADMIN');

    // Admin creates admin
    const adminCreate = await request(app)
      .post('/api/v1/admin/users')
      .set('Cookie', [adminLogin.cookie])
      .set('x-csrf-token', adminLogin.csrfToken)
      .send({
        name: 'New Admin By Admin',
        email: 'new_admin_by_admin@example.com',
        role: 'ADMIN',
        password: TEST_PASSWORD
      });
    assert.strictEqual(adminCreate.status, 201);
    assert.strictEqual(adminCreate.body.user.role, 'ADMIN');
  });

  // 5. Only SUPER_ADMIN can create a SUPER_ADMIN
  await t.test('Only SUPER_ADMIN can create a SUPER_ADMIN; ADMIN attempt returns 403 Forbidden', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);
    const adminLogin = await login(STANDARD_ADMIN_EMAIL);

    // Super Admin creates Super Admin -> succeeds
    const superCreate = await request(app)
      .post('/api/v1/admin/users')
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken)
      .send({
        name: 'New Super Admin',
        email: 'new_super_by_super@example.com',
        role: 'SUPER_ADMIN',
        password: TEST_PASSWORD
      });
    assert.strictEqual(superCreate.status, 201);
    assert.strictEqual(superCreate.body.user.role, 'SUPER_ADMIN');

    // Admin attempts to create Super Admin -> forbidden 403
    const adminAttempt = await request(app)
      .post('/api/v1/admin/users')
      .set('Cookie', [adminLogin.cookie])
      .set('x-csrf-token', adminLogin.csrfToken)
      .send({
        name: 'Sneaky Super Admin',
        email: 'sneaky_super@example.com',
        role: 'SUPER_ADMIN',
        password: TEST_PASSWORD
      });
    assert.strictEqual(adminAttempt.status, 403);
    assert.strictEqual(adminAttempt.body.code, 'FORBIDDEN_SUPER_ADMIN_CREATION');
  });

  // 6 & 7. Role management permissions
  await t.test('SUPER_ADMIN can change roles; ADMIN cannot change user roles', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);
    const adminLogin = await login(STANDARD_ADMIN_EMAIL);

    // ADMIN attempt to change role via PATCH /users/:id/role -> 403
    const adminRoleAttempt = await request(app)
      .patch(`/api/v1/admin/users/${standardAdmin.id}/role`)
      .set('Cookie', [adminLogin.cookie])
      .set('x-csrf-token', adminLogin.csrfToken)
      .send({ role: 'SUPER_ADMIN' });
    assert.strictEqual(adminRoleAttempt.status, 403);
    assert.strictEqual(adminRoleAttempt.body.code, 'FORBIDDEN_SUPER_ADMIN_REQUIRED');

    // ADMIN attempt to change role via generic PATCH /users/:id -> 403
    const adminPatchAttempt = await request(app)
      .patch(`/api/v1/admin/users/${standardAdmin.id}`)
      .set('Cookie', [adminLogin.cookie])
      .set('x-csrf-token', adminLogin.csrfToken)
      .send({ role: 'SUPER_ADMIN' });
    assert.strictEqual(adminPatchAttempt.status, 403);
    assert.strictEqual(adminPatchAttempt.body.code, 'FORBIDDEN_ROLE_MODIFICATION');

    // SUPER_ADMIN changes standardAdmin to SUPER_ADMIN -> 200
    const superRoleUpdate = await request(app)
      .patch(`/api/v1/admin/users/${standardAdmin.id}/role`)
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken)
      .send({ role: 'SUPER_ADMIN' });
    assert.strictEqual(superRoleUpdate.status, 200);
    assert.strictEqual(superRoleUpdate.body.user.role, 'SUPER_ADMIN');

    // Revert back to ADMIN
    await request(app)
      .patch(`/api/v1/admin/users/${standardAdmin.id}/role`)
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken)
      .send({ role: 'ADMIN' });
  });

  // 8 & 9. User deletion restrictions
  await t.test('ADMIN cannot delete any user (returns 403 Forbidden)', async () => {
    const adminLogin = await login(STANDARD_ADMIN_EMAIL);

    const deleteAttempt = await request(app)
      .delete(`/api/v1/admin/users/${superAdmin.id}`)
      .set('Cookie', [adminLogin.cookie])
      .set('x-csrf-token', adminLogin.csrfToken);

    assert.strictEqual(deleteAttempt.status, 403);
    assert.strictEqual(deleteAttempt.body.code, 'FORBIDDEN_SUPER_ADMIN_REQUIRED');
  });

  // 10 & 11. Deletion safeguards
  await t.test('SUPER_ADMIN cannot delete own account; can delete eligible other users', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);

    // Self deletion is blocked
    const selfDelete = await request(app)
      .delete(`/api/v1/admin/users/${superAdmin.id}`)
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken);
    assert.strictEqual(selfDelete.status, 400);
    assert.strictEqual(selfDelete.body.code, 'CANNOT_DELETE_SELF');

    // Create target user and delete it
    const target = await prisma.adminUser.create({
      data: {
        email: 'delete_target@example.com',
        name: 'Delete Target',
        passwordHash,
        role: 'ADMIN',
        isActive: true
      }
    });

    const successfulDelete = await request(app)
      .delete(`/api/v1/admin/users/${target.id}`)
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken);
    assert.strictEqual(successfulDelete.status, 200);
    assert.strictEqual(successfulDelete.body.success, true);

    // Confirm soft-deleted
    const inDb = await prisma.adminUser.findUnique({ where: { id: target.id } });
    assert.ok(inDb.deletedAt !== null, 'deletedAt must be set');
    assert.strictEqual(inDb.isActive, false, 'isActive must be false');
  });

  // 12. Last active SUPER_ADMIN safeguard
  await t.test('The last active SUPER_ADMIN cannot be deleted or deactivated', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);

    // Deactivate ALL other active super admins in the database so superAdmin is the sole active super admin
    const otherSupers = await prisma.adminUser.findMany({
      where: { id: { not: superAdmin.id }, role: 'SUPER_ADMIN', isActive: true, deletedAt: null }
    });
    const otherSuperIds = otherSupers.map((u) => u.id);

    if (otherSuperIds.length > 0) {
      await prisma.adminUser.updateMany({
        where: { id: { in: otherSuperIds } },
        data: { isActive: false }
      });
    }

    try {
      // Now superAdmin is the ONLY active SUPER_ADMIN in the DB
      // Attempting to demote superAdmin should fail
      const demoteAttempt = await request(app)
        .patch(`/api/v1/admin/users/${superAdmin.id}/role`)
        .set('Cookie', [superLogin.cookie])
        .set('x-csrf-token', superLogin.csrfToken)
        .send({ role: 'ADMIN' });
      assert.strictEqual(demoteAttempt.status, 400);
      assert.strictEqual(demoteAttempt.body.code, 'CANNOT_DEMOTE_LAST_SUPER_ADMIN');

      // Attempting to deactivate superAdmin should fail
      const deactivateAttempt = await request(app)
        .patch(`/api/v1/admin/users/${superAdmin.id}`)
        .set('Cookie', [superLogin.cookie])
        .set('x-csrf-token', superLogin.csrfToken)
        .send({ isActive: false });
      assert.strictEqual(deactivateAttempt.status, 400);
      assert.strictEqual(deactivateAttempt.body.code, 'CANNOT_DEACTIVATE_LAST_SUPER_ADMIN');
    } finally {
      // Restore other super admins
      if (otherSuperIds.length > 0) {
        await prisma.adminUser.updateMany({
          where: { id: { in: otherSuperIds } },
          data: { isActive: true }
        });
      }
    }
  });

  // 13. Duplicate email rejection
  await t.test('Duplicate email addresses are rejected with 409', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);

    const dupAttempt = await request(app)
      .post('/api/v1/admin/users')
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken)
      .send({
        name: 'Duplicate Admin',
        email: STANDARD_ADMIN_EMAIL, // already exists
        role: 'ADMIN',
        password: TEST_PASSWORD
      });

    assert.strictEqual(dupAttempt.status, 409);
    assert.strictEqual(dupAttempt.body.code, 'EMAIL_ALREADY_EXISTS');
  });

  // 14. Deactivated accounts cannot continue accessing protected APIs
  await t.test('Deactivated accounts cannot continue accessing protected APIs', async () => {
    // Create an active user, log in to establish session
    const tempUser = await prisma.adminUser.create({
      data: {
        email: 'deactivate_target@example.com',
        name: 'Deactivate Target',
        passwordHash,
        role: 'ADMIN',
        isActive: true,
        mustChangePassword: false
      }
    });

    const tempLogin = await login('deactivate_target@example.com');
    const verifyBefore = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', [tempLogin.cookie]);
    assert.strictEqual(verifyBefore.status, 200, 'Should access before deactivation');

    // Deactivate the user
    const superLogin = await login(SUPER_ADMIN_EMAIL);
    await request(app)
      .patch(`/api/v1/admin/users/${tempUser.id}`)
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken)
      .send({ isActive: false });

    // Request using previous session must now be rejected with 401
    const verifyAfter = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', [tempLogin.cookie]);
    assert.strictEqual(verifyAfter.status, 401);
  });

  // 15. Password hashes and reset tokens never appear in normal user API responses
  await t.test('Password hashes and reset tokens never appear in normal user API responses', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);

    const res = await request(app)
      .get('/api/v1/admin/users')
      .set('Cookie', [superLogin.cookie]);

    assert.strictEqual(res.status, 200);
    for (const u of res.body.users) {
      assert.strictEqual(u.passwordHash, undefined, 'passwordHash must never be exposed');
      assert.strictEqual(u.password_hash, undefined, 'password_hash must never be exposed');
      assert.strictEqual(u.resetTokenHash, undefined, 'resetTokenHash must never be exposed');
      assert.strictEqual(u.reset_token_hash, undefined, 'reset_token_hash must never be exposed');
    }
  });

  // 16. Password reset initiation and reset-password completion workflow
  await t.test('Password reset initiation and token-based reset completion workflow', async () => {
    const superLogin = await login(SUPER_ADMIN_EMAIL);

    // Create target user
    const resetTarget = await prisma.adminUser.create({
      data: {
        email: 'reset_target@example.com',
        name: 'Reset Target',
        passwordHash,
        role: 'ADMIN',
        isActive: true,
        mustChangePassword: false
      }
    });

    // Initiate reset
    const initiateRes = await request(app)
      .post(`/api/v1/admin/users/${resetTarget.id}/reset-password`)
      .set('Cookie', [superLogin.cookie])
      .set('x-csrf-token', superLogin.csrfToken);

    assert.strictEqual(initiateRes.status, 200);
    assert.strictEqual(initiateRes.body.success, true);
    assert.ok(initiateRes.body.resetToken, 'Must provide resetToken for distribution');

    const resetToken = initiateRes.body.resetToken;
    const newPassword = 'NewSecretPassword@2026';

    // Consume token at public reset endpoint
    const resetRes = await request(app)
      .post('/api/v1/admin/auth/reset-password')
      .send({
        token: resetToken,
        newPassword
      });

    assert.strictEqual(resetRes.status, 200);
    assert.strictEqual(resetRes.body.success, true);

    // Verify user can now log in with the new password
    const loginWithNew = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'reset_target@example.com', password: newPassword });
    assert.strictEqual(loginWithNew.status, 200, 'Login with new password must succeed');

    // Verify token was single-use: repeating with same token must fail
    const reuseAttempt = await request(app)
      .post('/api/v1/admin/auth/reset-password')
      .send({
        token: resetToken,
        newPassword: 'AnotherPassword@999'
      });
    assert.strictEqual(reuseAttempt.status, 400);
  });

  // 17. Seed operations
  await t.test('seedAdmin and seed idempotently ensure admin@digitaldude.com is SUPER_ADMIN', async () => {
    const res = await seedAdmin({ reset: false });
    assert.strictEqual(res.role, 'SUPER_ADMIN');

    await seed();
    const adminUser = await prisma.adminUser.findUnique({
      where: { email: 'admin@digitaldude.com' }
    });
    assert.ok(adminUser, 'admin@digitaldude.com must exist');
    assert.strictEqual(adminUser.role, 'SUPER_ADMIN');
  });
});
