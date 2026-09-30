import { createReadStream, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { AppError, conflict, fail, notFound } from '../../kernel/errors.js';
import { paging, parse, zDate, zOptText } from '../../kernel/validate.js';
import { migrations } from './schema.js';
import {
  createAudit,
  createSequences,
  createSettings,
  type AuditService,
  type CompanySettings,
  type SequenceService,
  type SettingsService,
} from './settings.js';
import { BUILTIN_ROLES, createAccess, expandPermissions, hashPassword, permissionsForRule, validatePassword, verifyPassword, type AccessService, type RoleRule } from './auth.js';
import { nowIso, nowMs } from '../../kernel/dates.js';

export const VERSION = '0.1.0';
export const SESSION_COOKIE = 'mizan_sid';

export interface BackupService {
  create(label?: string): { name: string; size: number };
  list(): { name: string; size: number; createdAt: string }[];
  path(name: string): string;
  prune(keep: number): void;
}

declare module '../../kernel/services.js' {
  interface ServiceMap {
    settings: SettingsService;
    sequences: SequenceService;
    audit: AuditService;
    access: AccessService;
    backup: BackupService;
  }
}

const zCompany = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: zOptText(200),
  taxNumber: zOptText(50),
  address: zOptText(500),
  phone: zOptText(50),
  email: zOptText(200),
  baseCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  moneyScale: z.number().int().min(0).max(4),
});

const zSetup = z.object({
  company: zCompany,
  fiscalYearStart: zDate,
  admin: z.object({
    username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(200),
  }),
  locale: z.enum(['en', 'ar']).default('en'),
  seedChartOfAccounts: z.boolean().default(true),
  vatRateBp: z.number().int().min(0).max(10000).nullable().default(1400),
  /** Optional apps to switch on (omitted = all). */
  apps: z.array(z.string()).max(50).optional(),
});

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

