import { prisma } from '../db/prisma.js';
import { CATEGORIES, EVENT_CONFIG } from '../config/event.js';
import { getEffectiveStatus } from './couponValidation.js';

/**
 * Read-side queries for the admin dashboard.
 *
 * Everything here aggregates in PostgreSQL. The dashboard must stay usable at a
 * few thousand registrations, and pulling the table into Node to count it would
 * get slower every week of the campaign.
 *
 * Vocabulary used consistently across this file and the dashboard:
 *   registration status — AWAITING_PAYMENT | PAID | CANCELLED
 *   payment status      — CREATED | CAPTURED | FAILED  (per Razorpay order)
 * A confirmed registration says the fee was paid. It says nothing about
 * attendance, qualification or results.
 */

export const REGISTRATION_STATUSES = [
  'PENDING_REVIEW',
  'SHORTLISTED',
  'REJECTED',
  'PAYMENT_PENDING',
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
  'CONFIRMED',
  'AWAITING_PAYMENT',
  'PAID',
  'CANCELLED'
];
export const PAYMENT_STATUSES = ['CREATED', 'CAPTURED', 'FAILED'];

const MAX_PAGE_SIZE = 100;

function clampPaging({ page, pageSize }) {
  const take = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || 25));
  const current = Math.max(1, parseInt(page, 10) || 1);
  return { take, skip: (current - 1) * take, page: current, pageSize: take };
}

function parseDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const date = new Date(endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Translates dashboard filter parameters into a Prisma `where` clause. Shared
 * by the list endpoint and the CSV export so an export always covers exactly
 * the rows the operator was looking at.
 */
export function buildRegistrationWhere(query = {}) {
  const where = {};
  const and = [];

  const search = (query.q || '').trim();
  if (search) {
    and.push({
      OR: [
        { reference: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search.replace(/\D/g, '') || search } }
      ]
    });
  }

  if (query.category && CATEGORIES[query.category]) {
    where.categorySlug = query.category;
  }

  // Application decision filter: SHORTLISTED, REJECTED, PENDING_REVIEW
  if (query.decision) {
    const dec = query.decision.toUpperCase();
    if (dec === 'SHORTLISTED') {
      and.push({
        OR: [{ reviewDecision: 'SHORTLISTED' }, { status: 'SHORTLISTED' }]
      });
    } else if (dec === 'REJECTED') {
      and.push({
        OR: [{ reviewDecision: 'REJECTED' }, { status: 'REJECTED' }]
      });
    } else if (dec === 'PENDING_REVIEW') {
      where.status = 'PENDING_REVIEW';
    }
  }

  // Payment invitation status filter: SENT, FAILED, NOT_SENT
  if (query.invitationStatus) {
    const invStatus = query.invitationStatus.toUpperCase();
    if (invStatus === 'SENT') {
      and.push({ paymentInvitations: { some: { deliveryStatus: 'SENT' } } });
    } else if (invStatus === 'FAILED') {
      and.push({ paymentInvitations: { some: { deliveryStatus: 'FAILED' } } });
    } else if (invStatus === 'NOT_SENT') {
      and.push({ paymentInvitations: { none: {} } });
    }
  }

  if (query.status && REGISTRATION_STATUSES.includes(query.status)) {
    if (query.status === 'CONFIRMED') {
      where.status = { in: ['CONFIRMED', 'PAID'] };
    } else {
      where.status = query.status;
    }
  }

  if (query.paymentStatus) {
    const ps = query.paymentStatus.toUpperCase();
    if (ps === 'CONFIRMED' || ps === 'CAPTURED') {
      and.push({
        OR: [
          { status: { in: ['CONFIRMED', 'PAID'] } },
          { payments: { some: { status: 'CAPTURED' } } }
        ]
      });
    } else if (ps === 'PENDING' || ps === 'CREATED') {
      and.push({
        OR: [
          { status: { in: ['PAYMENT_PENDING', 'AWAITING_PAYMENT'] } },
          { payments: { some: { status: 'CREATED' } } }
        ]
      });
    } else if (ps === 'FAILED') {
      and.push({
        OR: [
          { status: 'PAYMENT_FAILED' },
          { payments: { some: { status: 'FAILED' } } }
        ]
      });
    }
  }

  if (query.city) {
    where.city = { contains: String(query.city).trim(), mode: 'insensitive' };
  }

  if (query.coupon) {
    where.couponCode = { contains: String(query.coupon).trim(), mode: 'insensitive' };
  }

  const from = parseDateBoundary(query.from);
  const to = parseDateBoundary(query.to, true);
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  if (query.checkedIn === 'true') and.push({ NOT: { checkedInAt: null } });
  if (query.checkedIn === 'false') and.push({ checkedInAt: null });

  if (and.length) where.AND = and;
  return where;
}

const SORTABLE = {
  createdAt: 'createdAt',
  fullName: 'fullName',
  reference: 'reference',
  status: 'status',
  city: 'city',
  amountPaise: 'amountPaise',
  categorySlug: 'categorySlug',
  updatedAt: 'updatedAt'
};

function buildOrderBy(query = {}) {
  const field = SORTABLE[query.sort] || 'createdAt';
  const direction = query.order === 'asc' ? 'asc' : 'desc';
  if (field === 'id') {
    return [{ id: direction }];
  }
  return [
    { [field]: direction },
    { id: 'desc' }
  ];
}

