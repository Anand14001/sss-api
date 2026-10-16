import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalisePhone,
  isValidPhone,
  parseDate,
  calculateAgeOnContestDate,
  getEligibleCategory,
  validateRegistrationPayload
} from '../src/services/validation.js';

test('Phone normalization and validation', async (t) => {
  await t.test('strips +91, 91, leading 0, spaces, dashes', () => {
    assert.strictEqual(normalisePhone('+91 86107 11306'), '8610711306');
    assert.strictEqual(normalisePhone('918610711306'), '8610711306');
    assert.strictEqual(normalisePhone('08610711306'), '8610711306');
    assert.strictEqual(normalisePhone('86107-11306'), '8610711306');
  });

  await t.test('identifies valid Indian mobile numbers', () => {
    assert.strictEqual(isValidPhone('8610711306'), true);
    assert.strictEqual(isValidPhone('+917010713565'), true);
    assert.strictEqual(isValidPhone('12345'), false); // Too short
    assert.strictEqual(isValidPhone('abcdefghij'), false); // Letters
  });
});

test('Date of birth and age calculation on contest date (2026-11-01)', async (t) => {
  await t.test('rejects impossible dates like Feb 30', () => {
    assert.strictEqual(parseDate('2026-02-30'), null);
    assert.strictEqual(parseDate('2026-04-31'), null);
    assert.notStrictEqual(parseDate('2014-05-15'), null);
  });

  await t.test('calculates exact completed years on 2026-11-01', () => {
    // Born 2 Nov 2012 -> On 1 Nov 2026 is 13 years old (day before 14th birthday)
    const dob1 = parseDate('2012-11-02');
    assert.strictEqual(calculateAgeOnContestDate(dob1), 13);

    // Born 1 Nov 2012 -> On 1 Nov 2026 is 14 years old (14th birthday)
    const dob2 = parseDate('2012-11-01');
    assert.strictEqual(calculateAgeOnContestDate(dob2), 14);

    // Born 1 Nov 2008 -> On 1 Nov 2026 is 18 years old
    const dob3 = parseDate('2008-11-01');
    assert.strictEqual(calculateAgeOnContestDate(dob3), 18);
  });

  await t.test('maps ages to correct categories', () => {
    assert.strictEqual(getEligibleCategory(10).slug, 'kid');
    assert.strictEqual(getEligibleCategory(13).slug, 'kid');
    assert.strictEqual(getEligibleCategory(14).slug, 'teen');
    assert.strictEqual(getEligibleCategory(17).slug, 'teen');
    assert.strictEqual(getEligibleCategory(18).slug, 'adult');
    assert.strictEqual(getEligibleCategory(9), null); // under 10
  });
});

