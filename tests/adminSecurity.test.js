import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  isLockedOut
} from '../src/services/adminAuth.js';
import { escapeCsvValue, buildCsv, csvFilename } from '../src/services/csv.js';
import { sanitiseMetadata } from '../src/services/audit.js';

/**
 * Pure unit tests for the administration security primitives.
 *
 * Deliberately no database: these cover the logic that must hold whatever the
 * data looks like, so they run anywhere and cannot touch live records.
 */

test('Administrator password hashing', async (t) => {
  await t.test('verifies a correct password', async () => {
    const hash = await hashPassword('CorrectHorse@2026');
    assert.strictEqual(await verifyPassword('CorrectHorse@2026', hash), true);
  });

  await t.test('rejects an incorrect password', async () => {
    const hash = await hashPassword('CorrectHorse@2026');
    assert.strictEqual(await verifyPassword('correcthorse@2026', hash), false);
    assert.strictEqual(await verifyPassword('', hash), false);
    assert.strictEqual(await verifyPassword('CorrectHorse@2027', hash), false);
  });

  await t.test('never stores the password in the hash string', async () => {
    const password = 'VerySecret@2026';
    const hash = await hashPassword(password);
    assert.ok(!hash.includes(password), 'hash must not contain the plaintext');
  });

  await t.test('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('SamePassword@2026');
    const b = await hashPassword('SamePassword@2026');
    assert.notStrictEqual(a, b, 'two hashes of one password must differ');
    assert.strictEqual(await verifyPassword('SamePassword@2026', a), true);
    assert.strictEqual(await verifyPassword('SamePassword@2026', b), true);
  });

  await t.test('records its parameters so they can be raised later', async () => {
    const hash = await hashPassword('Parameterised@2026');
    const [algorithm, N, r, p] = hash.split('$');
    assert.strictEqual(algorithm, 'scrypt');
    assert.strictEqual(Number(N), 32768);
    assert.strictEqual(Number(r), 8);
    assert.strictEqual(Number(p), 1);
  });

  await t.test('treats a malformed or empty stored hash as a failure, not a crash', async () => {
    assert.strictEqual(await verifyPassword('anything', ''), false);
    assert.strictEqual(await verifyPassword('anything', 'not-a-hash'), false);
    assert.strictEqual(await verifyPassword('anything', 'scrypt$1$2$3'), false);
    assert.strictEqual(await verifyPassword('anything', null), false);
    assert.strictEqual(await verifyPassword('anything', undefined), false);
  });
});

test('Password policy', async (t) => {
  await t.test('accepts a password meeting every rule', () => {
    assert.deepStrictEqual(validatePassword('SalemStar@2026!'), []);
  });

  await t.test('reports each missing requirement', () => {
    assert.ok(validatePassword('short1A!').includes('At least 10 characters'));
    assert.ok(validatePassword('alllowercase1!').includes('An uppercase letter'));
    assert.ok(validatePassword('ALLUPPERCASE1!').includes('A lowercase letter'));
    assert.ok(validatePassword('NoDigitsHere!').includes('A number'));
    assert.ok(validatePassword('NoSymbols12345').includes('A symbol'));
  });

  await t.test('relaxes only the length floor for the one-time bootstrap password', () => {
    // The organisers asked for Admin@123. It is accepted for provisioning, where
    // it is replaced at first sign-in, and refused as a chosen password.
    assert.deepStrictEqual(validatePassword('Admin@123', { bootstrap: true }), []);
    assert.deepStrictEqual(validatePassword('Admin@123'), ['At least 10 characters']);
  });

  await t.test('still enforces character classes on a bootstrap password', () => {
    assert.ok(validatePassword('adminadmin', { bootstrap: true }).length > 0);
    assert.ok(validatePassword('Admin123', { bootstrap: true }).includes('A symbol'));
  });

  await t.test('rejects a non-string', () => {
    assert.deepStrictEqual(validatePassword(null), ['Password must be text.']);
    assert.deepStrictEqual(validatePassword(12345678910), ['Password must be text.']);
  });
});

test('Account lockout', async (t) => {
  await t.test('treats a future lock expiry as locked', () => {
    assert.strictEqual(isLockedOut({ lockedUntil: new Date(Date.now() + 60_000) }), true);
  });

  await t.test('treats a past lock expiry as unlocked', () => {
    assert.strictEqual(isLockedOut({ lockedUntil: new Date(Date.now() - 60_000) }), false);
  });

  await t.test('treats no lock as unlocked', () => {
    assert.strictEqual(isLockedOut({ lockedUntil: null }), false);
    assert.strictEqual(isLockedOut(null), false);
  });
});