/** Shapes a registration row for a list view: no more personal data than the
 *  task needs. Date of birth, guardian details and occupation stay in the
 *  detail view, which is a deliberate single-record lookup. */
function toListItem(reg) {
  const latestPayment = reg.payments?.[0] ?? null;
  const latestInvitation = reg.paymentInvitations?.[0] ?? null;
  const isConfirmed = reg.status === 'CONFIRMED' || reg.status === 'PAID';

  let effectiveDecision = reg.reviewDecision || null;
  if (!effectiveDecision) {
    if (reg.status === 'SHORTLISTED') effectiveDecision = 'SHORTLISTED';
    else if (reg.status === 'REJECTED') effectiveDecision = 'REJECTED';
    else if (reg.status === 'PENDING_REVIEW') effectiveDecision = 'PENDING_REVIEW';
  }

  let effectiveInvitationStatus = 'NOT_SENT';
  if (latestInvitation) {
    effectiveInvitationStatus = latestInvitation.deliveryStatus || latestInvitation.status || 'SENT';
  }

  return {
    id: reg.id,
    reference: reg.reference,
    fullName: reg.fullName,
    email: reg.email,
    phone: reg.phone,
    category: reg.categorySlug,
    categoryName: CATEGORIES[reg.categorySlug]?.name ?? reg.categorySlug,
    city: reg.city,
    baseAmountPaise: reg.baseAmountPaise ?? reg.amountPaise,
    discountPaise: reg.discountPaise || 0,
    amountPaise: reg.amountPaise,
    couponCode: reg.couponCode || null,
    couponId: reg.couponId || null,
    currency: reg.currency,
    status: reg.status,
    isConfirmed,
    rawStatus: reg.status,
    reviewDecision: effectiveDecision,
    reviewNotes: reg.reviewNotes || null,
    reviewedBy: reg.reviewedBy || null,
    reviewedAt: reg.reviewedAt || null,
    invitationStatus: effectiveInvitationStatus,
    invitationDeliveryStatus: latestInvitation?.deliveryStatus || null,
    paymentStatus: isConfirmed ? 'CAPTURED' : (latestPayment?.status ?? (reg.status === 'PAYMENT_PENDING' ? 'PENDING' : null)),
    checkedInAt: reg.checkedInAt,
    createdAt: reg.createdAt,
    updatedAt: reg.updatedAt
  };
}

export async function listRegistrations(query = {}) {
  const where = buildRegistrationWhere(query);
  const { take, skip, page, pageSize } = clampPaging(query);

  const [total, rows, countsByStatus, invitationsSent] = await Promise.all([
    prisma.registration.count({ where }),
    prisma.registration.findMany({
      where,
      orderBy: buildOrderBy(query),
      take,
      skip,
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        paymentInvitations: { orderBy: { createdAt: 'desc' }, take: 1 }
      }
    }),
    prisma.registration.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.paymentInvitation.count({ where: { deliveryStatus: 'SENT' } })
  ]);

  const sc = (s) => countsByStatus.find((r) => r.status === s)?._count._all ?? 0;
  const summary = {
    total: countsByStatus.reduce((acc, c) => acc + c._count._all, 0),
    pendingReview: sc('PENDING_REVIEW'),
    shortlisted: sc('SHORTLISTED'),
    rejected: sc('REJECTED'),
    paymentPending: sc('PAYMENT_PENDING'),
    awaitingPayment: sc('AWAITING_PAYMENT') + sc('PAYMENT_PENDING'),
    confirmed: sc('PAID') + sc('CONFIRMED'),
    paymentInvitationsSent: invitationsSent
  };

  return {
    items: rows.map(toListItem),
    summary,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: skip + rows.length < total
    }
  };
}


/**
 * Streams every row matching a filter in batches, for exports. Keyset paging on
 * (createdAt, id) rather than OFFSET, so an export of several thousand rows
 * does not get quadratically slower and never loads the table into memory.
 */
export async function* streamRegistrations(query = {}, batchSize = 500) {
  const where = buildRegistrationWhere(query);
  let cursor = null;

  for (;;) {
    const rows = await prisma.registration.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } }
    });

    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < batchSize) return;
    cursor = rows[rows.length - 1].id;
  }
}

