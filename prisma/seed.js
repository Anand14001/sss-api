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
        feePaise: cat.feePaise,
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
