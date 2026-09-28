import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { readCsv, readTable, readXlsx, writeXlsx } from '../modules/imports/xlsx.js';

/** Build an .xlsx in memory and send it the way the page does (base64). */
const file = (rows: (string | number | null)[][]) => writeXlsx([{ name: 'Sheet1', rows }]).toString('base64');

describe('import from Excel', () => {
  let c: TestClient;
  const count = (sql: string) => c.app.kernel.db.get<{ n: number }>(sql)!.n;

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
  });
  after(() => c.close());

  test('the reader reads back what the writer wrote, and CSV with Arabic, quotes and semicolons', () => {
    const buf = writeXlsx([{ name: 'A', rows: [['Code', 'الاسم', 'Price'], ['X-1', 'كرسي "مكتب"', 12.5], [null, 'فراغ', true]] }]);
    const sheets = readXlsx(buf);
    assert.deepEqual(sheets.get('A'), [['Code', 'الاسم', 'Price'], ['X-1', 'كرسي "مكتب"', 12.5], [null, 'فراغ', true]]);
    assert.deepEqual(readCsv('﻿code;name\n1;"a;b"\n2;"say ""hi"""\n'), [['code', 'name'], ['1', 'a;b'], ['2', 'say "hi"']]);
    // Excel on Arabic Windows saves "CSV" in Windows-1256: "الاسم" is C7 E1 C7 D3 E3.
    assert.deepEqual(readTable(Buffer.from([0x63, 0x6f, 0x64, 0x65, 0x2c, 0xc7, 0xe1, 0xc7, 0xd3, 0xe3, 0x0a])), [['code', 'الاسم']]);
  });

  test('the template downloads as a workbook with the Arabic headers', async () => {
    const res = await c.app.http.inject({ method: 'GET', url: '/api/imports/template/items?lang=ar', headers: { cookie: c.cookie } });
    assert.equal(res.statusCode, 200);
    const rows = readXlsx(res.rawPayload).get('items')!;
    assert.equal(rows[0][0], 'الكود *');
  });

  test('accounts: parents after their children, Arabic headers, a bad row stops the whole file', async () => {
    const rows = [
      ['الكود', 'الاسم بالإنجليزي', 'الاسم بالعربي', 'النوع', 'النوع الفرعي', 'كود الحساب الأب', 'تجميعي (نعم/لا)'],
      ['1125', 'Bank Misr', 'بنك مصر', 'asset', 'bank', '1180', 'لا'],
      ['1180', 'Banks', 'البنوك', 'asset', 'bank', '11', 'نعم'],
      ['1110', 'Cash', 'النقدية', 'asset', 'cash', '11', 'no'],
      ['9999', 'Odd', 'غريب', 'planet', 'bank', '', ''],
    ];
    const preview = await c.post('/api/imports/preview', { dataset: 'accounts', file: file(rows) });
    assert.deepEqual(preview.counts, { new: 2, exists: 1, errors: 1 });
    assert.equal(preview.rows[3].error.code, 'import.not_enum');
    assert.equal(count("SELECT COUNT(*) n FROM accounts WHERE code IN ('1125', '1180')"), 0, 'the preview leaves nothing behind');
    const refused = await c.raw('POST', '/api/imports/commit', { dataset: 'accounts', file: file(rows) });
    assert.equal(refused.body.error.code, 'import.has_errors');
    assert.equal(count("SELECT COUNT(*) n FROM accounts WHERE code IN ('1125', '1180')"), 0);
    const done = await c.post('/api/imports/commit', { dataset: 'accounts', file: file(rows.slice(0, 4)) });
    assert.equal(done.committed, true);
    const child = c.app.kernel.db.get<{ parent: string }>("SELECT p.code parent FROM accounts a JOIN accounts p ON p.id = a.parent_id WHERE a.code = '1125'");
    assert.equal(child!.parent, '1180');
  });

  test('parties and items: money in pounds, Arabic digits, duplicates skipped', async () => {
    const parties = [
      ['Kind', 'Code', 'Name', 'Credit limit', 'Payment terms (days)'],
      ['customer', 'C-100', 'Nile Hotels', '٥٠٬٠٠٠', 30],
      ['supplier', 'S-100', 'Delta Paper', null, null],
      ['customer', 'C-100', 'Nile Hotels again', null, null],
    ];
    const p = await c.post('/api/imports/commit', { dataset: 'parties', file: file(parties) });
    assert.deepEqual(p.counts, { new: 2, exists: 1, errors: 0 });
    assert.equal(c.app.kernel.db.get<{ credit_limit: number }>("SELECT credit_limit FROM parties WHERE code = 'C-100'")!.credit_limit, 5_000_000);
    const items = [
      ['SKU', 'Name (English)', 'Name (Arabic)', 'Kind', 'Sale price'],
      ['CH-1', 'Chair', 'كرسي', 'product', 1500.5],
      ['SV-1', 'Delivery', 'توصيل', 'service', 50],
      ['CH-2', 'Desk', 'مكتب', 'product', 'abc'],
    ];
    const bad = await c.post('/api/imports/preview', { dataset: 'items', file: file(items) });
    assert.equal(bad.rows[2].status, 'error');
    const i = await c.post('/api/imports/commit', { dataset: 'items', file: file(items.slice(0, 3)) });
    assert.equal(i.counts.new, 2);
    const chair = c.app.kernel.db.get<{ sale_price: number; track_stock: number }>("SELECT sale_price, track_stock FROM items WHERE sku = 'CH-1'")!;
    assert.deepEqual([chair.sale_price, chair.track_stock], [150_050, 1]);
    assert.equal(c.app.kernel.db.get<{ track_stock: number }>("SELECT track_stock FROM items WHERE sku = 'SV-1'")!.track_stock, 0, 'a service tracks no stock');
  });

  test('opening balances post one balanced entry, with customers on the receivable line', async () => {
    const header = ['Account code', 'Customer / supplier code', 'Debit', 'Credit'];
    const unbalanced = await c.post('/api/imports/preview', { dataset: 'opening', date: '2026-01-01', file: file([header, ['1120', null, 1000, null], ['3100', null, null, 900]]) });
    assert.deepEqual(unbalanced.problem.details, { debit: '1000.00', credit: '900.00', difference: '100.00' });
    const noParty = await c.post('/api/imports/preview', { dataset: 'opening', date: '2026-01-01', file: file([header, ['1130', null, 1000, null], ['3100', null, null, 1000]]) });
    assert.equal(noParty.rows[0].error.code, 'import.party_needed');
    const ok = await c.post('/api/imports/commit', {
      dataset: 'opening',
      date: '2026-01-01',
      file: file([header, ['1120', null, 250_000, null], ['1130', 'C-100', 20_000, null], ['2110', 'S-100', null, 30_000], ['3100', null, null, 240_000]]),
    });
    assert.equal(ok.committed, true);
    const tb = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    const bank = await acc(c, '1120');
    const row = tb.rows.find((r: any) => r.id === bank);
    assert.equal(row.closing_debit, 25_000_000);
    const again = await c.raw('POST', '/api/imports/commit', { dataset: 'opening', date: '2026-01-01', file: file([header, ['1120', null, 1, null], ['3100', null, null, 1]]) });
    assert.equal(again.body.error.code, 'import.opening_exists', 'opening balances are not imported twice');
    const e = c.app.kernel.db.get<{ source_type: string; status: string }>("SELECT source_type, status FROM journal_entries WHERE reference = 'OPENING'")!;
    assert.deepEqual({ ...e }, { source_type: 'opening', status: 'posted' });
  });

  test('a file without the needed columns, and a user without rights', async () => {
    const r = await c.raw('POST', '/api/imports/preview', { dataset: 'items', file: file([['Foo', 'Bar'], ['1', '2']]) });
    assert.equal(r.body.error.code, 'import.missing_columns');
    const junk = await c.raw('POST', '/api/imports/preview', { dataset: 'items', file: Buffer.from('PK\u0003\u0004garbage').toString('base64') });
    assert.equal(junk.body.error.code, 'import.bad_file');
    await c.post('/api/users', { username: 'viewer2', displayName: 'Viewer', password: 'password123', role: 'viewer' });
    const cookie = await c.login('viewer2', 'password123');
    const denied = await c.raw('POST', '/api/imports/preview', { dataset: 'items', file: file([['SKU'], ['X']]) }, cookie);
    assert.equal(denied.status, 403);
  });
});
