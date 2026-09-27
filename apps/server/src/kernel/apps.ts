import type { Database } from './db.js';

/**
 * Apps are what a customer switches on: "Sales", "Purchases", "Inventory"…
 * Modules are how the code is built. A module declares the apps it provides
 * (a module may provide several — documents serves both Sales and Purchases —
 * and several modules may add to one app). Turning an app off hides its
 * permissions from every user and puts its event listeners to sleep; the data
 * stays, so turning it back on loses nothing.
 */
export interface AppManifest {
  id: string;
  /** Always on (the accounting core everything else posts to). */
  core?: boolean;
  /** Apps that must be on for this one to work. */
  requires?: string[];
  /** Permission prefixes this app unlocks ("sales" → sales.read, sales.write…). A prefix may belong to several apps. */
  permissions: string[];
  /** Display order in the app catalogue. */
  order?: number;
}

export interface AppState {
  id: string;
  core: boolean;
  requires: string[];
  enabled: boolean;
  order: number;
  permissions: string[];
}

export interface AppRegistry {
  list(): AppState[];
  isEnabled(id: string): boolean;
  /** Whether a permission key is unlocked by the apps that are on. */
  allows(permission: string): boolean;
  /** Replace the set of optional apps that are on (core apps cannot be turned off). */
  setEnabled(ids: string[]): void;
}

export class AppsError extends Error {
  constructor(
    readonly code: 'apps.unknown' | 'apps.requires',
    message: string,
    readonly details: Record<string, string>,
  ) {
    super(message);
  }
}

/** Merge the manifests every module contributes (same id = same app). */
export function collectApps(manifests: AppManifest[]): Map<string, AppManifest> {
  const out = new Map<string, AppManifest>();
  for (const m of manifests) {
    const cur = out.get(m.id);
    if (!cur) out.set(m.id, { ...m, requires: [...(m.requires ?? [])], permissions: [...m.permissions] });
    else {
      cur.core = cur.core || m.core;
      cur.requires = [...new Set([...(cur.requires ?? []), ...(m.requires ?? [])])];
      cur.permissions = [...new Set([...cur.permissions, ...m.permissions])];
      cur.order = cur.order ?? m.order;
    }
  }
  for (const a of out.values()) {
    for (const r of a.requires ?? []) if (!out.has(r)) throw new Error(`App "${a.id}" requires unknown app "${r}"`);
  }
  return out;
}

export function createAppRegistry(db: Database, manifests: AppManifest[]): AppRegistry {
  const apps = collectApps(manifests);
  db.exec('CREATE TABLE IF NOT EXISTS _apps (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
  // An app not in the table yet is on: existing companies keep everything, new apps appear enabled.
  let off = new Set(db.all<{ id: string }>('SELECT id FROM _apps WHERE enabled = 0').map((r) => r.id));
  const isEnabled = (id: string) => {
    const a = apps.get(id);
    return !!a && (!!a.core || !off.has(id));
  };
  // Prefixes owned by no app at all (a module outside the catalogue) stay available.
  const owned = new Set([...apps.values()].flatMap((a) => a.permissions));

  return {
    list: () =>
      [...apps.values()]
        .map((a) => ({
          id: a.id,
          core: !!a.core,
          requires: a.requires ?? [],
          enabled: isEnabled(a.id),
          order: a.order ?? 100,
          permissions: a.permissions,
        }))
        .sort((x, y) => x.order - y.order),
    isEnabled,
    allows(permission) {
      const prefix = permission.split('.')[0];
      if (!owned.has(prefix)) return true;
      for (const a of apps.values()) if (a.permissions.includes(prefix) && isEnabled(a.id)) return true;
      return false;
    },
    setEnabled(ids) {
      for (const id of ids) if (!apps.has(id)) throw new AppsError('apps.unknown', `Unknown app "${id}"`, { app: id });
      const on = new Set([...ids, ...[...apps.values()].filter((a) => a.core).map((a) => a.id)]);
      for (const id of on) {
        const missing = (apps.get(id)!.requires ?? []).find((r) => !on.has(r));
        if (missing) throw new AppsError('apps.requires', `"${id}" needs "${missing}"`, { app: id, requires: missing });
      }
      db.tx(() => {
        for (const a of apps.values()) {
          db.run('INSERT INTO _apps (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled', [a.id, on.has(a.id) ? 1 : 0]);
        }
      });
      off = new Set([...apps.keys()].filter((id) => !on.has(id)));
    },
  };
}
