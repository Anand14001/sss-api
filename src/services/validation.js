import { CATEGORIES, ALLOWED_OCCUPATIONS, EVENT_CONFIG } from '../config/event.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

export function normalisePhone(value = '') {
  const digits = String(value).replace(/[\s()+.-]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function isValidPhone(value = '') {
  const raw = String(value).trim();
  if (/[a-z]/i.test(raw)) return false;
  const digits = normalisePhone(raw);
  if (!/^\d+$/.test(digits)) return false;
  return INDIAN_MOBILE_REGEX.test(digits) || (digits.length >= 8 && digits.length <= 15);
}

export function parseDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() + 1 !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/**
 * Calculates completed years between participant's DOB and the contest date (2026-11-01).
 */
export function calculateAgeOnContestDate(dobDate, contestDateStr = EVENT_CONFIG.date) {
  const contestDate = new Date(`${contestDateStr}T00:00:00Z`);
  let age = contestDate.getUTCFullYear() - dobDate.getUTCFullYear();
  const monthDelta = contestDate.getUTCMonth() - dobDate.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && contestDate.getUTCDate() < dobDate.getUTCDate())) {
    age -= 1;
  }
  return age;
}

export function getEligibleCategory(age) {
  for (const cat of Object.values(CATEGORIES)) {
    if (age >= cat.minAge && age <= cat.maxAge) {
      return cat;
    }
  }
  return null;
}

export function isDeadlinePassed(deadlineStr = EVENT_CONFIG.deadline) {
  const now = new Date();
  const deadline = new Date(deadlineStr);
  return now.getTime() > deadline.getTime();
}

/**
 * Validates registration payload.
 * Returns { isValid: boolean, errors: Record<string, string>, cleanedData: object }
 */
export function validateRegistrationPayload(data = {}) {
  const errors = {};
  const cleaned = {};

  // 1. Full name
  const fullName = typeof data.fullName === 'string' ? data.fullName.trim() : '';
  if (!fullName) {
    errors.fullName = 'Full name is required.';
  } else if (fullName.length < 2 || fullName.length > 100) {
    errors.fullName = 'Full name must be between 2 and 100 characters.';
  } else {
    cleaned.fullName = fullName;
  }

  // 2. Email
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!email) {
    errors.email = 'Email address is required.';
  } else if (!EMAIL_REGEX.test(email) || email.length > 150) {
    errors.email = 'Please provide a valid email address.';
  } else {
    cleaned.email = email;
  }

  // 3. Phone
  const phone = typeof data.phone === 'string' ? data.phone.trim() : '';
  if (!phone) {
    errors.phone = 'Phone number is required.';
  } else if (!isValidPhone(phone)) {
    errors.phone = 'Please provide a valid 10-digit mobile number or international phone.';
  } else {
    cleaned.phone = normalisePhone(phone);
  }

  // 4. Category
  const categorySlug = typeof data.category === 'string' ? data.category.trim().toLowerCase() : '';
  const categoryConfig = CATEGORIES[categorySlug];
  if (!categorySlug) {
    errors.category = 'Category is required.';
  } else if (!categoryConfig) {
    errors.category = `Invalid category. Must be one of: ${Object.keys(CATEGORIES).join(', ')}.`;
  } else {
    cleaned.category = categorySlug;
  }

  // 5. Date of Birth
  const dobStr = typeof data.dob === 'string' ? data.dob.trim() : '';
  const dobDate = parseDate(dobStr);
  let age = null;

  if (!dobStr) {
    errors.dob = 'Date of birth is required.';
  } else if (!dobDate) {
    errors.dob = 'Invalid date format. Expected YYYY-MM-DD.';
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (dobDate.getTime() > today.getTime()) {
      errors.dob = 'Date of birth cannot be in the future.';
    } else {
      age = calculateAgeOnContestDate(dobDate);
      if (age < 10) {
        errors.dob = `Participant must be at least 10 years old on contest date (1 Nov 2026). Current age on contest date: ${age}.`;
      } else if (age > 100) {
        errors.dob = 'Please verify date of birth.';
      } else {
        cleaned.dob = dobStr;
        cleaned.ageOnContest = age;
      }
    }
  }

  // Category vs Age check
  if (categoryConfig && age !== null && !errors.dob) {
    if (age < categoryConfig.minAge || age > categoryConfig.maxAge) {
      const eligible = getEligibleCategory(age);
      if (eligible) {
        errors.dob = `Participant will be ${age} years old on 1 Nov 2026, which qualifies for "${eligible.name}" (${eligible.formLabel}), not "${categoryConfig.name}".`;
      } else {
        errors.dob = `Participant age (${age}) is not eligible for "${categoryConfig.name}".`;
      }
    }
  }

  // 6. Occupation
  const occupation = typeof data.occupation === 'string' ? data.occupation.trim() : '';
  if (!occupation) {
    errors.occupation = 'Occupation is required.';
  } else if (!ALLOWED_OCCUPATIONS.includes(occupation)) {
    errors.occupation = `Invalid occupation. Must be one of: ${ALLOWED_OCCUPATIONS.join(', ')}.`;
  } else {
    cleaned.occupation = occupation;
  }

  // 7. City / Town
  const city = typeof data.city === 'string' ? data.city.trim() : '';
  if (!city) {
    errors.city = 'City or town is required.';
  } else if (city.length < 2 || city.length > 100) {
    errors.city = 'City or town must be between 2 and 100 characters.';
  } else {
    cleaned.city = city;
  }

  // Optional guardian info (for minors)
  if (data.guardianName && typeof data.guardianName === 'string') {
    const gName = data.guardianName.trim();
    if (gName.length >= 2 && gName.length <= 100) {
      cleaned.guardianName = gName;
    }
  }
  if (data.guardianPhone && typeof data.guardianPhone === 'string') {
    const gPhone = data.guardianPhone.trim();
    if (isValidPhone(gPhone)) {
      cleaned.guardianPhone = normalisePhone(gPhone);
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    cleaned
  };
}
