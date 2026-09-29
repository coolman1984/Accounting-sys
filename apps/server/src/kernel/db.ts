import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined;
export type Params = SqlParam[] | Record<string, SqlParam>;

/**
 * Thin, synchronous wrapper around SQLite.
 *
 * Everything the rest of the system knows about the database goes through this
 * class, so the storage engine can be swapped without touching any module.
 * Writes are synchronous on purpose: a transaction can never be interleaved
 * with another request, which keeps the ledger consistent when many PCs on the
 * network post at the same time.
 */
export class Database {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private pending: (() => void)[] = [];

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, params: Params = []): T | undefined {
    return this.call(sql, params, 'get') as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    return this.call(sql, params, 'all') as T[];
  }

  run(sql: string, params: Params = []): { changes: number; lastId: number } {
    const r = this.call(sql, params, 'run') as { changes: number | bigint; lastInsertRowid: number | bigint };
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /** Insert a row from a plain object and return the new id. */
  insert(table: string, row: Record<string, SqlParam>): number {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => ':' + k).join(', ')})`;
    return this.run(sql, row).lastId;
  }

  /** Update a row by id from a plain object (undefined keys are skipped). */
  update(table: string, id: number, row: Record<string, SqlParam>): number {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    if (keys.length === 0) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`;
    const params: Record<string, SqlParam> = { __id: id };
    for (const k of keys) params[k] = row[k];
    return this.run(sql, params).changes;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Run `fn` atomically. Nested calls become savepoints, so services can call
   * each other freely and still commit or roll back as one unit.
   */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const sp = `sp_${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Database.tx callbacks must be synchronous');
      // Work queued with beforeCommit runs last, still inside the transaction (it may queue more).
      if (outer) while (this.pending.length) for (const f of this.pending.splice(0)) f();
      this.depth--;
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      if (outer) this.pending = [];
      this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Run `fn` at the end of the current transaction, just before COMMIT and inside it (so a failure
   * still rolls everything back). Outside a transaction it runs at once. Used to write one derived
   * record per change, e.g. the integration outbox after several stock moves of one operation.
   */
  beforeCommit(fn: () => void): void {
    if (this.depth === 0) fn();
    else if (!this.pending.includes(fn)) this.pending.push(fn);
  }

  /** Consistent point-in-time copy of the whole database. */
  backupTo(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    this.raw.prepare('VACUUM INTO ?').run(file);
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }

  private call(sql: string, params: Params, mode: 'get' | 'all' | 'run'): unknown {
    const s = this.stmt(sql);
    if (Array.isArray(params)) {
      const p = params.map(normalize);
      return mode === 'get' ? s.get(...p) : mode === 'all' ? s.all(...p) : s.run(...p);
    }
    const p: Record<string, SqlValue> = {};
    for (const [k, v] of Object.entries(params)) p[k] = normalize(v);
    return mode === 'get' ? s.get(p) : mode === 'all' ? s.all(p) : s.run(p);
  }
}

function normalize(v: SqlParam): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
