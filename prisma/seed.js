import { PrismaClient } from '@prisma/client';
import { CATEGORIES, EVENT_CONFIG } from '../src/config/event.js';

const prisma = new PrismaClient();

export async function seed() {
  // Upsert Event Config
  await prisma.eventConfig.upsert({
    where: { id: 'sss-2026' },
    update: {
      name: EVENT_CONFIG.name,
      tagline: 'The Speaking Contest',
      eventDate: new Date(`${EVENT_CONFIG.date}T00:00:00Z`),
      registrationDeadline: EVENT_CONFIG.deadline,
      venueName: EVENT_CONFIG.venue.name,
      venueCity: EVENT_CONFIG.venue.city,
      isRegistrationOpen: true
    },
    create: {
      id: 'sss-2026',
      name: EVENT_CONFIG.name,
      tagline: 'The Speaking Contest',
      eventDate: new Date(`${EVENT_CONFIG.date}T00:00:00Z`),
      registrationDeadline: EVENT_CONFIG.deadline,
      venueName: EVENT_CONFIG.venue.name,
      venueCity: EVENT_CONFIG.venue.city,
      isRegistrationOpen: true
    }
  });

  // Upsert Categories
  for (const cat of Object.values(CATEGORIES)) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {
        name: cat.name,
        formLabel: cat.formLabel,
        minAge: cat.minAge,
        maxAge: cat.maxAge,
        // feePaise is authoritative in the database; do not overwrite on seed/restart
        currency: cat.currency,
        isActive: true
      },
      create: {
        slug: cat.slug,
        name: cat.name,
        formLabel: cat.formLabel,
        minAge: cat.minAge,
        maxAge: cat.maxAge,
        feePaise: cat.feePaise,
        currency: cat.currency,
        isActive: true
      }
    });
  }

  // Ensure initial Super Administrator admin@digitaldude.com is seeded with SUPER_ADMIN role idempotently
  const targetEmail = 'admin@digitaldude.com';
  const existingAdmin = await prisma.adminUser.findUnique({
    where: { email: targetEmail }
  });

  if (existingAdmin) {
    if (existingAdmin.role !== 'SUPER_ADMIN') {
      await prisma.adminUser.update({
        where: { email: targetEmail },
        data: { role: 'SUPER_ADMIN' }
      });
      console.log(`[SEED] Updated ${targetEmail} to SUPER_ADMIN.`);
    }
  } else {
    try {
      const { seedAdmin } = await import('./seedAdmin.js');
      await seedAdmin({ reset: false });
    } catch (err) {
      console.warn(`[SEED] Note: Could not auto-provision ${targetEmail}: ${err.message}`);
    }
  }

  console.log('Seeded event configuration and categories successfully.');
}

if (process.argv[1]?.endsWith('seed.js')) {
  seed()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
