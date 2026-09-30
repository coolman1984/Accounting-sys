import { DatabaseSync } from 'node:sqlite';

/**
 * A backup is not a backup until it has been opened (plan 50 WP-X3, the same rule as GMES and HR): the copy is opened READ-ONLY,
 * SQLite checks its structure, no table points at a missing row, every posted journal entry balances, and the main tables
 * are counted (so a later verification can tell that nothing was lost). It never touches the live database.
 */

export interface Rehearsal {
  ok: boolean;
  checks: { integrity: boolean; foreignKeys: boolean; balanced: boolean };
  tables: Record<string, number>;
  problems: string[];
}

const MAIN_TABLES = ['accounts', 'journal_entries', 'journal_lines', 'documents', 'items', 'parties', 'users'];

export function rehearse(file: string): Rehearsal {
  const problems: string[] = [];
  let raw: DatabaseSync | null = null;
  try {
    raw = new DatabaseSync(file, { readOnly: true });
    const integrity = raw.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const integrityOk = integrity.length === 1 && integrity[0]!.integrity_check === 'ok';
    if (!integrityOk) problems.push(`the database is damaged: ${integrity.slice(0, 3).map((r) => r.integrity_check).join('; ')}`);
    const broken = raw.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) problems.push(`${broken.length} row(s) point at something that is not there`);
    const present = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const tables: Record<string, number> = {};
    for (const t of MAIN_TABLES) if (present.has(t)) tables[t] = Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    let balanced = true;
    if (present.has('journal_entries') && present.has('journal_lines')) {
      const unbalanced = raw
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'posted'
                                      GROUP BY e.id HAVING SUM(l.debit) <> SUM(l.credit))`,
        )
        .get() as { n: number };
      balanced = Number(unbalanced.n) === 0;
      if (!balanced) problems.push(`${unbalanced.n} posted journal entr${Number(unbalanced.n) === 1 ? 'y does' : 'ies do'} not balance`);
    }
    if (Object.keys(tables).length === 0) problems.push('none of the main tables is in this file: it is not a Mizan database');
    return { ok: problems.length === 0, checks: { integrity: integrityOk, foreignKeys: broken.length === 0, balanced }, tables, problems };
  } catch (e) {
    problems.push(`the file could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, checks: { integrity: false, foreignKeys: false, balanced: false }, tables: {}, problems };
  } finally {
    raw?.close();
  }
}
