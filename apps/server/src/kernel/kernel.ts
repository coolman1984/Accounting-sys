import { Database } from './db.js';
import { EventBus } from './events.js';
import { ServiceRegistry } from './services.js';
import { runMigrations, sortModules, type AppModule, type ModuleContext } from './modules.js';
import type { AppConfig } from '../config.js';
import { createAppRegistry } from './apps.js';

export interface Kernel extends ModuleContext {
  modules: AppModule[];
  close(): void;
}

/** Boot the core: open the database, migrate, and wire every module. */
export function createKernel(config: AppConfig, modules: AppModule[]): Kernel {
  const ordered = sortModules(modules);
  const db = new Database(config.dbFile);
  runMigrations(db, ordered);
  const permissions = [...new Set(ordered.flatMap((m) => m.permissions ?? []))].sort();
  const apps = createAppRegistry(db, ordered.flatMap((m) => m.apps ?? []));
  const installed = ordered.map((m) => ({
    id: m.id,
    dependsOn: m.dependsOn ?? [],
    permissions: m.permissions ?? [],
    apps: [...new Set((m.apps ?? []).map((a) => a.id))],
    roles: m.roles ?? [],
    sod: m.sod ?? [],
  }));
  const ctx: ModuleContext = { db, services: new ServiceRegistry(), events: new EventBus(), config, permissions, apps, installed };
  for (const m of ordered) m.setup?.(ctx);
  return { ...ctx, modules: ordered, close: () => db.close() };
}