export async function getRegistrationDetail(reference) {
  const reg = await prisma.registration.findUnique({
    where: { reference },
    include: {
      payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      emailDeliveries: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      paymentInvitations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }
    }
  });

  if (!reg) {
    const error = new Error('Registration not found.');
    error.status = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }

  const [notes, auditTrail, dbCategory] = await Promise.all([
    prisma.adminNote.findMany({
      where: { registrationReference: reference },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'registration', entityId: reference },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50
    }),
    prisma.category.findUnique({
      where: { slug: reg.categorySlug }
    })
  ]);

  const staticCategory = CATEGORIES[reg.categorySlug] ?? null;
  const category = dbCategory || staticCategory;

  return {
    reference: reg.reference,
    fullName: reg.fullName,
    email: reg.email,
    phone: reg.phone,
    dob: reg.dob,
    ageOnContest: reg.ageOnContest,
    occupation: reg.occupation,
    city: reg.city,
    guardianName: reg.guardianName,
    guardianRelationship: reg.guardianRelationship,
    guardianPhone: reg.guardianPhone,
    guardianEmail: reg.guardianEmail,
    category: reg.categorySlug,
    categoryName: category?.name ?? reg.categorySlug,
    categoryLabel: category?.formLabel ?? null,
    eligibility: category
      ? {
          minAge: category.minAge,
          maxAge: category.maxAge,
          withinRange: reg.ageOnContest >= category.minAge && reg.ageOnContest <= category.maxAge
        }
      : null,
    baseAmountPaise: reg.baseAmountPaise ?? reg.amountPaise,
    discountPaise: reg.discountPaise || 0,
    couponCode: reg.couponCode || null,
    couponId: reg.couponId || null,
    amountPaise: reg.amountPaise,
    expectedFeePaise: category?.feePaise ?? null,
    currency: reg.currency,
    status: reg.status,
    isConfirmed: reg.status === 'PAID' || reg.status === 'CONFIRMED',
    rawStatus: reg.status,
    reviewDecision: reg.reviewDecision || null,
    reviewNotes: reg.reviewNotes || null,
    reviewedBy: reg.reviewedBy || null,
    reviewedAt: reg.reviewedAt || null,
    cancelledAt: reg.cancelledAt,
    cancelReason: reg.cancelReason,
    checkedInAt: reg.checkedInAt,
    checkedInBy: reg.checkedInBy,
    createdAt: reg.createdAt,
    updatedAt: reg.updatedAt,
    paymentInvitations: (reg.paymentInvitations || []).map((inv) => ({
      id: inv.id,
      token: inv.token,
      amountPaise: inv.amountPaise,
      amountRupees: inv.amountPaise / 100,
      currency: inv.currency,
      status: inv.status,
      sentToEmail: inv.sentToEmail,
      sentAt: inv.sentAt,
      deliveryStatus: inv.deliveryStatus,
      deliveryError: inv.deliveryError,
      expiresAt: inv.expiresAt,
      paidAt: inv.paidAt,
      razorpayOrderId: inv.razorpayOrderId,
      createdByAdminEmail: inv.createdByAdminEmail,
      createdAt: inv.createdAt
    })),
    payments: reg.payments.map(toPaymentItem),
    emailDeliveries: reg.emailDeliveries.map((d) => ({
      id: d.id,
      recipientEmail: d.recipientEmail,
      emailType: d.emailType,
      subject: d.subject,
      status: d.status,
      attemptCount: d.attemptCount,
      lastAttemptAt: d.lastAttemptAt,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt
    })),
    notes: notes.map((n) => ({
      id: n.id,
      body: n.body,
      authorEmail: n.authorEmail,
      createdAt: n.createdAt
    })),
    auditTrail: auditTrail.map((a) => ({
      id: a.id,
      action: a.action,
      actorEmail: a.actorEmail,
      outcome: a.outcome,
      metadata: a.metadata,
      createdAt: a.createdAt
    }))
  };
}

// -------------------------------------------------------------------- payments

function toPaymentItem(payment) {
  return {
    id: payment.id,
    reference: payment.registrationReference,
    razorpayOrderId: payment.razorpayOrderId,
    razorpayPaymentId: payment.razorpayPaymentId,
    // The checkout signature is verification evidence, not something to show.
    // Whether one is on file is useful; its value is not.
    signatureOnFile: Boolean(payment.razorpaySignature),
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    status: payment.status,
    failureReason: payment.failureReason,
    verifiedAt: payment.status === 'CAPTURED' ? payment.updatedAt : null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt
  };
}

export function buildPaymentWhere(query = {}) {
  const where = {};
  const and = [];

  const search = (query.q || '').trim();
  if (search) {
    and.push({
      OR: [
        { registrationReference: { contains: search, mode: 'insensitive' } },
        { razorpayOrderId: { contains: search, mode: 'insensitive' } },
        { razorpayPaymentId: { contains: search, mode: 'insensitive' } }
      ]
    });
  }

  if (query.status && PAYMENT_STATUSES.includes(query.status)) {
    where.status = query.status;
  }

  if (query.category && CATEGORIES[query.category]) {
    and.push({ registration: { categorySlug: query.category } });
  }

  const from = parseDateBoundary(query.from);
  const to = parseDateBoundary(query.to, true);
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  if (and.length) where.AND = and;
  return where;
}

export async function listPayments(query = {}) {
  const where = buildPaymentWhere(query);
  const { take, skip, page, pageSize } = clampPaging(query);

  const sortField = query.sort && ['amountPaise', 'createdAt', 'updatedAt'].includes(query.sort)
    ? query.sort
    : 'createdAt';
  const sortDir = query.order === 'asc' ? 'asc' : 'desc';

  const [total, rows, dbCategories] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: [
        { [sortField]: sortDir },
        { id: 'desc' }
      ],
      take,
      skip,
      include: { registration: { select: { fullName: true, categorySlug: true, status: true } } }
    }),
    prisma.category.findMany()
  ]);

  const catMap = Object.fromEntries(dbCategories.map((c) => [c.slug, c]));

  return {
    items: rows.map((p) => {
      const slug = p.registration?.categorySlug;
      const dbCat = slug ? catMap[slug] : null;
      const staticCat = slug ? CATEGORIES[slug] : null;
      return {
        ...toPaymentItem(p),
        participantName: p.registration?.fullName ?? null,
        category: slug ?? null,
        categoryName: dbCat?.name ?? staticCat?.name ?? null,
        registrationStatus: p.registration?.status ?? null,
        expectedFeePaise: dbCat?.feePaise ?? staticCat?.feePaise ?? null
      };
    }),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: skip + rows.length < total
    }
  };
}

