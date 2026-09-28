import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Loaded by path so the server's type-check does not pull in the web app's sources.
// A file:// URL, because a Windows path ("D:\…") is not a valid import specifier.
const WEB_CSV = pathToFileURL(resolve(import.meta.dirname, '../../../web/src/modules/treasury/csv.ts')).href;
const { guessMapping, parseCsv, parseDate, toLines } = await import(WEB_CSV);

/** The bank-statement reader lives in the web app; it is plain TypeScript, so it is tested here. */
test('reads a bank CSV with separate in/out columns, quotes and a header', () => {
  const csv = '﻿Date;Description;Ref;Debit;Credit;Balance\r\n31/01/2026;"Fee; monthly";;2.50;;997.50\r\n15/01/2026;Deposit;DEP-7;;1,000.00;1000\r\n16/01/2026;Opening balance;;;;1000\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 4);
  assert.equal(rows[1][1], 'Fee; monthly');
  const m = guessMapping(rows);
  assert.equal(m.header, true);
  assert.equal(m.amount, null);
  assert.equal(m.dateFormat, 'dmy');
  const { lines, errors } = toLines(rows, m, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, [
    { date: '2026-01-31', description: 'Fee; monthly', reference: null, amount: -250 },
    { date: '2026-01-15', description: 'Deposit', reference: 'DEP-7', amount: 100000 },
  ]);
});

test('one signed amount column, Arabic headers and digits', () => {
  const rows = parseCsv('التاريخ,البيان,المبلغ\n٢٠٢٦-٠٢-٠١,إيداع,١٥٠٠\n2026-02-03,شيك,-200.5\nbad-date,x,1\n');
  const m = guessMapping(rows);
  assert.equal(m.amount, 2);
  assert.equal(m.dateFormat, 'ymd');
  const { lines, errors } = toLines(rows, m, 2);
  assert.deepEqual(lines.map((l: { amount: number }) => l.amount), [150000, -20050]);
  assert.deepEqual(errors, [4]);
});

test('dates: impossible days are refused', () => {
  assert.equal(parseDate('31/02/2026', 'dmy'), null);
  assert.equal(parseDate('02/28/26', 'mdy'), '2026-02-28');
});
