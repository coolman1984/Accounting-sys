import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { modules } from '../modules/index.js';
import { rehearse } from '../modules/system/rehearsal.js';

/** A backup is only a backup once it has been opened elsewhere and checked (plan 50 WP-X3). */
describe('backup rehearsal', () => {
  let dir: string, app: App, cookie: string, backupName: string;
  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.http.inject({ method: method as 'GET', url, payload, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mizan-backup-'));
    app = await buildApp(loadConfig({ dbFile: ':memory:', dataDir: dir, logLevel: 'silent', webDir: null }), modules);
    const setup = await app.http.inject({ method: 'POST', url: '/api/setup', payload: {
      company: { name: 'Backup Co', baseCurrency: 'EGP', moneyScale: 2 }, fiscalYearStart: '2026-01-01',
      admin: { username: 'admin', displayName: 'Admin', password: 'password123' }, locale: 'en', seedChartOfAccounts: true, vatRateBp: 1400 } });
    assert.equal(setup.statusCode, 200);
    const login = await app.http.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'password123' } });
    cookie = `mizan_sid=${login.cookies.find((c) => c.name === 'mizan_sid')!.value}`;
  });
  after(async () => {
    await app.http.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a new backup is rehearsed: structure, references, balanced journals, and what it holds', async () => {
    const made = await call('POST', '/api/system/backups');
    assert.equal(made.status, 200);
    backupName = made.body.name;
    assert.equal(made.body.rehearsal.ok, true, JSON.stringify(made.body.rehearsal));
    assert.deepEqual(made.body.rehearsal.checks, { integrity: true, foreignKeys: true, balanced: true });
    assert.ok(made.body.rehearsal.tables.accounts > 10, 'the chart of accounts is in the copy');
    assert.equal(made.body.rehearsal.tables.users, 1);
    const again = await call('POST', `/api/system/backups/${made.body.name}/verify`);
    assert.equal(again.body.rehearsal.ok, true);
    assert.deepEqual(again.body.rehearsal.tables, made.body.rehearsal.tables);
    assert.equal((await call('POST', '/api/system/backups/not-a-backup.db/verify')).status, 404);
  });

  test('a damaged file, a file that is not a Mizan database and a missing file all fail, saying why', () => {
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not a database at all, only some text '.repeat(200));
    const r1 = rehearse(junk);
    assert.equal(r1.ok, false);
    assert.match(r1.problems.join(' '), /could not be opened|damaged/);
    const empty = join(dir, 'empty.db');
    const e = new DatabaseSync(empty);
    e.exec('CREATE TABLE something (x INTEGER)');
    e.close();
    const r2 = rehearse(empty);
    assert.equal(r2.ok, false);
    assert.match(r2.problems.join(' '), /not a Mizan database/);
    assert.equal(rehearse(join(dir, 'missing.db')).ok, false);
  });

  test('a copy whose pages are damaged opens but fails the structure check', () => {
    const damaged = join(dir, 'damaged.db');
    copyFileSync(join(dir, 'backups', backupName), damaged);
    const bytes = readFileSync(damaged);
    // overwrite the middle of the file (table pages) with 0xFF: the header still reads, the content does not
    bytes.fill(0xff, Math.floor(bytes.length / 3), Math.floor(bytes.length / 3) + 16384);
    writeFileSync(damaged, bytes);
    const r = rehearse(damaged);
    assert.equal(r.ok, false);
    assert.equal(r.checks.integrity, false);
  });

  test('a journal entry that does not balance, written into a copy, fails the rehearsal', async () => {
    const source = join(dir, 'backups', backupName);
    assert.ok(existsSync(source));
    const tampered = join(dir, 'tampered.db');
    copyFileSync(source, tampered);
    const raw = new DatabaseSync(tampered);
    for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) raw.exec(`DROP TRIGGER "${t.name}"`);
    const account = (raw.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id;
    raw.exec(`INSERT INTO journal_entries (id, date, status, total, created_at, updated_at) VALUES (9001, '2026-03-01', 'posted', 100, 'x', 'x')`);
    raw.exec(`INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit) VALUES (9001, 1, ${account}, 100, 0)`);
    raw.close();
    const r = rehearse(tampered);
    assert.equal(r.ok, false);
    assert.equal(r.checks.balanced, false);
    assert.match(r.problems.join(' '), /1 posted journal entry does not balance/);
    assert.equal(r.checks.integrity, true, 'the file itself is sound: only the books are wrong');
  });
});