test('validateRegistrationPayload', async (t) => {
  await t.test('accepts valid registration payload for junior with parent/guardian details', () => {
    const valid = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10', // Age 12 on 2026-11-01 -> kid
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: '9876543211',
      guardianEmail: 'rajesh.sharma@example.com'
    };
    const res = validateRegistrationPayload(valid);
    assert.strictEqual(res.isValid, true);
    assert.strictEqual(Object.keys(res.errors).length, 0);
    assert.strictEqual(res.cleaned.category, 'kid');
    assert.strictEqual(res.cleaned.ageOnContest, 12);
    assert.strictEqual(res.cleaned.guardianName, 'Rajesh Sharma');
    assert.strictEqual(res.cleaned.guardianRelationship, 'Father');
    assert.strictEqual(res.cleaned.guardianPhone, '9876543211');
    assert.strictEqual(res.cleaned.guardianEmail, 'rajesh.sharma@example.com');
  });

  await t.test('accepts valid adult registration without guardian details', () => {
    const validAdult = {
      fullName: 'Suresh Kumar',
      email: 'suresh@example.com',
      phone: '9876543210',
      category: 'adult',
      dob: '1995-05-10',
      occupation: 'Working Professional',
      city: 'Salem'
    };
    const res = validateRegistrationPayload(validAdult);
    assert.strictEqual(res.isValid, true);
    assert.strictEqual(Object.keys(res.errors).length, 0);
  });

  await t.test('rejects junior registration without guardian name', () => {
    const payload = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10',
      occupation: 'Student',
      city: 'Salem',
      guardianRelationship: 'Father',
      guardianPhone: '9876543211',
      guardianEmail: 'parent@example.com'
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errors.guardianName, "Please enter the parent/guardian's full name.");
  });

  await t.test('rejects junior registration without guardian relationship', () => {
    const payload = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10',
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianPhone: '9876543211',
      guardianEmail: 'parent@example.com'
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errors.guardianRelationship, 'Please select your relationship to the participant.');
  });

  await t.test('rejects junior registration without guardian phone number', () => {
    const payload = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10',
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianEmail: 'parent@example.com'
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errors.guardianPhone, 'Please enter a valid parent/guardian contact number.');
  });

  await t.test('rejects junior registration without guardian email', () => {
    const payload = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10',
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: '9876543211'
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errors.guardianEmail, 'Please enter a valid parent/guardian email address.');
  });

  await t.test('teen registration enforces the same mandatory parent/guardian fields', () => {
    const payload = {
      fullName: 'Priya Teen',
      email: 'priya@example.com',
      phone: '9876543210',
      category: 'teen',
      dob: '2011-04-12',
      occupation: 'Student',
      city: 'Salem'
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.ok(res.errors.guardianName);
    assert.ok(res.errors.guardianRelationship);
    assert.ok(res.errors.guardianPhone);
    assert.ok(res.errors.guardianEmail);
  });

  await t.test('rejects invalid phone numbers and email addresses for guardian', () => {
    const payload = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10',
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: 'not-a-phone',
      guardianEmail: 'invalid-email'
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errors.guardianPhone, 'Please enter a valid parent/guardian contact number.');
    assert.strictEqual(res.errors.guardianEmail, 'Please enter a valid parent/guardian email address.');
  });

  await t.test('rejects whitespace-only values for guardian fields', () => {
    const payload = {
      fullName: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2014-05-10',
      occupation: 'Student',
      city: 'Salem',
      guardianName: '   ',
      guardianRelationship: '   ',
      guardianPhone: '   ',
      guardianEmail: '   '
    };
    const res = validateRegistrationPayload(payload);
    assert.strictEqual(res.isValid, false);
    assert.strictEqual(res.errors.guardianName, "Please enter the parent/guardian's full name.");
    assert.strictEqual(res.errors.guardianRelationship, 'Please select your relationship to the participant.');
    assert.strictEqual(res.errors.guardianPhone, 'Please enter a valid parent/guardian contact number.');
    assert.strictEqual(res.errors.guardianEmail, 'Please enter a valid parent/guardian email address.');
  });

  await t.test('rejects age outside category band', () => {
    const mismatch = {
      fullName: 'Vikram Seth',
      email: 'vikram@example.com',
      phone: '9876543210',
      category: 'kid', // Registered as kid
      dob: '2005-01-01', // Age 21 on 2026-11-01 -> should be adult
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: '9876543211',
      guardianEmail: 'rajesh@example.com'
    };
    const res = validateRegistrationPayload(mismatch);
    assert.strictEqual(res.isValid, false);
    assert.match(res.errors.dob, /qualifies for "Adults"/);
  });

  await t.test('rejects participant younger than 10', () => {
    const tooYoung = {
      fullName: 'Baby Doe',
      email: 'parent@example.com',
      phone: '9876543210',
      category: 'kid',
      dob: '2018-05-01', // Age 8
      occupation: 'Student',
      city: 'Salem',
      guardianName: 'Rajesh Sharma',
      guardianRelationship: 'Father',
      guardianPhone: '9876543211',
      guardianEmail: 'rajesh@example.com'
    };
    const res = validateRegistrationPayload(tooYoung);
    assert.strictEqual(res.isValid, false);
    assert.match(res.errors.dob, /at least 10 years old/);
  });

  await t.test('rejects missing or invalid required fields', () => {
    const res = validateRegistrationPayload({});
    assert.strictEqual(res.isValid, false);
    assert.ok(res.errors.fullName);
    assert.ok(res.errors.email);
    assert.ok(res.errors.phone);
    assert.ok(res.errors.category);
    assert.ok(res.errors.dob);
    assert.ok(res.errors.occupation);
    assert.ok(res.errors.city);
  });
});