export async function* streamPayments(query = {}, batchSize = 500) {
  const where = buildPaymentWhere(query);
  let cursor = null;

  for (;;) {
    const rows = await prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { registration: { select: { fullName: true, categorySlug: true, email: true } } }
    });

    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < batchSize) return;
    cursor = rows[rows.length - 1].id;
  }
}

// --------------------------------------------------------------------- metrics

/**
 * Overview metrics.
 *
 * Revenue counts CAPTURED payments only — a payment row Razorpay has confirmed
 * and the server has verified. Orders that were created and abandoned are not
 * money, and are reported separately as "awaiting payment" so the two are never
 * added together by accident.
 */
export async function getOverviewMetrics() {
  const [
    byStatus,
    byCategory,
    paymentsByStatus,
    capturedRevenue,
    checkedIn,
    emailFailures,
    discountSum,
    invitationsSentCount,
    invitationsFailedCount
  ] = await Promise.all([
    prisma.registration.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.registration.groupBy({
      by: ['categorySlug'],
      _count: { _all: true },
      where: { status: { in: ['PAID', 'CONFIRMED'] } }
    }),
    prisma.payment.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.payment.aggregate({
      where: { status: 'CAPTURED' },
      _sum: { amountPaise: true },
      _count: { _all: true }
    }),
    prisma.registration.count({ where: { NOT: { checkedInAt: null } } }),
    prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
    prisma.registration.aggregate({
      where: { status: { in: ['PAID', 'CONFIRMED'] } },
      _sum: { discountPaise: true }
    }),
    prisma.paymentInvitation.count({ where: { deliveryStatus: 'SENT' } }),
    prisma.paymentInvitation.count({ where: { deliveryStatus: 'FAILED' } })
  ]);

  const statusCount = (status) =>
    byStatus.find((r) => r.status === status)?._count._all ?? 0;
  const paymentCount = (status) =>
    paymentsByStatus.find((r) => r.status === status)?._count._all ?? 0;

  const totalRegistrations = byStatus.reduce((sum, r) => sum + r._count._all, 0);

  // Revenue per category, from captured payments joined to their registration.
  const revenueByCategory = await prisma.$queryRaw`
    SELECT r.category_slug AS slug,
           COUNT(p.id)::int AS paid_count,
           COALESCE(SUM(p.amount_paise), 0)::bigint AS revenue_paise
    FROM payments p
    JOIN registrations r ON r.id = p.registration_id
    WHERE p.status = 'CAPTURED'
    GROUP BY r.category_slug
  `;

  const collectedPaise = Number(capturedRevenue._sum.amountPaise ?? 0);
  const discountGivenPaise = Number(discountSum._sum.discountPaise ?? 0);

  const confirmedCount = statusCount('PAID') + statusCount('CONFIRMED');
  const awaitingPaymentCount = statusCount('AWAITING_PAYMENT') + statusCount('PAYMENT_PENDING');

  return {
    registrations: {
      total: totalRegistrations,
      pendingReview: statusCount('PENDING_REVIEW'),
      shortlisted: statusCount('SHORTLISTED'),
      rejected: statusCount('REJECTED'),
      paymentPending: statusCount('PAYMENT_PENDING'),
      paymentFailed: statusCount('PAYMENT_FAILED'),
      paymentExpired: statusCount('PAYMENT_EXPIRED'),
      confirmed: statusCount('PAID'),
      confirmedPaid: statusCount('PAID') + statusCount('CONFIRMED'),
      awaitingPayment: awaitingPaymentCount,
      cancelled: statusCount('CANCELLED'),
      paymentInvitationsSent: invitationsSentCount,
      invitationEmailFailures: invitationsFailedCount
    },
    payments: {
      created: paymentCount('CREATED'),
      captured: paymentCount('CAPTURED'),
      failed: paymentCount('FAILED')
    },
    revenue: {
      // Collected: verified, captured payments only.
      collectedPaise,
      grossRevenuePaise: collectedPaise + discountGivenPaise,
      discountGivenPaise,
      capturedCount: capturedRevenue._count._all,
      currency: 'INR'
    },
    categories: Object.values(CATEGORIES).map((cat) => {
      const confirmed = byCategory.find((c) => c.categorySlug === cat.slug)?._count._all ?? 0;
      const rev = revenueByCategory.find((r) => r.slug === cat.slug);
      return {
        slug: cat.slug,
        name: cat.name,
        formLabel: cat.formLabel,
        minAge: cat.minAge,
        maxAge: cat.maxAge,
        feePaise: cat.feePaise,
        confirmed,
        revenuePaise: Number(rev?.revenue_paise ?? 0)
      };
    }),
    operations: {
      checkedIn,
      emailFailures
    },

    event: {
      name: EVENT_CONFIG.name,
      dateDisplay: EVENT_CONFIG.dateDisplay,
      deadline: EVENT_CONFIG.deadline,
      deadlineDisplay: EVENT_CONFIG.deadlineDisplay,
      venue: EVENT_CONFIG.venue,
      daysUntilEvent: Math.ceil(
        (new Date(`${EVENT_CONFIG.date}T00:00:00Z`).getTime() - Date.now()) / 86400000
      ),
      daysUntilDeadline: Math.ceil(
        (new Date(EVENT_CONFIG.deadline).getTime() - Date.now()) / 86400000
      )
    },
    generatedAt: new Date().toISOString()
  };
}

