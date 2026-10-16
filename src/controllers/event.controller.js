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
  let dbCategories = [];
  try {
    dbCategories = await prisma.category.findMany({
      orderBy: { minAge: 'asc' }
    });
  } catch (err) {
    console.error('Failed to query categories in getPublicEventConfig:', err.message);
  }

  // Set cache prevention headers so clients always receive fresh pricing without stale cache
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  // Format categories as public array using DB as authoritative source
  const categoryList = (dbCategories.length > 0 ? dbCategories : Object.values(CATEGORIES)).map((row) => {
    const staticCfg = CATEGORIES[row.slug?.toLowerCase()] || CATEGORIES[row.slug] || {};
    const feePaise = row.feePaise !== undefined ? row.feePaise : (staticCfg.feePaise ?? 0);
    return {
      slug: row.slug,
      name: row.name ?? staticCfg.name,
      formLabel: row.formLabel ?? staticCfg.formLabel,
      minAge: row.minAge ?? staticCfg.minAge,
      maxAge: row.maxAge ?? staticCfg.maxAge,
      fee: Math.floor(feePaise / 100),
      feePaise,
      currency: row.currency ?? staticCfg.currency ?? 'INR'
    };
  });

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
      prelims: EVENT_CONFIG.prelims,
      whatsappGroupInviteUrl: EVENT_CONFIG.whatsappGroupInviteUrl
    },
    categories: categoryList
  });
}
