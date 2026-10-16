/**
 * Authoritative Server-side Event and Category Configuration.
 * 
 * Single source of truth for the Salem Star Speaker backend.
 * Fees are defined in integer paise for Razorpay:
 * - Junior (10–13 years) [kid]: ₹250 (25,000 paise)
 * - Teens (14–17 years) [teen]: ₹250 (25,000 paise)
 * - Adults (18+) [adult]: ₹250 (25,000 paise)
 */

export const WHATSAPP_GROUP_INVITE_URL = 'https://chat.whatsapp.com/Jbsi0DQ7xFRDyi5ylydf15?s=sw&p=a&mlu=4&ilr=4';

export const EVENT_CONFIG = {
  id: 'sss-2026',
  name: 'Salem Star Speaker — The Speaking Contest',
  shortName: 'Salem Star Speaker',
  date: '2026-11-01',
  dateDisplay: 'Sunday, 1 November 2026',
  deadline: '2026-10-26T23:59:59+05:30',
  deadlineDisplay: '26 October 2026',
  venue: {
    name: 'Hotel A Square Rivera',
    city: 'Salem',
    note: 'Exact hall and reporting time will be shared with registered participants.'
  },
  organisers: [
    { name: 'Salem Parenting Club', role: 'Presented by' },
    { name: 'Speak Up Salem Toastmasters Club', role: 'In association with' }
  ],
  contacts: [
    { name: 'Vivek', phone: '86107 11306', tel: '+918610711306' },
    { name: 'Tharu', phone: '7010713565', tel: '+917010713565' }
  ],
  prizes: 'Top 3 winners in each category',
  prelims: 'Preliminary rounds may be conducted depending on participant numbers.',
  whatsappGroupInviteUrl: WHATSAPP_GROUP_INVITE_URL
};

export const CATEGORIES = {
  kid: {
    slug: 'kid',
    name: 'Kids',
    formLabel: 'Junior (10-13 years)',
    minAge: 10,
    maxAge: 13,
    feePaise: 25000,
    feeRupees: 250,
    currency: 'INR'
  },
  teen: {
    slug: 'teen',
    name: 'Teens',
    formLabel: 'Teens (14-17 years)',
    minAge: 14,
    maxAge: 17,
    feePaise: 25000,
    feeRupees: 250,
    currency: 'INR'
  },
  adult: {
    slug: 'adult',
    name: 'Adults',
    formLabel: 'Adults (18+)',
    minAge: 18,
    maxAge: 99,
    feePaise: 25000,
    feeRupees: 250,
    currency: 'INR'
  }
};

export const ALLOWED_OCCUPATIONS = [
  'Student',
  'Working Professional',
  'Business Owner',
  'Home Maker',
  'Others'
];

export const ALLOWED_GUARDIAN_RELATIONSHIPS = [
  'Mother',
  'Father',
  'Legal Guardian',
  'Other'
];

