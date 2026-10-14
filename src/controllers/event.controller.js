import { EVENT_CONFIG, CATEGORIES } from '../config/event.js';
import { prisma } from '../db/prisma.js';

export async function getHealth(req, res) {
  let dbStatus = 'healthy';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = 'disconnected';
  }

  res.json({
    status: dbStatus === 'healthy' ? 'ok' : 'degraded',
    service: 'sss-api',
    version: '1.0.0',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
}

export async function getPublicEventConfig(req, res) {
  // Format categories as public array
  const categoryList = Object.values(CATEGORIES).map((c) => ({
    slug: c.slug,
    name: c.name,
    formLabel: c.formLabel,
    minAge: c.minAge,
    maxAge: c.maxAge,
    fee: c.feeRupees,
    feePaise: c.feePaise,
    currency: c.currency
  }));

  res.json({
    success: true,
    event: {
      name: EVENT_CONFIG.name,
      shortName: EVENT_CONFIG.shortName,
      date: EVENT_CONFIG.date,
      dateDisplay: EVENT_CONFIG.dateDisplay,
      deadline: EVENT_CONFIG.deadline,
      deadlineDisplay: EVENT_CONFIG.deadlineDisplay,
      venue: EVENT_CONFIG.venue,
      organisers: EVENT_CONFIG.organisers,
      contacts: EVENT_CONFIG.contacts,
      prizes: EVENT_CONFIG.prizes,
      prelims: EVENT_CONFIG.prelims
    },
    categories: categoryList
  });
}