export const systemModule: AppModule = {
  id: 'system',
  migrations,
  permissions: ['admin.settings.read', 'admin.settings.manage', 'admin.users.manage', 'admin.audit.read', 'admin.backup.manage'],
  apps: [{ id: 'gl', core: true, order: 0, permissions: ['admin'] }],
  health({ db, services }) {
    const quick = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check;
    const last = services.get('backup').list()[0];
    const ageDays = last ? Math.floor((nowMs() - Date.parse(last.createdAt)) / 86_400_000) : null;
    return [
      { id: 'database', ok: quick === 'ok', details: { result: quick ?? '?' } },
      { id: 'backup', ok: ageDays != null && ageDays <= 2, severity: 'warning', details: { days: ageDays ?? -1 } },
    ];
  },

  setup({ db, services, config, permissions, apps }) {
    services.provide('settings', createSettings(db));
    services.provide('sequences', createSequences(db));
    services.provide('audit', createAudit(db));
    services.provide('access', createAccess(db, permissions, config.sessionHours, apps));

    const backupName = /^mizan-[\w.-]+\.db$/;
    services.provide('backup', {
      create(label = 'manual') {
        const stamp = nowIso().replace(/[:T]/g, '-').slice(0, 19);
        const name = `mizan-${stamp}-${label.replace(/[^\w-]/g, '')}.db`;
        const file = join(config.backupDir, name);
        db.backupTo(file);
        return { name, size: statSync(file).size };
      },
      list() {
        if (!existsSync(config.backupDir)) return [];
        return readdirSync(config.backupDir)
          .filter((n) => backupName.test(n))
          .map((name) => {
            const st = statSync(join(config.backupDir, name));
            return { name, size: st.size, createdAt: st.mtime.toISOString() };
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
      path(name) {
        if (!backupName.test(name)) notFound('backup', name);
        const file = join(config.backupDir, name);
        if (!existsSync(file)) notFound('backup', name);
        return file;
      },
      prune(keep) {
        const auto = this.list().filter((b) => b.name.endsWith('-auto.db'));
        for (const b of auto.slice(keep)) unlinkSync(join(config.backupDir, b.name));
      },
    });
  },

  routes(r, { db, services, events, config, apps, installed }) {
    const settings = services.get('settings');
    const access = services.get('access');
    const audit = services.get('audit');

    r.get('/system/info', 'public', () => ({
      app: 'Mizan',
      version: VERSION,
      setupComplete: settings.isSetupComplete(),
      companyName: settings.get<CompanySettings | null>('company', null)?.name ?? null,
      lanUrls: lanUrls(config.port),
      // The app catalogue (no secrets) — the setup wizard lets the owner choose.
      apps: apps.list().map(({ id, core, requires, enabled, order }) => ({ id, core, requires, enabled, order })),
    }));

    // ---------- First-run setup ----------
    r.post('/setup', 'public', ({ body }) => {
      if (settings.isSetupComplete()) conflict('setup.done', 'The system is already set up');
      const input = parse(zSetup, body);
      db.tx(() => {
        settings.set('company', input.company satisfies CompanySettings);
        settings.set('lockDate', null);
        const userId = db.insert('users', {
          username: input.admin.username,
          display_name: input.admin.displayName,
          password_hash: hashPassword(input.admin.password),
          role: 'admin',
          locale: input.locale,
          created_at: nowIso(),
        });
        db.run("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = 'admin'", [userId]);
        events.emit('system.setup', {
          locale: input.locale,
          fiscalYearStart: input.fiscalYearStart,
          seedChartOfAccounts: input.seedChartOfAccounts,
          vatRateBp: input.vatRateBp,
        });
        if (input.apps) apps.setEnabled(input.apps);
        settings.set('setupComplete', true);
        audit.log({ userId, action: 'setup', entity: 'system', summary: `Company "${input.company.name}" created` });
      });
      return { ok: true };
    });

    // ---------- Auth ----------
    r.post('/auth/login', 'public', ({ body, req, reply }) => {
      const input = parse(z.object({ username: z.string().trim().min(1), password: z.string().min(1) }), body);
      const { token, user } = access.login(input.username, input.password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: config.sessionHours * 3600,
      });
      audit.log({ userId: user.id, action: 'login', entity: 'user', entityId: user.id, summary: req.ip });
      return { user: { ...user, permissions: [...user.permissions] } };
    });

    r.post('/auth/logout', 'auth', ({ req, reply }) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) access.logout(token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    r.get('/auth/me', 'auth', ({ user }) => ({
      user: { ...user, permissions: [...user.permissions] },
      apps: apps.list().filter((a) => a.enabled).map((a) => a.id),
      company: settings.company(),
      lockDate: settings.lockDate(),
    }));

    r.put('/auth/me', 'auth', ({ user, body }) => {
      const input = parse(
        z.object({ displayName: z.string().trim().min(1).max(100).optional(), locale: z.enum(['en', 'ar']).optional() }),
        body,
      );
      db.update('users', user.id, { display_name: input.displayName, locale: input.locale });
      return { ok: true };
    });

    r.post('/auth/password', 'auth', ({ user, body, req, reply }) => {
      const input = parse(z.object({ current: z.string(), next: z.string() }), body);
      const row = db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [user.id])!;
      if (!verifyPassword(input.current, row.password_hash)) throw new AppError('auth.invalid', 'Current password is wrong', 400);
      validatePassword(input.next);
      db.tx(() => {
        db.update('users', user.id, { password_hash: hashPassword(input.next) });
        access.revokeAll(user.id);
        audit.log({ userId: user.id, action: 'password', entity: 'user', entityId: user.id });
      });
      // Re-login this browser so the user isn't kicked out.
      const { token } = access.login(user.username, input.next, { ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: config.sessionHours * 3600 });
      return { ok: true };
    });

    // ---------- Users & roles ----------
    const zUser = z.object({
      username: z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().trim().min(1).max(100),
      /** Roles the user holds (ids). `role` (a built-in key) is still accepted from older clients. */
      roleIds: z.array(z.number().int().positive()).max(50).optional(),
      role: z.enum(BUILTIN_ROLES).optional(),
      locale: z.enum(['en', 'ar']).default('en'),
      isActive: z.boolean().default(true),
    });

    const roleIdsOf = (userId: number) => db.all<{ role_id: number }>('SELECT role_id FROM user_roles WHERE user_id = ?', [userId]).map((r) => r.role_id);
    const resolveRoles = (input: { roleIds?: number[]; role?: string }): number[] | undefined => {
      if (input.roleIds) {
        for (const id of input.roleIds) if (!db.get('SELECT 1 FROM roles WHERE id = ?', [id])) notFound('role', id);
        return [...new Set(input.roleIds)];
      }
      if (input.role) return [db.get<{ id: number }>('SELECT id FROM roles WHERE key = ?', [input.role])!.id];
      return undefined;
    };
    const adminRoleId = () => db.get<{ id: number }>("SELECT id FROM roles WHERE key = 'admin'")!.id;
    /** At least one active user must keep the Administrator role (no locking yourself out). */
    const assertAdminLeft = () => {
      const n = db.get<{ n: number }>(
        'SELECT COUNT(*) n FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE ur.role_id = ? AND u.is_active = 1',
        [adminRoleId()],
      )!.n;
      if (n === 0) fail('user.last_admin', 'At least one active administrator is required');
    };
    // users.role is legacy (NOT NULL, three values): keep it roughly in line for old reports.
    const legacyRole = (roleIds: number[]) => {
      const keys = roleIds.map((id) => db.get<{ key: string | null }>('SELECT key FROM roles WHERE id = ?', [id])?.key);
      return keys.includes('admin') ? 'admin' : keys.includes('accountant') ? 'accountant' : 'viewer';
    };

    r.get('/users', 'admin.users.manage', () =>
      db
        .all<{ id: number }>('SELECT id, username, display_name, role, locale, is_active, created_at, last_login_at FROM users ORDER BY username')
        .map((u) => ({ ...u, role_ids: roleIdsOf(u.id), permissions: [...access.permissionsOf(u.id)] })),
    );

    r.post('/users', 'admin.users.manage', ({ user, body }) => {
      const input = parse(zUser.extend({ password: z.string() }), body);
      validatePassword(input.password);
      if (db.get('SELECT 1 FROM users WHERE username = ?', [input.username])) conflict('user.exists', 'Username already taken');
      const roleIds = resolveRoles(input) ?? [];
      return db.tx(() => {
        const id = db.insert('users', {
          username: input.username,
          display_name: input.displayName,
          password_hash: hashPassword(input.password),
          role: legacyRole(roleIds),
          locale: input.locale,
          is_active: input.isActive,
          created_at: nowIso(),
        });
        for (const rid of roleIds) db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, rid]);
        audit.log({ userId: user.id, action: 'create', entity: 'user', entityId: id, summary: input.username, data: { roleIds } });
        return { id };
      });
    });

    r.put('/users/:id', 'admin.users.manage', ({ user, params, body }) => {
      const id = Number(params.id);
      // Only the fields sent change: no defaults here (zod 4 applies .default() inside .partial()).
      const input = parse(
        z.object({
          username: zUser.shape.username.optional(),
          displayName: zUser.shape.displayName.optional(),
          roleIds: zUser.shape.roleIds,
          role: zUser.shape.role,
          locale: z.enum(['en', 'ar']).optional(),
          isActive: z.boolean().optional(),
        }),
        body,
      );
      if (!db.get('SELECT 1 FROM users WHERE id = ?', [id])) return notFound('user', id);
      if (input.username && db.get('SELECT 1 FROM users WHERE username = ? AND id <> ?', [input.username, id])) conflict('user.exists', 'Username already taken');
      const roleIds = resolveRoles(input);
      db.tx(() => {
        db.update('users', id, {
          username: input.username,
          display_name: input.displayName,
          role: roleIds ? legacyRole(roleIds) : undefined,
          locale: input.locale,
          is_active: input.isActive,
        });
        if (roleIds) {
          db.run('DELETE FROM user_roles WHERE user_id = ?', [id]);
          for (const rid of roleIds) db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [id, rid]);
        }
        assertAdminLeft();
        if (input.isActive === false || roleIds) access.revokeAll(id);
        audit.log({ userId: user.id, action: 'update', entity: 'user', entityId: id, data: input });
      });
      return { ok: true };
    });

    // Roles: built-in ones follow a rule (and pick up new modules by themselves); custom ones list permissions.
    const zRole = z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(500).nullish().transform((v) => v || null),
      permissions: z.array(z.string()).max(2000),
    });
    const all = () => access.allPermissions();

    r.get('/roles', 'admin.users.manage', () =>
      db
        .all<{ id: number; key: string | null; name: string; description: string | null; rule: RoleRule | null }>('SELECT * FROM roles ORDER BY key IS NULL, id')
        .map((role) => ({
          ...role,
          builtin: !!role.key,
          permissions: role.rule
            ? permissionsForRule(role.rule, all())
            : db.all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission', [role.id]).map((p) => p.permission),
          users: db.get<{ n: number }>('SELECT COUNT(*) n FROM user_roles WHERE role_id = ?', [role.id])!.n,
        })),
    );

    /** The permission catalogue for the role editor: every key with its module, plus templates and SoD pairs. */
    r.get('/permissions', 'admin.users.manage', () => ({
      modules: installed.filter((m) => m.permissions.length).map((m) => ({ id: m.id, apps: m.apps, permissions: m.permissions })),
      templates: installed.flatMap((m) => m.roles.map((t) => ({ id: t.id, module: m.id, permissions: expandPermissions(t.permissions, all()) }))),
      sod: installed.flatMap((m) => m.sod).filter(([a, b]) => all().includes(a) && all().includes(b)),
    }));

    const savePermissions = (roleId: number, perms: string[]) => {
      const unknown = perms.filter((p) => !all().includes(p));
      if (unknown.length) fail('role.unknown_permission', `Unknown permission ${unknown[0]}`, { permission: unknown[0] });
      db.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
      for (const p of new Set(perms)) db.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', [roleId, p]);
    };

    r.post('/roles', 'admin.users.manage', ({ user, body }) => {
      const input = parse(zRole, body);
      if (db.get('SELECT 1 FROM roles WHERE name = ? COLLATE NOCASE', [input.name])) conflict('role.duplicate', 'A role with this name exists');
      return db.tx(() => {
        const id = db.insert('roles', { name: input.name, description: input.description, created_at: nowIso(), updated_at: nowIso() });
        savePermissions(id, input.permissions);
        audit.log({ userId: user.id, action: 'create', entity: 'role', entityId: id, summary: input.name, data: { permissions: input.permissions } });
        return { id };
      });
    });

    r.put('/roles/:id', 'admin.users.manage', ({ user, params, body }) => {
      const id = Number(params.id);
      const cur = db.get<{ key: string | null; name: string }>('SELECT key, name FROM roles WHERE id = ?', [id]) ?? notFound('role', id);
      if (cur.key) conflict('role.builtin', 'Built-in roles cannot be changed — copy it into a new role');
      const input = parse(zRole, body);
      const dup = db.get<{ id: number }>('SELECT id FROM roles WHERE name = ? COLLATE NOCASE', [input.name]);
      if (dup && dup.id !== id) conflict('role.duplicate', 'A role with this name exists');
      db.tx(() => {
        db.update('roles', id, { name: input.name, description: input.description, updated_at: nowIso() });
        savePermissions(id, input.permissions);
        audit.log({ userId: user.id, action: 'update', entity: 'role', entityId: id, summary: input.name, data: { permissions: input.permissions } });
      });
      // New rights apply on the next request; nobody needs to log in again.
      return { ok: true };
    });

    r.delete('/roles/:id', 'admin.users.manage', ({ user, params }) => {
      const id = Number(params.id);
      const cur = db.get<{ key: string | null; name: string }>('SELECT key, name FROM roles WHERE id = ?', [id]) ?? notFound('role', id);
      if (cur.key) conflict('role.builtin', 'Built-in roles cannot be deleted');
      db.tx(() => {
        db.run('DELETE FROM roles WHERE id = ?', [id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'role', entityId: id, summary: cur.name });
      });
      return { ok: true };
    });

    r.post('/users/:id/password', 'admin.users.manage', ({ user, params, body }) => {
      const id = Number(params.id);
      const input = parse(z.object({ password: z.string() }), body);
      validatePassword(input.password);
      if (!db.get('SELECT 1 FROM users WHERE id = ?', [id])) notFound('user', id);
      db.tx(() => {
        db.update('users', id, { password_hash: hashPassword(input.password) });
        access.revokeAll(id);
        audit.log({ userId: user.id, action: 'password', entity: 'user', entityId: id });
      });
      return { ok: true };
    });

    // ---------- Settings ----------
    r.get('/settings', 'auth', () => ({
      company: settings.company(),
      lockDate: settings.lockDate(),
    }));

    r.put('/settings/company', 'admin.settings.manage', ({ user, body }) => {
      const current = settings.company();
      const input = parse(zCompany.omit({ moneyScale: true, baseCurrency: true }), body);
      // Currency and decimals are fixed at setup: changing them would reinterpret every stored amount.
      const next: CompanySettings = { ...current, ...input };
      db.tx(() => {
        settings.set('company', next);
        audit.log({ userId: user.id, action: 'update', entity: 'settings', summary: 'company', data: input });
      });
      return next;
    });

    r.put('/settings/lock-date', 'admin.settings.manage', ({ user, body }) => {
      const input = parse(z.object({ lockDate: zDate.nullable() }), body);
      db.tx(() => {
        settings.set('lockDate', input.lockDate);
        audit.log({ userId: user.id, action: 'update', entity: 'settings', summary: `lock date → ${input.lockDate ?? 'none'}` });
      });
      return { lockDate: input.lockDate };
    });

    r.get('/sequences', 'admin.settings.read', () => services.get('sequences').list());

    r.put('/sequences/:key', 'admin.settings.manage', ({ user, params, body }) => {
      const input = parse(
        z.object({
          prefix: z.string().max(10).optional(),
          next_value: z.number().int().positive().optional(),
          padding: z.number().int().min(1).max(12).optional(),
        }),
        body,
      );
      db.tx(() => {
        services.get('sequences').update(params.key, input);
        audit.log({ userId: user.id, action: 'update', entity: 'sequence', summary: params.key, data: input });
      });
      return { ok: true };
    });

    // ---------- Audit trail ----------
    r.get('/audit', 'admin.audit.read', ({ query }) => {
      const { limit, offset } = paging(query, 100);
      const where: string[] = [];
      const p: Record<string, string | number> = { limit, offset };
      if (query.entity) {
        where.push('a.entity = :entity');
        p.entity = query.entity;
      }
      if (query.entityId) {
        where.push('a.entity_id = :entityId');
        p.entityId = Number(query.entityId);
      }
      if (query.userId) {
        where.push('a.user_id = :userId');
        p.userId = Number(query.userId);
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.all(
        `SELECT a.*, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ${w} ORDER BY a.id DESC LIMIT :limit OFFSET :offset`,
        p,
      );
      const { limit: _l, offset: _o, ...countParams } = p;
      const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit_log a ${w}`, countParams)!.n;
      return { rows, total };
    });

    // ---------- Backups ----------
    const backup = services.get('backup');
    r.get('/system/backups', 'admin.backup.manage', () => backup.list());
    r.post('/system/backups', 'admin.backup.manage', ({ user }) => {
      const b = backup.create('manual');
      audit.log({ userId: user.id, action: 'backup', entity: 'system', summary: b.name });
      return b;
    });
    r.get('/system/backups/:name', 'admin.backup.manage', ({ params, reply }) => {
      const file = backup.path(params.name);
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-disposition', `attachment; filename="${params.name}"`);
      return reply.send(createReadStream(file));
    });
  },
};
