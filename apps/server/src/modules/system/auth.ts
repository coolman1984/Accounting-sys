import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '../../kernel/db.js';
import { AppError, fail } from '../../kernel/errors.js';
import type { SessionUser } from '../../kernel/modules.js';
import type { AppRegistry } from '../../kernel/apps.js';

export type Role = 'admin' | 'accountant' | 'viewer';
export const ROLES: Role[] = ['admin', 'accountant', 'viewer'];

/** Permissions only administrators get. */
const ADMIN_ONLY = new Set(['users.manage', 'settings.manage', 'system.backup', 'pricing.override']);

export function permissionsFor(role: string, all: readonly string[]): Set<string> {
  if (role === 'admin') return new Set(all);
  if (role === 'accountant') return new Set(all.filter((p) => !ADMIN_ONLY.has(p)));
  return new Set(all.filter((p) => p.endsWith('.read')));
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
}

export function createAccess(db: Database, all: readonly string[], sessionHours: number, apps: AppRegistry): AccessService {
  // Only what the switched-on apps unlock (checked on every request, so toggling an app applies at once).
  const available = () => all.filter((p) => apps.allows(p));
  // Brute-force protection: 5 failures per username+ip => 60s cool-down.
  const failures = new Map<string, { count: number; until: number }>();

  const toSessionUser = (u: UserRow): SessionUser => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    locale: u.locale,
    permissions: permissionsFor(u.role, available()),
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
      const u = db.get<{ role: string; is_active: number }>('SELECT role, is_active FROM users WHERE id = ?', [userId]);
      return !!u && !!u.is_active && permissionsFor(u.role, available()).has(permission);
    },

    allPermissions: () => [...all],
  };
}

export function validatePassword(pw: string): void {
  if (pw.length < 8) fail('auth.weak_password', 'Password must be at least 8 characters');
}
