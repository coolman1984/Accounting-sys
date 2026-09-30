import type { Database } from '../../kernel/db.js';
import { fail } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';

export interface CompanySettings {
  name: string;
  legalName: string | null;
  taxNumber: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  /** ISO 4217 code, e.g. EGP, SAR, USD. */
  baseCurrency: string;
  /** Decimal places of the base currency's minor unit (2 for EGP/USD, 3 for KWD). */
  moneyScale: number;
}

export interface SettingsService {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  company(): CompanySettings;
  isSetupComplete(): boolean;
  /** Posting on or before this date is blocked (null = no lock). */
  lockDate(): string | null;
}

export function createSettings(db: Database): SettingsService {
  const get = <T>(key: string, fallback: T): T => {
    const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? (JSON.parse(row.value) as T) : fallback;
  };
  return {
    get,
    set(key, value) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        key,
        JSON.stringify(value),
      ]);
    },
    company() {
      const c = get<CompanySettings | null>('company', null);
      if (!c) fail('setup.required', 'Company is not set up yet');
      return c as CompanySettings;
    },
    isSetupComplete: () => get('setupComplete', false),
    lockDate: () => get<string | null>('lockDate', null),
  };
}

export interface SequenceService {
  /** Make sure a sequence exists (no-op if it does). */
  ensure(key: string, prefix: string, padding?: number): void;
  /** Reserve and format the next number. Must be called inside a transaction. */
  next(key: string): string;
  list(): { key: string; prefix: string; next_value: number; padding: number }[];
  update(key: string, data: { prefix?: string; next_value?: number; padding?: number }): void;
}

export function createSequences(db: Database): SequenceService {
  return {
    ensure(key, prefix, padding = 5) {
      db.run('INSERT OR IGNORE INTO sequences (key, prefix, next_value, padding) VALUES (?, ?, 1, ?)', [key, prefix, padding]);
    },
    next(key) {
      const row = db.get<{ prefix: string; next_value: number; padding: number }>(
        'UPDATE sequences SET next_value = next_value + 1 WHERE key = ? RETURNING prefix, next_value - 1 AS next_value, padding',
        [key],
      );
      if (!row) return fail('sequence.missing', `Sequence ${key} is not defined`);
      return row.prefix + String(row.next_value).padStart(row.padding, '0');
    },
    list: () => db.all('SELECT key, prefix, next_value, padding FROM sequences ORDER BY key'),
    update(key, data) {
      const cur = db.get<{ prefix: string; next_value: number; padding: number }>('SELECT * FROM sequences WHERE key = ?', [key]);
      if (!cur) return fail('sequence.missing', `Sequence ${key} is not defined`);
      if (data.next_value !== undefined && data.next_value < cur.next_value) {
        fail('sequence.backwards', 'A sequence can only move forward (numbers must never repeat)');
      }
      db.run('UPDATE sequences SET prefix = ?, next_value = ?, padding = ? WHERE key = ?', [
        data.prefix ?? cur.prefix,
        data.next_value ?? cur.next_value,
        data.padding ?? cur.padding,
        key,
      ]);
    },
  };
}

export interface AuditEntry {
  userId: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  summary?: string | null;
  data?: unknown;
}

export interface AuditService {
  log(e: AuditEntry): void;
}

export function createAudit(db: Database): AuditService {
  return {
    log(e) {
      db.insert('audit_log', {
        at: nowIso(),
        user_id: e.userId,
        action: e.action,
        entity: e.entity,
        entity_id: e.entityId ?? null,
        summary: e.summary ?? null,
        data: e.data === undefined ? null : JSON.stringify(e.data),
      });
    },
  };
}