/**
 * Daily registration and revenue series for the overview charts.
 * Grouped in SQL over a bounded window; the dashboard never computes a trend by
 * downloading rows.
 */
export async function getTrends({ days = 30 } = {}) {
  const windowDays = Math.min(180, Math.max(7, parseInt(days, 10) || 30));
  const since = new Date(Date.now() - windowDays * 86400000);

  const [registrations, revenue] = await Promise.all([
    prisma.$queryRaw`
      SELECT DATE(created_at) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'PAID')::int AS confirmed
      FROM registrations
      WHERE created_at >= ${since}
      GROUP BY DATE(created_at)
      ORDER BY day ASC
    `,
    prisma.$queryRaw`
      SELECT DATE(updated_at) AS day,
             COALESCE(SUM(amount_paise), 0)::bigint AS revenue_paise
      FROM payments
      WHERE status = 'CAPTURED' AND updated_at >= ${since}
      GROUP BY DATE(updated_at)
      ORDER BY day ASC
    `
  ]);

  const toKey = (d) => new Date(d).toISOString().slice(0, 10);
  const regByDay = new Map(registrations.map((r) => [toKey(r.day), r]));
  const revByDay = new Map(revenue.map((r) => [toKey(r.day), Number(r.revenue_paise)]));

  // Zero-filled so the chart shows quiet days as zero rather than joining across
  // a gap, which would overstate a trend.
  const series = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({
      date: key,
      registrations: regByDay.get(key)?.total ?? 0,
      confirmed: regByDay.get(key)?.confirmed ?? 0,
      revenuePaise: revByDay.get(key) ?? 0
    });
  }

  return { days: windowDays, series };
}

export async function getRecentRegistrations(limit = 8) {
  const rows = await prisma.registration.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(25, Math.max(1, limit)),
    include: { payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } }
  });
  return rows.map(toListItem);
}

/**
 * Registrations that need a human to look at them. Each item carries the filter
 * that produced it so the dashboard can link straight to the matching view
 * instead of making the operator rebuild the query.
 */
