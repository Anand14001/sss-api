import { prisma } from '../db/prisma.js';
import { CATEGORIES, EVENT_CONFIG, ALLOWED_OCCUPATIONS } from '../config/event.js';
import { env } from '../config/env.js';
import {
  getOverviewMetrics,
  getTrends,
  getRecentRegistrations,
  getAttentionItems,
  listRegistrations,
  getRegistrationDetail,
  listPayments,
  listAuditLogs,
  listEmailDeliveries,
  listParticipants,
  findPossibleDuplicates,
  streamRegistrations,
  streamPayments,
  listCoupons,
  getCouponsSummary,
  getCouponDetail,
  listCouponRedemptions,
  streamCoupons,
  streamCouponRedemptions,
  REGISTRATION_STATUSES,
  PAYMENT_STATUSES
} from '../services/adminQueries.js';
import {
  addRegistrationNote,
  cancelRegistration,
  setCheckIn,
  reconcilePayment,
  resendConfirmationEmail,
  createCouponAction,
  generateCouponsAction,
  updateCouponAction,
  pauseCouponAction,
  resumeCouponAction,
  deleteCouponAction,
  archiveCouponBatchAction,
  sweepStaleReservationsAction
} from '../services/adminActions.js';
import { checkCouponsIntegrity } from '../services/coupons.js';
import { buildCsv, csvFilename } from '../services/csv.js';
import { auditFromRequest, AUDIT_ACTIONS } from '../services/audit.js';
import { getTransporter, sendPasswordResetEmail } from '../services/email.js';
import { getRazorpayClient } from '../services/razorpay.js';
import {
  hashPassword,
  validatePassword,
  createPasswordResetToken,
  revokeAllSessionsFor
} from '../services/adminAuth.js';
import crypto from 'node:crypto';

const rupees = (paise) => (paise == null ? '' : (paise / 100).toFixed(2));

// --------------------------------------------------------------------- overview

export async function overviewHandler(req, res, next) {
  try {
    // One round trip for the whole page. Four sequential requests would make the
    // dashboard feel slow on the hotel wifi it will actually be used on.
    const [metrics, trends, recent, attention] = await Promise.all([
      getOverviewMetrics(),
      getTrends({ days: req.query.days }),
      getRecentRegistrations(8),
      getAttentionItems()
    ]);
    res.json({ success: true, metrics, trends, recent, attention });
  } catch (err) {
    next(err);
  }
}

