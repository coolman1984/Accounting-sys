import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '../../kernel/db.js';
import { AppError, fail } from '../../kernel/errors.js';
import type { SessionUser } from '../../kernel/modules.js';
import type { AppRegistry } from '../../kernel/apps.js';

/** Built-in roles, kept in the roles table with a rule instead of a list. */
export const BUILTIN_ROLES = ['admin', 'accountant', 'viewer'] as const;
export type RoleRule = 'all' | 'all_but_admin' | 'read_only';

/** Permissions only administrators get from the built-in rules. */
export const ADMIN_ONLY = new Set(['admin.users.manage', 'admin.settings.manage', 'admin.backup.manage', 'pricing.minprice.override']);

export function permissionsForRule(rule: RoleRule, all: readonly string[]): string[] {
  if (rule === 'all') return [...all];
  if (rule === 'all_but_admin') return all.filter((p) => !ADMIN_ONLY.has(p));
  return all.filter((p) => p.endsWith('.read'));
}

/** Expand "ar.*" / "ar.invoices.*" against the known permissions; unknown keys are dropped. */
export function expandPermissions(patterns: readonly string[], all: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -1);
      for (const k of all) if (k.startsWith(prefix)) out.add(k);
    } else if (all.includes(p)) out.add(p);
  }
  return [...out].sort();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  locale: string;
  is_active: number;
}

export interface AccessService {
  login(username: string, password: string, meta: { ip?: string; userAgent?: string }): { token: string; user: SessionUser };
  logout(token: string): void;
  authenticate(token: string | undefined): SessionUser | null;
  can(user: SessionUser, permission: string): boolean;
  /** Drop every session of a user (password change, deactivation). */
  revokeAll(userId: number): void;
  /** Permission check by user id (for code that only knows who acted, e.g. event listeners). */
  userCan(userId: number | null, permission: string): boolean;
  allPermissions(): string[];
  /** A user's effective permissions (roles ∩ apps that are on). */
  permissionsOf(userId: number): Set<string>;
}

export function createAccess(db: Database, all: readonly string[], sessionHours: number, apps: AppRegistry): AccessService {
  // Only what the switched-on apps unlock (checked on every request, so toggling an app applies at once).
  const available = () => all.filter((p) => apps.allows(p));

  /** For display: the strongest built-in role the user holds, else "custom". */
  const primaryRole = (userId: number): string => {
    const keys = db.all<{ key: string | null }>('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', [userId]).map((r) => r.key);
    return BUILTIN_ROLES.find((k) => keys.includes(k)) ?? (keys.length ? 'custom' : 'none');
  };

  /** Union of the user's roles, limited to the apps that are on. */
  const effective = (userId: number): Set<string> => {
    const avail = available();
    const out = new Set<string>();
    for (const r of db.all<{ id: number; rule: RoleRule | null }>(
      'SELECT r.id, r.rule FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
      [userId],
    )) {
      if (r.rule) for (const p of permissionsForRule(r.rule, avail)) out.add(p);
      else
        for (const { permission } of db.all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role_id = ?', [r.id])) {
          if (apps.allows(permission) && all.includes(permission)) out.add(permission);
        }
    }
    return out;
  };
  // Brute-force protection: 5 failures per username+ip => 60s cool-down.
  const failures = new Map<string, { count: number; until: number }>();

  const toSessionUser = (u: UserRow): SessionUser => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: primaryRole(u.id),
    locale: u.locale,
    permissions: effective(u.id),
  });

  return {
    login(username, password, meta) {
      const key = `${username.toLowerCase()}|${meta.ip ?? ''}`;
      const f = failures.get(key);
      if (f && f.until > Date.now()) {
        throw new AppError('auth.locked', 'Too many attempts, try again in a minute', 429);
      }
      const u = db.get<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
      if (!u || !u.is_active || !verifyPassword(password, u.password_hash)) {
        const count = (f?.count ?? 0) + 1;
        failures.set(key, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
        throw new AppError('auth.invalid', 'Wrong username or password', 401);
      }
      failures.delete(key);
      const token = randomBytes(32).toString('base64url');
      const now = new Date();
      const expires = new Date(now.getTime() + sessionHours * 3_600_000);
      db.tx(() => {
        db.run('DELETE FROM sessions WHERE expires_at < ?', [now.toISOString()]);
        db.insert('sessions', {
          id: sha256(token),
          user_id: u.id,
          created_at: now.toISOString(),
          expires_at: expires.toISOString(),
          ip: meta.ip ?? null,
          user_agent: meta.userAgent?.slice(0, 300) ?? null,
        });
        db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now.toISOString(), u.id]);
      });
      return { token, user: toSessionUser(u) };
    },

    logout(token) {
      db.run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
    },

    authenticate(token) {
      if (!token) return null;
      const row = db.get<UserRow & { expires_at: string }>(
        `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
        [sha256(token)],
      );
      if (!row || !row.is_active || row.expires_at < new Date().toISOString()) return null;
      return toSessionUser(row);
    },

    can(user, permission) {
      return permission === 'auth' || user.permissions.has(permission);
    },

    revokeAll(userId) {
      db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    },

    userCan(userId, permission) {
      if (userId == null) return false;
      const u = db.get<{ is_active: number }>('SELECT is_active FROM users WHERE id = ?', [userId]);
      return !!u && !!u.is_active && effective(userId).has(permission);
    },

    allPermissions: () => [...all],
    permissionsOf: effective,
  };
}

export function validatePassword(pw: string): void {
  if (pw.length < 8) fail('auth.weak_password', 'Password must be at least 8 characters');
}