export async function getAttentionItems() {
  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000);

  const [failedPayments, stalledRegistrations, failedEmails, feeMismatches] = await Promise.all([
    prisma.payment.count({ where: { status: 'FAILED' } }),
    prisma.registration.count({
      where: { status: 'AWAITING_PAYMENT', createdAt: { lt: staleCutoff } }
    }),
    prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
    // A paid registration whose amount does not match its category's fee. Rare,
    // but it would mean a pricing change landed mid-campaign and the books need
    // reconciling by hand.
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM registrations r
      JOIN categories c ON c.slug = r.category_slug
      WHERE r.amount_paise <> c.fee_paise
    `
  ]);

  const items = [];

  if (failedPayments > 0) {
    items.push({
      id: 'failed-payments',
      severity: 'warning',
      title: `${failedPayments} failed payment${failedPayments === 1 ? '' : 's'}`,
      description: 'Razorpay reported these as failed. Review before contacting participants.',
      action: { label: 'Review payments', to: '/payments?status=FAILED' }
    });
  }

  if (stalledRegistrations > 0) {
    items.push({
      id: 'stalled-registrations',
      severity: 'info',
      title: `${stalledRegistrations} registration${stalledRegistrations === 1 ? '' : 's'} awaiting payment`,
      description: 'Started over an hour ago and never completed checkout.',
      action: { label: 'View incomplete', to: '/registrations?status=AWAITING_PAYMENT' }
    });
  }

  if (failedEmails > 0) {
    items.push({
      id: 'failed-emails',
      severity: 'warning',
      title: `${failedEmails} confirmation email${failedEmails === 1 ? '' : 's'} failed to send`,
      description: 'The payment went through but the participant was not emailed.',
      action: { label: 'Open communication', to: '/communication?status=FAILED' }
    });
  }

  const mismatchCount = Number(feeMismatches?.[0]?.count ?? 0);
  if (mismatchCount > 0) {
    items.push({
      id: 'fee-mismatch',
      severity: 'warning',
      title: `${mismatchCount} registration${mismatchCount === 1 ? '' : 's'} paid a fee that no longer matches its category`,
      description: 'Expected when a category fee changed after those registrations were taken.',
      action: { label: 'Review categories', to: '/categories' }
    });
  }

  return items;
}

// ---------------------------------------------------------------- participants

/**
 * The participant directory reads from registrations rather than a second
 * table. There is no separate participant record in this system, and inventing
 * one would create two things to keep in step for no gain.
 */
export async function listParticipants(query = {}) {
  const result = await listRegistrations({ ...query, status: query.status || 'PAID' });
  return result;
}

/**
 * Possible duplicates, offered as a review aid. Nothing is merged: the data
 * model has no merge, and two people can legitimately share a phone number
 * (a parent registering two children).
 */
export async function findPossibleDuplicates() {
  const rows = await prisma.$queryRaw`
    SELECT LOWER(email) AS key, 'email' AS kind, COUNT(*)::int AS count,
           ARRAY_AGG(reference ORDER BY created_at) AS refs,
           ARRAY_AGG(full_name ORDER BY created_at) AS names
    FROM registrations
    WHERE status <> 'CANCELLED'
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
    UNION ALL
    SELECT phone AS key, 'phone' AS kind, COUNT(*)::int AS count,
           ARRAY_AGG(reference ORDER BY created_at) AS refs,
           ARRAY_AGG(full_name ORDER BY created_at) AS names
    FROM registrations
    WHERE status <> 'CANCELLED'
    GROUP BY phone
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 100
  `;

  return rows.map((r) => ({
    key: r.key,
    kind: r.kind,
    count: r.count,
    references: r.refs,
    names: r.names
  }));
}

// ------------------------------------------------------------------ audit log

export async function listAuditLogs(query = {}) {
  const { take, skip, page, pageSize } = clampPaging(query);
  const where = {};

  if (query.action) where.action = query.action;
  if (query.entityType) where.entityType = query.entityType;
  if (query.actor) where.actorEmail = { contains: query.actor, mode: 'insensitive' };

  const from = parseDateBoundary(query.from);
  const to = parseDateBoundary(query.to, true);
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [total, rows, actions] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip }),
    prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true } })
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorEmail: r.actorEmail,
      entityType: r.entityType,
      entityId: r.entityId,
      outcome: r.outcome,
      metadata: r.metadata,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt
    })),
    availableActions: actions.map((a) => ({ action: a.action, count: a._count._all })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: skip + rows.length < total
    }
  };
}

// -------------------------------------------------------------- communication

export async function listEmailDeliveries(query = {}) {
  const { take, skip, page, pageSize } = clampPaging(query);
  const where = {};

  if (['PENDING', 'SENT', 'FAILED'].includes(query.status)) where.status = query.status;
  if (query.q) {
    where.OR = [
      { registrationReference: { contains: query.q, mode: 'insensitive' } },
      { recipientEmail: { contains: query.q, mode: 'insensitive' } }
    ];
  }

  const [total, rows, byStatus] = await Promise.all([
    prisma.emailDelivery.count({ where }),
    prisma.emailDelivery.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip }),
    prisma.emailDelivery.groupBy({ by: ['status'], _count: { _all: true } })
  ]);

  return {
    items: rows.map((d) => ({
      id: d.id,
      reference: d.registrationReference,
      recipientEmail: d.recipientEmail,
      emailType: d.emailType,
      subject: d.subject,
      status: d.status,
      attemptCount: d.attemptCount,
      lastAttemptAt: d.lastAttemptAt,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt
    })),
    summary: {
      pending: byStatus.find((s) => s.status === 'PENDING')?._count._all ?? 0,
      sent: byStatus.find((s) => s.status === 'SENT')?._count._all ?? 0,
      failed: byStatus.find((s) => s.status === 'FAILED')?._count._all ?? 0
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: skip + rows.length < total
    }
  };
}

// --------------------------------------------------------------------- coupons

export async function listCoupons(query = {}) {
  const { take, skip, page, pageSize } = clampPaging(query);
  const where = {};
  const and = [];

  const now = new Date();

  // Search by code, displayCode, or description
  const search = (query.q || '').trim();
  if (search) {
    const normalised = search.toUpperCase().replace(/[\s\-_]+/g, '');
    and.push({
      OR: [
        { code: { contains: normalised } },
        { displayCode: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ]
    });
  }

  // Filter by category
  if (query.category) {
    and.push({
      OR: [
        { categorySlugs: { has: query.category } },
        { categorySlugs: { isEmpty: true } }
      ]
    });
  }

  // Filter by batchId
  if (query.batchId) {
    where.batchId = query.batchId;
  }

  // Filter by status (including derived)
  if (query.status) {
    const st = query.status.toUpperCase();
    if (st === 'ARCHIVED') {
      where.isArchived = true;
    } else if (st === 'PAUSED') {
      where.isArchived = false;
      where.status = 'PAUSED';
    } else if (st === 'EXPIRED') {
      where.isArchived = false;
      where.status = 'ACTIVE';
      where.expiresAt = { lte: now };
    } else if (st === 'SCHEDULED') {
      where.isArchived = false;
      where.status = 'ACTIVE';
      where.startsAt = { gt: now };
    } else if (st === 'EXHAUSTED') {
      where.isArchived = false;
      where.status = 'ACTIVE';
      and.push({
        NOT: { maxRedemptions: null }
      });
    } else if (st === 'ACTIVE') {
      where.isArchived = false;
      where.status = 'ACTIVE';
      and.push({
        OR: [{ startsAt: null }, { startsAt: { lte: now } }]
      });
      and.push({
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      });
    }
  } else {
    // Default: exclude archived
    where.isArchived = false;
  }

  if (and.length) where.AND = and;

  // Sorting
  let orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
  if (query.sort) {
    const dir = query.order === 'asc' ? 'asc' : 'desc';
    if (query.sort === 'code') orderBy = [{ code: dir }, { id: 'desc' }];
    else if (query.sort === 'discount' || query.sort === 'discountValue') orderBy = [{ discountValue: dir }, { id: 'desc' }];
    else if (query.sort === 'usage' || query.sort === 'redeemedCount') orderBy = [{ redeemedCount: dir }, { id: 'desc' }];
    else if (query.sort === 'expiry' || query.sort === 'expiresAt') orderBy = [{ expiresAt: dir }, { id: 'desc' }];
    else if (query.sort === 'created' || query.sort === 'createdAt') orderBy = [{ createdAt: dir }, { id: 'desc' }];
  }

  const [total, rows] = await Promise.all([
    prisma.coupon.count({ where }),
    prisma.coupon.findMany({
      where,
      orderBy,
      take,
      skip
    })
  ]);

  const couponIds = rows.map((r) => r.id);

  // Grouped aggregates from coupon_redemptions
  const redemptionAggs = couponIds.length > 0
    ? await prisma.$queryRaw`
        SELECT
          coupon_id AS "couponId",
          COUNT(id) FILTER (WHERE status = 'CONSUMED')::int AS "consumedCount",
          COUNT(id) FILTER (WHERE status = 'RESERVED')::int AS "reservedCount",
          COALESCE(SUM(discount_paise) FILTER (WHERE status = 'CONSUMED'), 0)::bigint AS "discountGivenPaise"
        FROM coupon_redemptions
        WHERE coupon_id = ANY(${couponIds})
        GROUP BY coupon_id
      `
    : [];

  const aggMap = new Map();
  for (const agg of redemptionAggs) {
    aggMap.set(agg.couponId, {
      consumedCount: agg.consumedCount || 0,
      reservedCount: agg.reservedCount || 0,
      discountGivenPaise: Number(agg.discountGivenPaise || 0)
    });
  }

  const items = rows.map((c) => {
    const agg = aggMap.get(c.id) || { consumedCount: 0, reservedCount: 0, discountGivenPaise: 0 };
    const effectiveStatus = getEffectiveStatus(c, now);
    const remaining = c.maxRedemptions !== null ? Math.max(0, c.maxRedemptions - c.redeemedCount) : null;

    return {
      id: c.id,
      code: c.code,
      displayCode: c.displayCode,
      description: c.description,
      discountType: c.discountType,
      discountValue: c.discountValue,
      categorySlugs: c.categorySlugs,
      maxRedemptions: c.maxRedemptions,
      redeemedCount: c.redeemedCount,
      perEmailLimit: c.perEmailLimit,
      remaining,
      startsAt: c.startsAt,
      expiresAt: c.expiresAt,
      status: c.status,
      effectiveStatus,
      isArchived: c.isArchived,
      archivedAt: c.archivedAt,
      batchId: c.batchId,
      batchLabel: c.batchLabel,
      createdByEmail: c.createdByEmail,
      consumedCount: agg.consumedCount,
      reservedCount: agg.reservedCount,
      discountGivenPaise: agg.discountGivenPaise,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    };
  });

  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: skip + rows.length < total
    }
  };
}

export async function getCouponsSummary() {
  const now = new Date();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [
    totalCoupons,
    activeCoupons,
    expiredCoupons,
    discountConsumed,
    redemptionsToday,
    topCouponsRaw,
    expiringIn7Days
  ] = await Promise.all([
    prisma.coupon.count({ where: { isArchived: false } }),
    prisma.coupon.count({
      where: {
        isArchived: false,
        status: 'ACTIVE',
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }]
      }
    }),
    prisma.coupon.count({
      where: {
        isArchived: false,
        expiresAt: { lte: now }
      }
    }),
    prisma.couponRedemption.aggregate({
      where: { status: 'CONSUMED' },
      _sum: { discountPaise: true },
      _count: { _all: true }
    }),
    prisma.couponRedemption.count({
      where: {
        status: 'CONSUMED',
        consumedAt: { gte: startOfToday }
      }
    }),
    prisma.$queryRaw`
      SELECT
        c.id,
        c.code,
        c.display_code AS "displayCode",
        c.discount_value AS "discountValue",
        COUNT(r.id)::int AS "consumedCount",
        COALESCE(SUM(r.discount_paise), 0)::bigint AS "discountGivenPaise"
      FROM coupons c
      JOIN coupon_redemptions r ON r.coupon_id = c.id
      WHERE r.status = 'CONSUMED'
      GROUP BY c.id, c.code, c.display_code, c.discount_value
      ORDER BY "consumedCount" DESC
      LIMIT 5
    `,
    prisma.coupon.count({
      where: {
        isArchived: false,
        status: 'ACTIVE',
        expiresAt: {
          gt: now,
          lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        }
      }
    })
  ]);

  return {
    totalCoupons,
    activeCoupons,
    expiredCoupons,
    expiringIn7Days,
    totalDiscountConsumedPaise: Number(discountConsumed._sum.discountPaise ?? 0),
    consumedRedemptionsCount: discountConsumed._count._all,
    redemptionsToday,
    topCoupons: topCouponsRaw.map((tc) => ({
      id: tc.id,
      code: tc.code,
      displayCode: tc.displayCode,
      discountValue: tc.discountValue,
      consumedCount: tc.consumedCount,
      discountGivenPaise: Number(tc.discountGivenPaise || 0)
    }))
  };
}

export async function getCouponDetail(id) {
  const coupon = await prisma.coupon.findUnique({
    where: { id }
  });

  if (!coupon) {
    const error = new Error('Coupon not found.');
    error.status = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }

  const now = new Date();
  const effectiveStatus = getEffectiveStatus(coupon, now);
  const remaining = coupon.maxRedemptions !== null ? Math.max(0, coupon.maxRedemptions - coupon.redeemedCount) : null;

  // Stats
  const stats = await prisma.$queryRaw`
    SELECT
      COUNT(id) FILTER (WHERE status = 'RESERVED')::int AS "reservedCount",
      COUNT(id) FILTER (WHERE status = 'CONSUMED')::int AS "consumedCount",
      COUNT(id) FILTER (WHERE status = 'RELEASED')::int AS "releasedCount",
      COALESCE(SUM(discount_paise) FILTER (WHERE status = 'CONSUMED'), 0)::bigint AS "discountConsumedPaise",
      COALESCE(SUM(discount_paise) FILTER (WHERE status = 'RESERVED'), 0)::bigint AS "discountReservedPaise"
    FROM coupon_redemptions
    WHERE coupon_id = ${id}
  `;

  const s = stats[0] || { reservedCount: 0, consumedCount: 0, releasedCount: 0, discountConsumedPaise: 0, discountReservedPaise: 0 };

  const recentRedemptions = await prisma.couponRedemption.findMany({
    where: { couponId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 10,
    include: {
      registration: {
        select: {
          reference: true,
          fullName: true,
          email: true,
          categorySlug: true
        }
      }
    }
  });

  return {
    coupon: {
      ...coupon,
      effectiveStatus,
      remaining
    },
    stats: {
      reservedCount: s.reservedCount || 0,
      consumedCount: s.consumedCount || 0,
      releasedCount: s.releasedCount || 0,
      discountConsumedPaise: Number(s.discountConsumedPaise || 0),
      discountReservedPaise: Number(s.discountReservedPaise || 0),
      redemptionRate: coupon.maxRedemptions ? ((s.consumedCount / coupon.maxRedemptions) * 100).toFixed(1) : null
    },
    recentRedemptions: recentRedemptions.map((r) => ({
      id: r.id,
      registrationReference: r.registrationReference,
      fullName: r.registration?.fullName || '',
      email: r.email,
      categorySlug: r.categorySlug,
      baseAmountPaise: r.baseAmountPaise,
      discountPaise: r.discountPaise,
      payableAmountPaise: r.payableAmountPaise,
      status: r.status,
      reservedAt: r.reservedAt,
      consumedAt: r.consumedAt,
      releasedAt: r.releasedAt,
      releaseReason: r.releaseReason,
      createdAt: r.createdAt
    }))
  };
}

export async function listCouponRedemptions(couponId, query = {}) {
  const { take, skip, page, pageSize } = clampPaging(query);
  const where = { couponId };

  if (query.status && ['RESERVED', 'CONSUMED', 'RELEASED'].includes(query.status)) {
    where.status = query.status;
  }

  const [total, rows] = await Promise.all([
    prisma.couponRedemption.count({ where }),
    prisma.couponRedemption.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      skip,
      include: {
        registration: {
          select: { fullName: true }
        }
      }
    })
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      registrationReference: r.registrationReference,
      fullName: r.registration?.fullName || '',
      email: r.email,
      categorySlug: r.categorySlug,
      baseAmountPaise: r.baseAmountPaise,
      discountPaise: r.discountPaise,
      payableAmountPaise: r.payableAmountPaise,
      status: r.status,
      reservedAt: r.reservedAt,
      consumedAt: r.consumedAt,
      releasedAt: r.releasedAt,
      releaseReason: r.releaseReason,
      createdAt: r.createdAt
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: skip + rows.length < total
    }
  };
}

export async function* streamCoupons(query = {}, batchSize = 500) {
  let cursor = null;
  const where = {};
  if (query.status === 'ARCHIVED') where.isArchived = true;
  else if (query.status === 'PAUSED') { where.status = 'PAUSED'; where.isArchived = false; }
  else if (query.status === 'ACTIVE') { where.status = 'ACTIVE'; where.isArchived = false; }
  else where.isArchived = false;

  const now = new Date();

  for (;;) {
    const rows = await prisma.coupon.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    });

    if (rows.length === 0) return;
    for (const row of rows) {
      yield {
        ...row,
        effectiveStatus: getEffectiveStatus(row, now)
      };
    }
    if (rows.length < batchSize) return;
    cursor = rows[rows.length - 1].id;
  }
}

export async function* streamCouponRedemptions(query = {}, batchSize = 500) {
  let cursor = null;
  const where = {};
  if (query.couponId) where.couponId = query.couponId;
  if (query.status) where.status = query.status;

  for (;;) {
    const rows = await prisma.couponRedemption.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { registration: { select: { fullName: true } } }
    });

    if (rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < batchSize) return;
    cursor = rows[rows.length - 1].id;
  }
}