export async function trendsHandler(req, res, next) {
  try {
    res.json({ success: true, ...(await getTrends({ days: req.query.days })) });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- registrations

export async function listRegistrationsHandler(req, res, next) {
  try {
    const result = await listRegistrations(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function registrationDetailHandler(req, res, next) {
  try {
    const registration = await getRegistrationDetail(req.params.reference);
    res.json({ success: true, registration });
  } catch (err) {
    next(err);
  }
}

export async function addNoteHandler(req, res, next) {
  try {
    const note = await addRegistrationNote({
      reference: req.params.reference,
      body: req.body?.body,
      admin: req.admin
    });
    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.REGISTRATION_NOTE_ADDED,
      entityType: 'registration',
      entityId: req.params.reference,
      metadata: { noteId: note.id }
    });
    res.status(201).json({ success: true, note });
  } catch (err) {
    next(err);
  }
}

export async function cancelRegistrationHandler(req, res, next) {
  try {
    const result = await cancelRegistration({
      reference: req.params.reference,
      reason: req.body?.reason,
      acknowledgeNoRefund: req.body?.acknowledgeNoRefund === true,
      admin: req.admin
    });
    if (!result.alreadyCancelled) {
      await auditFromRequest(req, {
        action: AUDIT_ACTIONS.REGISTRATION_CANCELLED,
        entityType: 'registration',
        entityId: req.params.reference,
        metadata: {
          reason: req.body?.reason,
          previousStatus: result.previousStatus,
          wasPaid: result.wasPaid
        }
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    // A refused cancellation is still worth recording: it shows someone tried.
    if (err.code === 'REFUND_ACKNOWLEDGEMENT_REQUIRED') {
      await auditFromRequest(req, {
        action: AUDIT_ACTIONS.REGISTRATION_CANCELLED,
        entityType: 'registration',
        entityId: req.params.reference,
        outcome: 'BLOCKED',
        metadata: { reason: 'refund_acknowledgement_required' }
      });
    }
    next(err);
  }
}

export async function checkInHandler(req, res, next) {
  try {
    const result = await setCheckIn({
      reference: req.params.reference,
      checkedIn: req.body?.checkedIn !== false,
      admin: req.admin
    });
    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.REGISTRATION_CHECKED_IN,
      entityType: 'registration',
      entityId: req.params.reference,
      metadata: { checkedIn: Boolean(result.checkedInAt) }
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// -------------------------------------------------------------------- payments

export async function listPaymentsHandler(req, res, next) {
  try {
    const result = await listPayments(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function reconcilePaymentHandler(req, res, next) {
  try {
    const result = await reconcilePayment({ orderId: req.params.orderId, admin: req.admin });
    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.PAYMENT_RECONCILED,
      entityType: 'payment',
      entityId: req.params.orderId,
      outcome: result.reconciled ? 'SUCCESS' : 'NO_CHANGE',
      metadata: {
        reference: result.reference,
        gatewayStatus: result.gatewayStatus,
        mismatch: result.mismatch ?? null
      }
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------- participants

export async function listParticipantsHandler(req, res, next) {
  try {
    const result = await listParticipants(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function duplicatesHandler(req, res, next) {
  try {
    res.json({ success: true, duplicates: await findPossibleDuplicates() });
  } catch (err) {
    next(err);
  }
}

// ------------------------------------------------------------------ categories

/**
 * Categories are read-only here, and that is a decision rather than an omission.
 *
 * The authoritative fees live in src/config/event.js and are what the public
 * registration flow prices against; the categories table is a seeded mirror of
 * that file. A fee editor in the dashboard would create a second source of
 * truth that the checkout path does not read, so an edit would appear to work
 * and change nothing. Changing a fee is a code change plus a reseed, which the
 * response says plainly.
 */
export async function categoriesHandler(req, res, next) {
  try {
    const [stored, counts, revenue] = await Promise.all([
      prisma.category.findMany({ orderBy: { minAge: 'asc' } }),
      prisma.registration.groupBy({ by: ['categorySlug', 'status'], _count: { _all: true } }),
      prisma.$queryRaw`
        SELECT r.category_slug AS slug, COALESCE(SUM(p.amount_paise), 0)::bigint AS revenue_paise
        FROM payments p
        JOIN registrations r ON r.id = p.registration_id
        WHERE p.status = 'CAPTURED'
        GROUP BY r.category_slug
      `
    ]);

    const categories = Object.values(CATEGORIES).map((cat) => {
      const row = stored.find((s) => s.slug === cat.slug);
      const countFor = (status) =>
        counts.find((c) => c.categorySlug === cat.slug && c.status === status)?._count._all ?? 0;

      return {
        slug: cat.slug,
        name: cat.name,
        formLabel: cat.formLabel,
        minAge: cat.minAge,
        maxAge: cat.maxAge,
        feePaise: cat.feePaise,
        currency: cat.currency,
        isActive: row?.isActive ?? true,
        // Flagged rather than silently reconciled: if these ever disagree the
        // database was seeded from a different version of the config.
        storedFeePaise: row?.feePaise ?? null,
        inSync: row ? row.feePaise === cat.feePaise : false,
        counts: {
          confirmed: countFor('PAID'),
          awaitingPayment: countFor('AWAITING_PAYMENT'),
          cancelled: countFor('CANCELLED')
        },
        revenuePaise: Number(revenue.find((r) => r.slug === cat.slug)?.revenue_paise ?? 0)
      };
    });

    res.json({
      success: true,
      categories,
      editable: false,
      sourceOfTruth: 'sss-api/src/config/event.js, mirrored into the categories table by prisma/seed.js',
      note: 'Fees and age ranges are fixed in server configuration so the public checkout and the dashboard can never disagree. Changing one is a code change plus a reseed; existing registrations keep the amount they were charged.'
    });
  } catch (err) {
    next(err);
  }
}

// --------------------------------------------------------------------- contest

export async function contestHandler(req, res, next) {
  try {
    const [byCategory, checkedInByCategory, total] = await Promise.all([
      prisma.registration.groupBy({
        by: ['categorySlug'],
        where: { status: 'PAID' },
        _count: { _all: true }
      }),
      prisma.registration.groupBy({
        by: ['categorySlug'],
        where: { status: 'PAID', NOT: { checkedInAt: null } },
        _count: { _all: true }
      }),
      prisma.registration.count({ where: { status: 'PAID' } })
    ]);

    res.json({
      success: true,
      event: {
        name: EVENT_CONFIG.name,
        dateDisplay: EVENT_CONFIG.dateDisplay,
        date: EVENT_CONFIG.date,
        deadline: EVENT_CONFIG.deadline,
        deadlineDisplay: EVENT_CONFIG.deadlineDisplay,
        venue: EVENT_CONFIG.venue,
        organisers: EVENT_CONFIG.organisers,
        contacts: EVENT_CONFIG.contacts,
        prizes: EVENT_CONFIG.prizes,
        prelims: EVENT_CONFIG.prelims
      },
      confirmedTotal: total,
      categories: Object.values(CATEGORIES).map((cat) => ({
        slug: cat.slug,
        name: cat.name,
        formLabel: cat.formLabel,
        confirmed: byCategory.find((c) => c.categorySlug === cat.slug)?._count._all ?? 0,
        checkedIn: checkedInByCategory.find((c) => c.categorySlug === cat.slug)?._count._all ?? 0
      })),
      // Stated explicitly so the page does not imply the system holds results.
      capabilities: {
        checkIn: true,
        rounds: false,
        judging: false,
        results: false
      }
    });
  } catch (err) {
    next(err);
  }
}

// --------------------------------------------------------------- communication

export async function emailDeliveriesHandler(req, res, next) {
  try {
    const result = await listEmailDeliveries(req.query);
    res.json({
      success: true,
      ...result,
      transport: {
        configured: Boolean(getTransporter()),
        // Never the password, host credentials or port specifics.
        fromName: env.MAIL_FROM_NAME,
        note: 'A sent status means the mail server accepted the message. It is not a delivery or read receipt.'
      }
    });
  } catch (err) {
    next(err);
  }
}

export async function resendEmailHandler(req, res, next) {
  try {
    const result = await resendConfirmationEmail({
      reference: req.params.reference,
      admin: req.admin
    });
    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.EMAIL_RESENT,
      entityType: 'registration',
      entityId: req.params.reference,
      outcome: result.accepted ? 'SUCCESS' : 'FAILURE',
      metadata: { simulated: result.simulated, error: result.error }
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// --------------------------------------------------------------------- audit

export async function auditLogHandler(req, res, next) {
  try {
    const result = await listAuditLogs(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

// -------------------------------------------------------------------- settings

export async function settingsHandler(req, res, next) {
  try {
    let database = 'connected';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'disconnected';
    }

    const [adminCount, sessionCount] = await Promise.all([
      prisma.adminUser.count({ where: { isActive: true } }),
      prisma.adminSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } })
    ]);

    res.json({
      success: true,
      event: {
        name: EVENT_CONFIG.name,
        shortName: EVENT_CONFIG.shortName,
        dateDisplay: EVENT_CONFIG.dateDisplay,
        deadlineDisplay: EVENT_CONFIG.deadlineDisplay,
        deadline: EVENT_CONFIG.deadline,
        venue: EVENT_CONFIG.venue,
        organisers: EVENT_CONFIG.organisers,
        contacts: EVENT_CONFIG.contacts,
        occupations: ALLOWED_OCCUPATIONS,
        editable: false,
        sourceOfTruth: 'sss-api/src/config/event.js'
      },
      system: {
        service: 'sss-api',
        version: '1.0.0',
        environment: env.NODE_ENV,
        database,
        // Presence only. Which integrations are wired up is operational
        // information; their values are not, and never leave the server.
        integrations: {
          razorpay: Boolean(getRazorpayClient()),
          smtp: Boolean(getTransporter()),
          webhookSecret: Boolean(env.RAZORPAY_WEBHOOK_SECRET)
        },
        activeAdmins: adminCount,
        activeSessions: sessionCount,
        serverTime: new Date().toISOString()
      }
    });
  } catch (err) {
    next(err);
  }
}

// --------------------------------------------------------------------- exports

const REPORTS = {
  registrations: {
    label: 'All registrations',
    description: 'Every registration matching the current filters, with its payment state.',
    columns: [
      { label: 'Reference', value: (r) => r.reference },
      { label: 'Full name', value: (r) => r.fullName },
      { label: 'Email', value: (r) => r.email },
      { label: 'Phone', value: (r) => r.phone },
      { label: 'Category', value: (r) => CATEGORIES[r.categorySlug]?.name ?? r.categorySlug },
      { label: 'Age on contest day', value: (r) => r.ageOnContest },
      { label: 'City', value: (r) => r.city },
      { label: 'Occupation', value: (r) => r.occupation },
      { label: 'Guardian name', value: (r) => r.guardianName ?? '' },
      { label: 'Guardian phone', value: (r) => r.guardianPhone ?? '' },
      { label: 'Base fee (INR)', value: (r) => rupees(r.baseAmountPaise ?? r.amountPaise) },
      { label: 'Coupon code', value: (r) => r.couponCode ?? '' },
      { label: 'Discount (INR)', value: (r) => rupees(r.discountPaise ?? 0) },
      { label: 'Fee paid (INR)', value: (r) => rupees(r.amountPaise) },
      { label: 'Registration status', value: (r) => r.status },
      { label: 'Payment status', value: (r) => r.payments?.[0]?.status ?? '' },
      { label: 'Registered at', value: (r) => r.createdAt.toISOString() }
    ],
    source: (query) => streamRegistrations(query)
  },

  confirmed: {
    label: 'Confirmed registrations',
    description: 'Registrations whose fee has been verified as captured.',
    columns: [
      { label: 'Reference', value: (r) => r.reference },
      { label: 'Full name', value: (r) => r.fullName },
      { label: 'Email', value: (r) => r.email },
      { label: 'Phone', value: (r) => r.phone },
      { label: 'Category', value: (r) => CATEGORIES[r.categorySlug]?.name ?? r.categorySlug },
      { label: 'City', value: (r) => r.city },
      { label: 'Fee paid (INR)', value: (r) => rupees(r.amountPaise) },
      { label: 'Confirmed at', value: (r) => r.updatedAt.toISOString() }
    ],
    source: (query) => streamRegistrations({ ...query, status: 'PAID' })
  },

  'event-day': {
    label: 'Event-day participant list',
    description:
      'Confirmed participants for the registration desk. Contact details only; no payment data.',
    columns: [
      { label: 'Reference', value: (r) => r.reference },
      { label: 'Full name', value: (r) => r.fullName },
      { label: 'Category', value: (r) => CATEGORIES[r.categorySlug]?.name ?? r.categorySlug },
      { label: 'Age on contest day', value: (r) => r.ageOnContest },
      { label: 'Phone', value: (r) => r.phone },
      { label: 'Guardian name', value: (r) => r.guardianName ?? '' },
      { label: 'Guardian phone', value: (r) => r.guardianPhone ?? '' },
      { label: 'Checked in at', value: (r) => (r.checkedInAt ? r.checkedInAt.toISOString() : '') }
    ],
    source: (query) => streamRegistrations({ ...query, status: 'PAID' })
  },

  'pending-payments': {
    label: 'Pending and failed payments',
    description: 'Orders that were created but never captured, and orders Razorpay rejected.',
    columns: [
      { label: 'Reference', value: (p) => p.registrationReference },
      { label: 'Participant', value: (p) => p.registration?.fullName ?? '' },
      { label: 'Category', value: (p) => CATEGORIES[p.registration?.categorySlug]?.name ?? '' },
      { label: 'Razorpay order ID', value: (p) => p.razorpayOrderId },
      { label: 'Razorpay payment ID', value: (p) => p.razorpayPaymentId ?? '' },
      { label: 'Amount (INR)', value: (p) => rupees(p.amountPaise) },
      { label: 'Payment status', value: (p) => p.status },
      { label: 'Failure reason', value: (p) => p.failureReason ?? '' },
      { label: 'Created at', value: (p) => p.createdAt.toISOString() }
    ],
    source: (query) => streamPayments({ ...query, status: query.status || undefined }),
    filter: (p) => p.status !== 'CAPTURED'
  },

  collections: {
    label: 'Verified collections',
    description: 'Captured payments only. This is the figure that reconciles against Razorpay.',
    columns: [
      { label: 'Reference', value: (p) => p.registrationReference },
      { label: 'Participant', value: (p) => p.registration?.fullName ?? '' },
      { label: 'Category', value: (p) => CATEGORIES[p.registration?.categorySlug]?.name ?? '' },
      { label: 'Razorpay order ID', value: (p) => p.razorpayOrderId },
      { label: 'Razorpay payment ID', value: (p) => p.razorpayPaymentId ?? '' },
      { label: 'Amount collected (INR)', value: (p) => rupees(p.amountPaise) },
      { label: 'Currency', value: (p) => p.currency },
      { label: 'Captured at', value: (p) => p.updatedAt.toISOString() }
    ],
    source: (query) => streamPayments({ ...query, status: 'CAPTURED' })
  },

  coupons: {
    label: 'Coupons list',
    description: 'All coupons including usage counts and discount configuration.',
    columns: [
      { label: 'Code', value: (c) => c.code },
      { label: 'Display code', value: (c) => c.displayCode },
      { label: 'Description', value: (c) => c.description ?? '' },
      { label: 'Discount type', value: (c) => c.discountType },
      { label: 'Discount value (%)', value: (c) => c.discountValue },
      { label: 'Categories', value: (c) => (c.categorySlugs?.length ? c.categorySlugs.join(';') : 'ALL') },
      { label: 'Usage limit', value: (c) => c.maxRedemptions ?? 'UNLIMITED' },
      { label: 'Redeemed count', value: (c) => c.redeemedCount },
      { label: 'Effective status', value: (c) => c.effectiveStatus },
      { label: 'Status', value: (c) => c.status },
      { label: 'Starts at', value: (c) => (c.startsAt ? c.startsAt.toISOString() : '') },
      { label: 'Expires at', value: (c) => (c.expiresAt ? c.expiresAt.toISOString() : '') },
      { label: 'Batch ID', value: (c) => c.batchId ?? '' },
      { label: 'Created at', value: (c) => c.createdAt.toISOString() }
    ],
    source: (query) => streamCoupons(query)
  },

  'coupon-redemptions': {
    label: 'Coupon redemptions ledger',
    description: 'Detailed redemption records linking participants to used coupons.',
    columns: [
      { label: 'Reference', value: (r) => r.registrationReference },
      { label: 'Participant', value: (r) => r.registration?.fullName ?? '' },
      { label: 'Email', value: (r) => r.email },
      { label: 'Category', value: (r) => r.categorySlug },
      { label: 'Coupon code', value: (r) => r.couponCode },
      { label: 'Base fee (INR)', value: (r) => rupees(r.baseAmountPaise) },
      { label: 'Discount (INR)', value: (r) => rupees(r.discountPaise) },
      { label: 'Payable (INR)', value: (r) => rupees(r.payableAmountPaise) },
      { label: 'Status', value: (r) => r.status },
      { label: 'Reserved at', value: (r) => (r.reservedAt ? r.reservedAt.toISOString() : '') },
      { label: 'Consumed at', value: (r) => (r.consumedAt ? r.consumedAt.toISOString() : '') },
      { label: 'Released at', value: (r) => (r.releasedAt ? r.releasedAt.toISOString() : '') },
      { label: 'Release reason', value: (r) => r.releaseReason ?? '' }
    ],
    source: (query) => streamCouponRedemptions(query)
  }
};

export function listReportsHandler(req, res) {
  res.json({
    success: true,
    reports: Object.entries(REPORTS).map(([id, r]) => ({
      id,
      label: r.label,
      description: r.description,
      columns: r.columns.map((c) => c.label)
    }))
  });
}

/**
 * Builds a CSV from the same filters the operator had on screen.
 *
 * Rows are pulled in batches by the streaming generators rather than loaded in
 * one query, so an export stays flat in memory as the contest fills up. The
 * export itself is audited: it is the one action here that takes personal data
 * out of the system.
 */
export async function exportHandler(req, res, next) {
  try {
    const report = REPORTS[req.params.reportId];
    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Unknown report.',
        code: 'UNKNOWN_REPORT'
      });
    }

    const rows = [];
    for await (const row of report.source(req.query)) {
      if (report.filter && !report.filter(row)) continue;
      rows.push(row);
    }

    const csv = buildCsv(report.columns, rows);
    const filename = csvFilename(req.params.reportId, req.query.category || '');

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.EXPORT_GENERATED,
      entityType: 'report',
      entityId: req.params.reportId,
      metadata: {
        rowCount: rows.length,
        filters: {
          category: req.query.category ?? null,
          status: req.query.status ?? null,
          paymentStatus: req.query.paymentStatus ?? null,
          from: req.query.from ?? null,
          to: req.query.to ?? null,
          q: req.query.q ? '[search term]' : null
        }
      }
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Row-Count', String(rows.length));
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

export function filterOptionsHandler(req, res) {
  res.json({
    success: true,
    registrationStatuses: REGISTRATION_STATUSES,
    paymentStatuses: PAYMENT_STATUSES,
    couponStatuses: ['ACTIVE', 'SCHEDULED', 'PAUSED', 'EXPIRED', 'EXHAUSTED', 'ARCHIVED'],
    categories: Object.values(CATEGORIES).map((c) => ({
      slug: c.slug,
      name: c.name,
      formLabel: c.formLabel,
      feePaise: c.feePaise
    })),
    occupations: ALLOWED_OCCUPATIONS
  });
}

// --------------------------------------------------------------------- coupons

export async function listCouponsHandler(req, res, next) {
  try {
    const result = await listCoupons(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function couponsSummaryHandler(req, res, next) {
  try {
    const summary = await getCouponsSummary();
    res.json({ success: true, summary });
  } catch (err) {
    next(err);
  }
}

export async function createCouponHandler(req, res, next) {
  try {
    const coupon = await createCouponAction({
      data: req.body,
      adminEmail: req.admin?.email
    });

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_CREATED,
      entityType: 'coupon',
      entityId: coupon.id,
      metadata: { code: coupon.code, discountValue: coupon.discountValue }
    });

    res.status(201).json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
}

export async function generateCouponsHandler(req, res, next) {
  try {
    const result = await generateCouponsAction({
      data: req.body,
      adminEmail: req.admin?.email
    });

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_BATCH_GENERATED,
      entityType: 'coupon_batch',
      entityId: result.batchId,
      metadata: {
        count: result.coupons.length,
        batchId: result.batchId,
        discountValue: req.body?.discountValue
      }
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function couponDetailHandler(req, res, next) {
  try {
    const detail = await getCouponDetail(req.params.id);
    res.json({ success: true, ...detail });
  } catch (err) {
    next(err);
  }
}

export async function updateCouponHandler(req, res, next) {
  try {
    const { coupon, diff } = await updateCouponAction({
      id: req.params.id,
      data: req.body,
      adminEmail: req.admin?.email
    });

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_UPDATED,
      entityType: 'coupon',
      entityId: coupon.id,
      metadata: { diff }
    });

    res.json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
}

export async function pauseCouponHandler(req, res, next) {
  try {
    const coupon = await pauseCouponAction(req.params.id);

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_PAUSED,
      entityType: 'coupon',
      entityId: coupon.id,
      metadata: { code: coupon.code }
    });

    res.json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
}

export async function resumeCouponHandler(req, res, next) {
  try {
    const coupon = await resumeCouponAction(req.params.id);

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_RESUMED,
      entityType: 'coupon',
      entityId: coupon.id,
      metadata: { code: coupon.code }
    });

    res.json({ success: true, coupon });
  } catch (err) {
    next(err);
  }
}

export async function deleteCouponHandler(req, res, next) {
  try {
    const result = await deleteCouponAction(req.params.id);

    await auditFromRequest(req, {
      action: result.action === 'ARCHIVED' ? AUDIT_ACTIONS.COUPON_ARCHIVED : AUDIT_ACTIONS.COUPON_DELETED,
      entityType: 'coupon',
      entityId: result.couponId,
      metadata: { code: result.code }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function archiveCouponBatchHandler(req, res, next) {
  try {
    const result = await archiveCouponBatchAction(req.params.batchId);

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_BATCH_ARCHIVED,
      entityType: 'coupon_batch',
      entityId: req.params.batchId,
      metadata: { count: result.archivedCount }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function listCouponRedemptionsHandler(req, res, next) {
  try {
    const result = await listCouponRedemptions(req.params.id, req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function couponIntegrityHandler(req, res, next) {
  try {
    const integrity = await checkCouponsIntegrity(prisma);
    res.json({ success: true, integrity });
  } catch (err) {
    next(err);
  }
}

export async function sweepStaleReservationsHandler(req, res, next) {
  try {
    const ttlMinutes = req.body?.ttlMinutes ? parseInt(req.body.ttlMinutes, 10) : undefined;
    const result = await sweepStaleReservationsAction({ ttlMinutes });

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.COUPON_RESERVATIONS_SWEPT,
      entityType: 'coupon_reservations',
      metadata: { releasedCount: result.sweptCount }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

const SAFE_ADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  mustChangePassword: true,
  lastLoginAt: true,
  passwordChangedAt: true,
  createdAt: true,
  updatedAt: true
};

export async function listAdminUsersHandler(req, res, next) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const search = String(req.query.search ?? '').trim();
    const roleFilter = req.query.role;
    const statusFilter = req.query.status;
    const sortBy = ['createdAt', 'name', 'email', 'role', 'lastLoginAt'].includes(req.query.sortBy)
      ? req.query.sortBy
      : 'createdAt';
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';

    const where = {
      deletedAt: null
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (roleFilter && ['SUPER_ADMIN', 'ADMIN'].includes(roleFilter)) {
      where.role = roleFilter;
    }

    if (statusFilter === 'active') {
      where.isActive = true;
    } else if (statusFilter === 'inactive') {
      where.isActive = false;
    }

    const [users, total, totalAll, activeCount, inactiveCount, superAdminCount, adminCount] =
      await Promise.all([
        prisma.adminUser.findMany({
          where,
          select: SAFE_ADMIN_SELECT,
          orderBy: { [sortBy]: sortDir },
          skip,
          take: limit
        }),
        prisma.adminUser.count({ where }),
        prisma.adminUser.count({ where: { deletedAt: null } }),
        prisma.adminUser.count({ where: { isActive: true, deletedAt: null } }),
        prisma.adminUser.count({ where: { isActive: false, deletedAt: null } }),
        prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', deletedAt: null } }),
        prisma.adminUser.count({ where: { role: 'ADMIN', deletedAt: null } })
      ]);

    res.json({
      success: true,
      users,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      },
      counts: {
        total: totalAll,
        active: activeCount,
        inactive: inactiveCount,
        superAdmins: superAdminCount,
        admins: adminCount
      }
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdminUserDetailHandler(req, res, next) {
  try {
    const { id } = req.params;

    const user = await prisma.adminUser.findFirst({
      where: { id, deletedAt: null },
      select: SAFE_ADMIN_SELECT
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found.',
        code: 'NOT_FOUND'
      });
    }

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        OR: [{ entityType: 'admin_user', entityId: id }, { adminUserId: id }]
      },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    res.json({
      success: true,
      user,
      auditLogs
    });
  } catch (err) {
    next(err);
  }
}

export async function createAdminUserHandler(req, res, next) {
  try {
    const caller = req.admin;
    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const requestedRole = req.body?.role || 'ADMIN';
    const password = req.body?.password ? String(req.body.password) : null;

    if (!name || name.length < 2 || name.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'Full name is required and must be between 2 and 100 characters.',
        code: 'INVALID_NAME'
      });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'A valid email address is required.',
        code: 'INVALID_EMAIL'
      });
    }

    if (caller.role !== 'SUPER_ADMIN' && requestedRole === 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to create Super Administrators. Admin role assigned.',
        code: 'FORBIDDEN_SUPER_ADMIN_CREATION'
      });
    }

    const assignedRole =
      caller.role === 'SUPER_ADMIN' && requestedRole === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'ADMIN';

    const existingUser = await prisma.adminUser.findFirst({
      where: { email, deletedAt: null }
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'A user with this email address already exists.',
        code: 'EMAIL_ALREADY_EXISTS'
      });
    }

    let passwordHash;
    let setupToken = null;
    let resetTokenHash = null;
    let resetTokenExpiresAt = null;

    if (password) {
      const weaknesses = validatePassword(password);
      if (weaknesses.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Password does not meet security requirements: ${weaknesses.join(', ')}.`,
          code: 'WEAK_PASSWORD',
          details: weaknesses
        });
      }
      passwordHash = await hashPassword(password);
    } else {
      setupToken = crypto.randomBytes(32).toString('hex');
      resetTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
      resetTokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours for invitation
      const randomSecret = crypto.randomBytes(32).toString('base64');
      passwordHash = await hashPassword(randomSecret);
    }

    const user = await prisma.adminUser.create({
      data: {
        name,
        email,
        role: assignedRole,
        passwordHash,
        mustChangePassword: true,
        isActive: true,
        resetTokenHash,
        resetTokenExpiresAt
      },
      select: SAFE_ADMIN_SELECT
    });

    const adminBaseUrl = (env.ADMIN_URL || 'https://opt.eventsinfinite.com').replace(/\/$/, '');
    const resetLink = setupToken ? `${adminBaseUrl}/login?resetToken=${setupToken}` : null;

    if (setupToken) {
      await sendPasswordResetEmail({
        toEmail: email,
        name,
        resetLink
      }).catch((err) => console.error('[EMAIL ERROR]', err.message));
    }

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.USER_CREATED,
      entityType: 'admin_user',
      entityId: user.id,
      metadata: { email: user.email, role: user.role }
    });

    res.status(201).json({
      success: true,
      user,
      ...(setupToken ? { resetToken: setupToken, resetLink } : {})
    });
  } catch (err) {
    next(err);
  }
}

export async function updateAdminUserHandler(req, res, next) {
  try {
    const { id } = req.params;
    const { name, email, role, isActive } = req.body || {};
    const caller = req.admin;

    const targetUser = await prisma.adminUser.findFirst({
      where: { id, deletedAt: null }
    });

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found.',
        code: 'NOT_FOUND'
      });
    }

    // Role modification checks
    if (role !== undefined && role !== targetUser.role) {
      if (caller.role !== 'SUPER_ADMIN') {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to change user roles.',
          code: 'FORBIDDEN_ROLE_MODIFICATION'
        });
      }

      if (!['SUPER_ADMIN', 'ADMIN'].includes(role)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid role. Must be SUPER_ADMIN or ADMIN.',
          code: 'INVALID_ROLE'
        });
      }

      // Safeguard: Demoting last active SUPER_ADMIN
      if (targetUser.role === 'SUPER_ADMIN' && role === 'ADMIN') {
        const otherActiveSupers = await prisma.adminUser.count({
          where: {
            id: { not: targetUser.id },
            role: 'SUPER_ADMIN',
            isActive: true,
            deletedAt: null
          }
        });

        if (otherActiveSupers === 0) {
          return res.status(400).json({
            success: false,
            error: 'Cannot demote the last active Super Administrator.',
            code: 'CANNOT_DEMOTE_LAST_SUPER_ADMIN'
          });
        }
      }
    }

    // Deactivation safeguard for last active SUPER_ADMIN
    if (isActive === false && targetUser.isActive === true) {
      if (targetUser.role === 'SUPER_ADMIN') {
        const otherActiveSupers = await prisma.adminUser.count({
          where: {
            id: { not: targetUser.id },
            role: 'SUPER_ADMIN',
            isActive: true,
            deletedAt: null
          }
        });

        if (otherActiveSupers === 0) {
          return res.status(400).json({
            success: false,
            error: 'Cannot deactivate the last active Super Administrator.',
            code: 'CANNOT_DEACTIVATE_LAST_SUPER_ADMIN'
          });
        }
      }
    }

    const updateData = {};

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (trimmedName.length < 2 || trimmedName.length > 100) {
        return res.status(400).json({
          success: false,
          error: 'Full name must be between 2 and 100 characters.',
          code: 'INVALID_NAME'
        });
      }
      updateData.name = trimmedName;
    }

    if (email !== undefined) {
      const trimmedEmail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        return res.status(400).json({
          success: false,
          error: 'A valid email address is required.',
          code: 'INVALID_EMAIL'
        });
      }

      if (trimmedEmail !== targetUser.email) {
        const emailInUse = await prisma.adminUser.findFirst({
          where: {
            id: { not: targetUser.id },
            email: trimmedEmail,
            deletedAt: null
          }
        });
        if (emailInUse) {
          return res.status(409).json({
            success: false,
            error: 'A user with this email address already exists.',
            code: 'EMAIL_ALREADY_EXISTS'
          });
        }
        updateData.email = trimmedEmail;
      }
    }

    if (role !== undefined && caller.role === 'SUPER_ADMIN') {
      updateData.role = role;
    }

    if (isActive !== undefined) {
      updateData.isActive = Boolean(isActive);
      if (!updateData.isActive) {
        await revokeAllSessionsFor(targetUser.id);
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id: targetUser.id },
      data: updateData,
      select: SAFE_ADMIN_SELECT
    });

    // Audit changes
    if (updateData.role && updateData.role !== targetUser.role) {
      await auditFromRequest(req, {
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: 'admin_user',
        entityId: targetUser.id,
        metadata: { previousRole: targetUser.role, newRole: updateData.role }
      });
    }

    if (updateData.isActive !== undefined && updateData.isActive !== targetUser.isActive) {
      await auditFromRequest(req, {
        action: updateData.isActive ? AUDIT_ACTIONS.USER_ACTIVATED : AUDIT_ACTIONS.USER_DEACTIVATED,
        entityType: 'admin_user',
        entityId: targetUser.id,
        metadata: { email: targetUser.email }
      });
    }

    if (updateData.name || updateData.email) {
      await auditFromRequest(req, {
        action: AUDIT_ACTIONS.USER_UPDATED,
        entityType: 'admin_user',
        entityId: targetUser.id,
        metadata: {
          fields: Object.keys(updateData).filter((k) => k === 'name' || k === 'email')
        }
      });
    }

    res.json({ success: true, user: updated });
  } catch (err) {
    next(err);
  }
}

export async function updateAdminRoleHandler(req, res, next) {
  try {
    const { id } = req.params;
    const { role } = req.body || {};
    const caller = req.admin;

    if (caller.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to perform this action. Super-admin privileges required.',
        code: 'FORBIDDEN_SUPER_ADMIN_REQUIRED'
      });
    }

    if (!role || !['SUPER_ADMIN', 'ADMIN'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role. Must be SUPER_ADMIN or ADMIN.',
        code: 'INVALID_ROLE'
      });
    }

    const targetUser = await prisma.adminUser.findFirst({
      where: { id, deletedAt: null }
    });

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found.',
        code: 'NOT_FOUND'
      });
    }

    if (targetUser.role === 'SUPER_ADMIN' && role === 'ADMIN') {
      const otherActiveSupers = await prisma.adminUser.count({
        where: {
          id: { not: targetUser.id },
          role: 'SUPER_ADMIN',
          isActive: true,
          deletedAt: null
        }
      });

      if (otherActiveSupers === 0) {
        return res.status(400).json({
          success: false,
          error: 'Cannot demote the last active Super Administrator.',
          code: 'CANNOT_DEMOTE_LAST_SUPER_ADMIN'
        });
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data: { role },
      select: SAFE_ADMIN_SELECT
    });

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      entityType: 'admin_user',
      entityId: id,
      metadata: { previousRole: targetUser.role, newRole: role }
    });

    res.json({ success: true, user: updated });
  } catch (err) {
    next(err);
  }
}

export async function initiateAdminPasswordResetHandler(req, res, next) {
  try {
    const { id } = req.params;

    const targetUser = await prisma.adminUser.findFirst({
      where: { id, deletedAt: null }
    });

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found.',
        code: 'NOT_FOUND'
      });
    }

    const { token, expiresAt } = await createPasswordResetToken(targetUser.id);
    const adminBaseUrl = (env.ADMIN_URL || 'https://opt.eventsinfinite.com').replace(/\/$/, '');
    const resetLink = `${adminBaseUrl}/login?resetToken=${token}`;

    await sendPasswordResetEmail({
      toEmail: targetUser.email,
      name: targetUser.name,
      resetLink
    }).catch((err) => console.error('[EMAIL ERROR]', err.message));

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.USER_PASSWORD_RESET_INITIATED,
      entityType: 'admin_user',
      entityId: targetUser.id,
      metadata: { targetEmail: targetUser.email }
    });

    res.json({
      success: true,
      message: 'Password reset initiated successfully.',
      resetToken: token,
      resetLink,
      expiresAt
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminUserHandler(req, res, next) {
  try {
    const { id } = req.params;
    const caller = req.admin;

    if (caller.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to delete users. Super-admin privileges required.',
        code: 'FORBIDDEN_SUPER_ADMIN_REQUIRED'
      });
    }

    if (caller.id === id) {
      return res.status(400).json({
        success: false,
        error: 'You cannot delete your own account.',
        code: 'CANNOT_DELETE_SELF'
      });
    }

    const targetUser = await prisma.adminUser.findFirst({
      where: { id, deletedAt: null }
    });

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'Admin user not found.',
        code: 'NOT_FOUND'
      });
    }

    if (targetUser.role === 'SUPER_ADMIN') {
      const otherActiveSupers = await prisma.adminUser.count({
        where: {
          id: { not: targetUser.id },
          role: 'SUPER_ADMIN',
          isActive: true,
          deletedAt: null
        }
      });

      if (otherActiveSupers === 0) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete the last active Super Administrator.',
          code: 'CANNOT_DELETE_LAST_SUPER_ADMIN'
        });
      }
    }

    // Soft delete user and revoke all active sessions
    await prisma.adminUser.update({
      where: { id: targetUser.id },
      data: {
        deletedAt: new Date(),
        isActive: false
      }
    });

    await revokeAllSessionsFor(targetUser.id);

    await auditFromRequest(req, {
      action: AUDIT_ACTIONS.USER_DELETED,
      entityType: 'admin_user',
      entityId: targetUser.id,
      metadata: { email: targetUser.email, role: targetUser.role }
    });

    res.json({
      success: true,
      message: 'User deleted successfully.'
    });
  } catch (err) {
    next(err);
  }
}



