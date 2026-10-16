/**
 * CSV generation for the dashboard's report exports.
 *
 * Two separate problems are handled here and they are often confused:
 *
 *  1. CSV quoting — a value containing a comma, quote or newline has to be
 *     wrapped and its quotes doubled, or the file parses into the wrong shape.
 *
 *  2. Spreadsheet formula injection — Excel, LibreOffice and Google Sheets
 *     evaluate any cell whose text begins with = + - @ or a tab/CR as a
 *     formula. A participant who registers under the name `=HYPERLINK(...)`
 *     would otherwise get that formula executed on the organiser's machine when
 *     they open the export. Prefixing a single quote neutralises it; the cell
 *     still reads correctly in every spreadsheet application.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';

  let str = value instanceof Date ? value.toISOString() : String(value);

  if (FORMULA_START.test(str)) {
    str = `'${str}`;
  }

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function toCsvRow(values) {
  return values.map(escapeCsvValue).join(',');
}

/**
 * Builds a complete CSV document from a column definition and a row set.
 * `columns` is [{ key, label, value? }] so the header labels and the field
 * selection live in one place per report.
 */
export function buildCsv(columns, rows) {
  const lines = [toCsvRow(columns.map((c) => c.label))];
  for (const row of rows) {
    lines.push(toCsvRow(columns.map((c) => (c.value ? c.value(row) : row[c.key]))));
  }
  // CRLF and a UTF-8 BOM: without the BOM, Excel on Windows renders ₹ and any
  // non-ASCII participant name as mojibake.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvFilename(reportId, extra = '') {
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = extra ? `-${extra.replace(/[^a-z0-9-]/gi, '')}` : '';
  return `sss-${reportId}${suffix}-${stamp}.csv`;
}
