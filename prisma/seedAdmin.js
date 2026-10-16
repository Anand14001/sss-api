import { PrismaClient } from '@prisma/client';
import { hashPassword, validatePassword } from '../src/services/adminAuth.js';
import { env } from '../src/config/env.js';

const prisma = new PrismaClient();

/**
 * Administrator bootstrap and role synchronization.
 *
 * Run with:  npm run seed:admin
 *
 * Reads ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD from the server's
 * environment. Nothing is hardcoded here, so the password never reaches the
 * repository, a build artefact or a log line — the script prints the address it
 * provisioned and nothing else.
 *
 * Uses an idempotent upsert: if the administrator already exists, rerunning
 * updates their role (assigning SUPER_ADMIN to admin@digitaldude.com) without
 * overwriting their password or resetting account flags. Use
 * `npm run seed:admin -- --reset-password` to overwrite the password deliberately.
 */
export async function seedAdmin({ reset = false } = {}) {
  const email = (env.ADMIN_BOOTSTRAP_EMAIL || '').trim().toLowerCase();
  const password = env.ADMIN_BOOTSTRAP_PASSWORD || '';
  const name = env.ADMIN_BOOTSTRAP_NAME || 'Event Administrator';

  if (!email || !password) {
    throw new Error(
      'ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD must be set in the environment before seeding an administrator.'
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('ADMIN_BOOTSTRAP_EMAIL is not a valid email address.');
  }

  const weaknesses = validatePassword(password, { bootstrap: true });
  if (weaknesses.length) {
    throw new Error(
      `ADMIN_BOOTSTRAP_PASSWORD is too weak even for one-time use. It still needs: ${weaknesses.join(', ')}.`
    );
  }

  const assignedRole = email === 'admin@digitaldude.com' ? 'SUPER_ADMIN' : 'ADMIN';

  const updateData = {
    role: assignedRole
  };

  if (reset) {
    const passwordHash = await hashPassword(password);
    updateData.passwordHash = passwordHash;
    updateData.mustChangePassword = true;
    updateData.failedAttempts = 0;
    updateData.lockedUntil = null;
    updateData.isActive = true;
  }

  const createPasswordHash = updateData.passwordHash || (await hashPassword(password));

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: updateData,
    create: {
      email,
      name,
      passwordHash: createPasswordHash,
      role: assignedRole,
      mustChangePassword: true,
      isActive: true
    }
  });

  if (reset) {
    await prisma.adminSession.updateMany({
      where: { adminUserId: admin.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    console.log(`[ADMIN SEED] Password reset and role set to ${admin.role} for ${email}. A new password is required at next sign-in.`);
    return { created: false, reset: true, email, role: admin.role };
  }

  console.log(`[ADMIN SEED] Administrator ${email} seeded/updated with role ${admin.role}.`);
  return { created: true, reset: false, email, role: admin.role };
}

if (process.argv[1]?.endsWith('seedAdmin.js')) {
  seedAdmin({ reset: process.argv.includes('--reset-password') })
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[ADMIN SEED] ${err.message}`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
