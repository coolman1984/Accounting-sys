import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import type { EventBus } from './events.js';
import type { ServiceRegistry } from './services.js';
import type { AppConfig } from '../config.js';

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
  migrations?: Migration[];
  /** Permission keys this module introduces (e.g. `sales.write`). */
  permissions?: string[];
  /** Wire services and event listeners. Runs once at boot, in dependency order. */
  setup?(ctx: ModuleContext): void;
  /** Mount HTTP endpoints (all under `/api`). */
  routes?(router: Router, ctx: ModuleContext): void;
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

/**
 * `perm` is a permission key, `'auth'` for "any logged-in user", or `'public'`.
 */
export interface Router {
  get(path: string, perm: string, handler: Handler): void;
  post(path: string, perm: string, handler: Handler): void;
  put(path: string, perm: string, handler: Handler): void;
  delete(path: string, perm: string, handler: Handler): void;
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