test('CSV export safety', async (t) => {
  await t.test('neutralises spreadsheet formula injection', () => {
    // A participant registering as =HYPERLINK(...) must not have that formula
    // executed when an organiser opens the export.
    // Prefixed first, then CSV-quoted because the value also contains quotes.
    assert.strictEqual(
      escapeCsvValue('=HYPERLINK("http://evil","click")'),
      '"\'=HYPERLINK(""http://evil"",""click"")"'
    );
    assert.strictEqual(escapeCsvValue('+1234'), "'+1234");
    assert.strictEqual(escapeCsvValue('-1234'), "'-1234");
    assert.strictEqual(escapeCsvValue('@SUM(A1)'), "'@SUM(A1)");
    assert.strictEqual(escapeCsvValue('\tTabbed'), "'\tTabbed");
  });

  await t.test('leaves ordinary values untouched', () => {
    assert.strictEqual(escapeCsvValue('Meera Krishnan'), 'Meera Krishnan');
    assert.strictEqual(escapeCsvValue('99.00'), '99.00');
    assert.strictEqual(escapeCsvValue('SSS-2026-X8K2M9'), 'SSS-2026-X8K2M9');
  });

  await t.test('quotes and escapes separators, quotes and newlines', () => {
    assert.strictEqual(escapeCsvValue('Krishnan, Meera'), '"Krishnan, Meera"');
    assert.strictEqual(escapeCsvValue('She said "hello"'), '"She said ""hello"""');
    assert.strictEqual(escapeCsvValue('line one\nline two'), '"line one\nline two"');
  });

  await t.test('renders null and undefined as empty, not as the words', () => {
    assert.strictEqual(escapeCsvValue(null), '');
    assert.strictEqual(escapeCsvValue(undefined), '');
  });

  await t.test('a formula-shaped value that also needs quoting gets both', () => {
    const result = escapeCsvValue('=CONCAT(A1,", ",B1)');
    assert.ok(result.startsWith('"\'='), `expected quoted and prefixed, got ${result}`);
  });

  await t.test('builds a document with a BOM, header row and CRLF endings', () => {
    const csv = buildCsv(
      [
        { label: 'Reference', value: (r) => r.reference },
        { label: 'Name', value: (r) => r.name }
      ],
      [
        { reference: 'SSS-2026-AAA111', name: 'Ananya S' },
        { reference: 'SSS-2026-BBB222', name: '=cmd|calc' }
      ]
    );

    assert.ok(csv.startsWith('﻿'), 'Excel on Windows needs the BOM to read ₹ and Indian names');
    const lines = csv.split('\r\n');
    assert.strictEqual(lines[0], '﻿Reference,Name');
    assert.strictEqual(lines[1], 'SSS-2026-AAA111,Ananya S');
    assert.strictEqual(lines[2], "SSS-2026-BBB222,'=cmd|calc");
  });

  await t.test('names the file safely, stripping anything path-like', () => {
    assert.match(csvFilename('registrations'), /^sss-registrations-\d{4}-\d{2}-\d{2}\.csv$/);
    const injected = csvFilename('registrations', '../../etc/passwd');
    assert.ok(!injected.includes('/'), 'no path separators may survive');
    assert.ok(!injected.includes('..'), 'no traversal may survive');
  });
});

test('Audit metadata redaction', async (t) => {
  await t.test('redacts anything credential-shaped by key name', () => {
    const result = sanitiseMetadata({
      password: 'Admin@123',
      razorpaySignature: 'abc123',
      apiKey: 'rzp_live_xyz',
      sessionToken: 'opaque',
      authorization: 'Bearer x',
      reference: 'SSS-2026-X8K2M9'
    });

    assert.strictEqual(result.password, '[redacted]');
    assert.strictEqual(result.razorpaySignature, '[redacted]');
    assert.strictEqual(result.apiKey, '[redacted]');
    assert.strictEqual(result.sessionToken, '[redacted]');
    assert.strictEqual(result.authorization, '[redacted]');
    // Non-sensitive context survives — a log of nothing is no use either.
    assert.strictEqual(result.reference, 'SSS-2026-X8K2M9');
  });

  await t.test('redacts nested secrets too', () => {
    const result = sanitiseMetadata({ outer: { inner: { secretKey: 'nope', count: 3 } } });
    assert.strictEqual(result.outer.inner.secretKey, '[redacted]');
    assert.strictEqual(result.outer.inner.count, 3);
  });

  await t.test('truncates long strings and deep nesting rather than storing them', () => {
    assert.strictEqual(sanitiseMetadata('x'.repeat(5000)).length, 500);
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    assert.strictEqual(sanitiseMetadata(deep).a.b.c.d.e, '[truncated]');
  });

  await t.test('passes through null and numbers unchanged', () => {
    assert.strictEqual(sanitiseMetadata(null), null);
    assert.strictEqual(sanitiseMetadata(42), 42);
    assert.strictEqual(sanitiseMetadata(true), true);
  });
});
