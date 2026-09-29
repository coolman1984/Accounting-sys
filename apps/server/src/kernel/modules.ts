import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import type { EventBus } from './events.js';
import type { ServiceRegistry } from './services.js';
import type { AppConfig } from '../config.js';
import type { AppManifest, AppRegistry } from './apps.js';

/**
 * The "mechano" contract. Every feature of the system — ledger, sales,
 * reports… — is an AppModule. A module owns its tables (migrations), exposes a
 * typed service for other modules, listens to events, and mounts HTTP routes.
 * Adding a feature = adding a module to `modules/index.ts`; nothing else in the
 * kernel changes.
 */
export interface AppModule {
  /** Stable id, also the migration namespace. */
  id: string;
  /** Other module ids that must be set up first. */
  dependsOn?: string[];
  /**
   * Optional modules to set up first WHEN they are installed (no dependency: an edition without
   * them still works). Lets a module plug into an optional one's registry in its own setup,
   * e.g. `after: ['eco']` to publish its entities to the integration feed.
   */
  after?: string[];
  migrations?: Migration[];
  /** Permission keys this module introduces (e.g. `sales.write`). */
  permissions?: string[];
  /** Wire services and event listeners. Runs once at boot, in dependency order. */
  setup?(ctx: ModuleContext): void;
  /** Mount HTTP endpoints (all under `/api`). */
  routes?(router: Router, ctx: ModuleContext): void;
  /** The apps (switchable features) this module provides or adds to. */
  apps?: AppManifest[];
  /**
   * Ready-made job roles this module suggests (the admin creates a role from
   * one in a click). Permissions may end in ".*" (every action of that object
   * or module); keys of modules that are not installed are dropped.
   */
  roles?: RoleTemplate[];
  /** Pairs of permissions one person should not hold together (segregation of duties). */
  sod?: [string, string][];
  /**
   * Self-checks of the module's own data (e.g. "stock value equals the
   * inventory accounts"). Each module is checked on its own, so a fault
   * points straight at the part of the system that has it.
   */
  health?(ctx: ModuleContext): HealthCheck[];
}

export interface RoleTemplate {
  /** Stable id, also the translation key (roles.templates.<id>). */
  id: string;
  permissions: string[];
}

/** What the kernel knows about each installed module (read-only, for admin screens and docs). */
export interface ModuleInfo {
  id: string;
  dependsOn: string[];
  permissions: string[];
  apps: string[];
  roles: RoleTemplate[];
  sod: [string, string][];
}

export interface HealthCheck {
  /** Stable key, also the translation key suffix (health.<module>.<id>). */
  id: string;
  ok: boolean;
  /** Numbers for the message, e.g. { difference: 120 }. */
  details?: Record<string, string | number | undefined>;
  /** Warnings are advice (e.g. "no backup for 3 days"), not errors. */
  severity?: 'error' | 'warning';
}

export interface Migration {
  /** Unique within the module, applied in array order, never edited once shipped. */
  id: string;
  up: string | ((db: Database) => void);
}

export interface ModuleContext {
  db: Database;
  services: ServiceRegistry;
  events: EventBus;
  config: AppConfig;
  /** Every permission key declared by every module. */
  permissions: readonly string[];
  /** Which apps are switched on. */
  apps: AppRegistry;
  /** Every installed module, in boot order. */
  installed: readonly ModuleInfo[];
}

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  locale: string;
  permissions: ReadonlySet<string>;
}

export interface RequestCtx {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  /** Always set on routes that are not `public`. */
  user: SessionUser;
  req: FastifyRequest;
  reply: FastifyReply;
}

export type Handler = (c: RequestCtx) => unknown | Promise<unknown>;

/** A request from another application (no session: the module authenticates it itself). */
export interface MachineCtx {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  req: FastifyRequest;
  reply: FastifyReply;
}

export type MachineHandler = (c: MachineCtx) => unknown | Promise<unknown>;

/**
 * `perm` is a permission key, `'auth'` for "any logged-in user", or `'public'`.
 */
export interface Router {
  get(path: string, perm: string, handler: Handler): void;
  post(path: string, perm: string, handler: Handler): void;
  put(path: string, perm: string, handler: Handler): void;
  delete(path: string, perm: string, handler: Handler): void;
  /**
   * Machine-to-machine endpoint, mounted as given (outside `/api`, which stays cookie-only).
   * Only paths under `/eco/` are allowed; the module checks the caller's key and scope.
   */
  machine(method: 'GET' | 'POST', path: string, scope: string, handler: MachineHandler): void;
}

/** Order modules so that each comes after its dependencies. */
export function sortModules(modules: AppModule[]): AppModule[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const out: AppModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (m: AppModule, trail: string[]) => {
    const s = state.get(m.id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`Module dependency cycle: ${[...trail, m.id].join(' -> ')}`);
    state.set(m.id, 'visiting');
    for (const dep of m.dependsOn ?? []) {
      const d = byId.get(dep);
      if (!d) throw new Error(`Module "${m.id}" depends on missing module "${dep}"`);
      visit(d, [...trail, m.id]);
    }
    for (const opt of m.after ?? []) {
      const d = byId.get(opt);
      if (d) visit(d, [...trail, m.id]);
    }
    state.set(m.id, 'done');
    out.push(m);
  };
  for (const m of modules) visit(m, []);
  return out;
}

export function runMigrations(db: Database, modules: AppModule[]): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    module TEXT NOT NULL,
    id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module, id)
  )`);
  const applied: string[] = [];
  for (const m of modules) {
    for (const mig of m.migrations ?? []) {
      const done = db.get('SELECT 1 FROM _migrations WHERE module = ? AND id = ?', [m.id, mig.id]);
      if (done) continue;
      db.tx(() => {
        if (typeof mig.up === 'string') db.exec(mig.up);
        else mig.up(db);
        db.run('INSERT INTO _migrations (module, id, applied_at) VALUES (?, ?, ?)', [m.id, mig.id, new Date().toISOString()]);
      });
      applied.push(`${m.id}/${mig.id}`);
    }
  }
  return applied;
}
