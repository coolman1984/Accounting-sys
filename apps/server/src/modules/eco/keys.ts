import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../../kernel/db.js';
import { AppError, conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';

/**
 * Machine keys: how another application (GMES, HR-System, a link) calls /eco/v1/*.
 * Only a SHA-256 of a key is stored; the key itself is shown once, when it is created.
 * Keys never open /api/* — people use their own sign-in there.
 */
export const ECO_SCOPES = ['eco.feed.read', 'eco.inbox.write', 'eco.acks.write', 'eco.events.read'] as const;
export type EcoScope = (typeof ECO_SCOPES)[number];

export interface EcoKeyRow {
  id: number;
  name: string;
  scopes: string;
  active: number;
  created_at: string;
  revoked_at: string | null;
}

export interface Caller {
  id: number;
  name: string;
  scopes: Set<string>;
}

const PREFIX = 'mk_';
const hash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

export function newKey(): string {
  return PREFIX + randomBytes(24).toString('base64url');
}

const NAME = /^[A-Za-z0-9._-]{3,60}$/;

/** Create a key; returns the key text (the only time it exists outside the caller's hands). */
export function createKey(db: Database, input: { name: string; scopes: string[] }, userId: number | null): { id: number; name: string; key: string } {
  const name = input.name.trim();
  if (!NAME.test(name)) fail('eco.key_name', 'Key name: 3 to 60 letters, digits, dot, dash or underscore');
  const scopes = [...new Set(input.scopes)];
  if (!scopes.length) fail('eco.key_scopes', 'Choose at least one scope');
  for (const s of scopes) if (s !== 'eco.*' && !(ECO_SCOPES as readonly string[]).includes(s)) fail('eco.key_scope', `Unknown scope ${s}`, { scope: s });
  if (db.get('SELECT 1 FROM eco_keys WHERE name = ?', [name])) conflict('eco.key_name_taken', `A key named ${name} exists; keys are never renamed or reused`, { name });
  const key = newKey();
  const id = db.insert('eco_keys', { name, key_hash: hash(key), scopes: scopes.join(' '), active: 1, created_by: userId, created_at: nowIso() });
  return { id, name, key };
}

export function revokeKey(db: Database, id: number): EcoKeyRow {
  const k = db.get<EcoKeyRow>('SELECT id, name, scopes, active, created_at, revoked_at FROM eco_keys WHERE id = ?', [id]) ?? notFound('eco_key', id);
  if (!k.active) conflict('eco.key_revoked', `Key ${k.name} is already revoked`);
  db.run('UPDATE eco_keys SET active = 0, revoked_at = ? WHERE id = ?', [nowIso(), id]);
  return k;
}

export function listKeys(db: Database) {
  return db
    .all<EcoKeyRow>('SELECT id, name, scopes, active, created_at, revoked_at FROM eco_keys ORDER BY active DESC, name')
    .map((k) => ({ ...k, scopes: k.scopes.split(' ') }));
}

/** The caller behind an x-eco-key header, or null (missing, unknown or revoked). */
export function authenticate(db: Database, header: string | string[] | undefined): Caller | null {
  if (typeof header !== 'string' || !header.startsWith(PREFIX) || header.length > 200) return null;
  const h = hash(header);
  const row = db.get<{ id: number; name: string; key_hash: string; scopes: string; active: number }>('SELECT id, name, key_hash, scopes, active FROM eco_keys WHERE key_hash = ?', [h]);
  if (!row || !row.active || !timingSafeEqual(Buffer.from(row.key_hash), Buffer.from(h))) return null;
  return { id: row.id, name: row.name, scopes: new Set(row.scopes.split(' ')) };
}

/** 401 without a valid key, 403 when the key lacks the scope. */
export function requireScope(caller: Caller | null, scope: EcoScope): Caller {
  if (!caller) throw new AppError('auth.required', 'Send a valid x-eco-key header', 401);
  if (!caller.scopes.has(scope) && !caller.scopes.has('eco.*')) throw new AppError('auth.forbidden', `This key may not use ${scope}`, 403, { scope });
  return caller;
}
