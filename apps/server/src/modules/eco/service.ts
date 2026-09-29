import { createHash } from 'node:crypto';
import {
  canonicalJson,
  companyOfSource,
  mizanId,
  newUuidv7,
  sourceOf,
  validateEvent,
  type Envelope,
} from '../../eco-contracts/index.js';
import type { ModuleContext } from '../../kernel/modules.js';
import { AppError } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import type {
  EcoBuildHelpers,
  EcoConsumer,
  EcoEntity,
  EcoService,
  EcoSnapshotSource,
  EcoSupplyPlanLine,
} from '../../contracts/eco.js';

export const APP = 'mizan';

export interface OutboxRow {
  seq: number;
  id: string;
  type: string;
  subject: string;
  correlation: string;
  causation: string | null;
  time: string;
  data: string;
}

export type InboxOutcome = { id: string | null; result: 'applied' | 'unchanged' | 'stale' | 'duplicate' | 'rejected'; code?: string; message?: string };

import { createPeers, realHttp, type Http, type PeerService } from './peers.js';

export type EcoInternal = EcoService & {
  peers: PeerService;
  http: { current: Http };
  sources(): EcoSnapshotSource[];
  toEnvelope(r: OutboxRow): Envelope;
  /** Rebuild every snapshot; returns how many new events were published. */
  resync(): number;
  receive(raw: unknown): InboxOutcome;
};

const fingerprint = (data: Record<string, unknown>, volatile: string[]) => {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!volatile.includes(k)) copy[k] = v;
  return createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
};

/**
 * The integration layer on accounting's side (the mirror of GMES's eco module, ADR-016 there).
 * One outbox, versioned snapshots of what Mizan owns, an inbox with dedupe, and registries so owner
 * modules plug in their snapshots and consumers without this module knowing them.
 */
export function createEco(ctx: ModuleContext): EcoInternal {
  const { db, apps, config } = ctx;
  const company = () => db.get<{ company_id: string }>('SELECT company_id FROM eco_company WHERE id = 1')!.company_id;
  const node = /^[A-Za-z0-9._-]{1,60}$/.test(config.ecoNode) ? config.ecoNode : 'main';
  const source = () => sourceOf(company(), APP, node);
  const sources = new Map<string, EcoSnapshotSource>();
  const consumers = new Map<string, EcoConsumer<unknown>>();
  const reservations: ((itemId: number, warehouseId: number) => number)[] = [];
  const dirty = new Map<string, Set<string>>();

  const globalId = (entity: EcoEntity, localId: number | string) => mizanId(company(), entity, localId);
  const helpers = (): EcoBuildHelpers => {
    const companyId = company();
    return {
      companyId,
      id: (entity, localId) => mizanId(companyId, entity, localId),
      ref: (entity, localId, code) => ({ id: mizanId(companyId, entity, localId), code }),
      origin: (entity, localId) => ({ app: APP, type: entity, key: String(localId) }),
      now: nowIso(),
    };
  };

  function publish(e: { type: string; subject: string; correlation: string; causation?: string; data: unknown }) {
    return db.tx(() => {
      const id = newUuidv7();
      const time = nowIso();
      const seq = (db.get<{ s: number | null }>('SELECT MAX(seq) s FROM eco_outbox')!.s ?? 0) + 1;
      const envelope = {
        specversion: '1.0', id, source: source(), type: e.type, subject: e.subject, time, datacontenttype: 'application/json',
        ecoseq: seq, ecocorrelation: e.correlation, ...(e.causation ? { ecocausation: e.causation } : {}), data: e.data,
      };
      // Never publish what the contract refuses: a bad event would park every consumer.
      const check = validateEvent(envelope);
      if (!check.ok) throw new AppError('eco.contract_violation', `refusing to publish ${e.type}: ${check.message}`, 500, { type: e.type });
      db.run('INSERT INTO eco_outbox (seq, id, type, subject, correlation, causation, time, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        seq, id, e.type, e.subject, e.correlation, e.causation ?? null, time, JSON.stringify(e.data),
      ]);
      return { id, seq };
    });
  }

  /** Rebuild one snapshot; publish it when its content changed. Returns true when an event was written. */
  function publishSnapshot(src: EcoSnapshotSource, localId: string, h: EcoBuildHelpers): boolean {
    const data = src.build(localId, h);
    if (!data) return false;
    const hash = fingerprint(data, src.volatile ?? []);
    const prev = db.get<{ hash: string; version: number }>('SELECT hash, version FROM eco_snapshots WHERE type = ? AND local_id = ?', [src.type, localId]);
    if (prev && prev.hash === hash) return false;
    // Mizan rows carry no version: issue one that only goes up — above the last one and time-based, so it is
    // also above what link-mizan sent for the same entity before this module existed.
    const version = Math.max((prev?.version ?? 0) + 1, Date.now());
    const gid = h.id(src.entity, localId);
    const subject = `${src.entity}/${gid}`;
    const ev = publish({ type: src.type, subject, correlation: subject, data: { ...data, version } });
    db.run(
      `INSERT INTO eco_snapshots (type, local_id, global_id, hash, version, event_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, local_id) DO UPDATE SET hash = excluded.hash, version = excluded.version, event_id = excluded.event_id, updated_at = excluded.updated_at`,
      [src.type, localId, gid, hash, version, ev.id, nowIso()],
    );
    return true;
  }

  function flush() {
    if (!dirty.size) return;
    const work = [...dirty.entries()];
    dirty.clear();
    const h = helpers();
    for (const [type, ids] of work) {
      const src = sources.get(type);
      if (src) for (const id of ids) publishSnapshot(src, id, h);
    }
  }

  function changed(type: string, localId: number | string) {
    if (!apps.isEnabled('eco') || !sources.has(type)) return;
    const set = dirty.get(type) ?? new Set<string>();
    set.add(String(localId));
    dirty.set(type, set);
    // Coalesced: one rebuild per entity per transaction, written just before it commits.
    db.beforeCommit(flush);
  }

  function localId(entity: EcoEntity, gid: string): string | null {
    const known = db.get<{ local_id: string }>('SELECT local_id FROM eco_snapshots WHERE global_id = ? LIMIT 1', [gid]);
    if (known) return known.local_id;
    const c = company();
    for (const src of sources.values()) {
      if (src.entity !== entity) continue;
      for (const id of src.all()) if (mizanId(c, entity, id) === gid) return id;
    }
    return null;
  }

  function reject(env: { source?: unknown; id?: unknown; type?: unknown }, code: string, message: string) {
    const src = typeof env.source === 'string' ? env.source.slice(0, 200) : '?';
    const id = typeof env.id === 'string' ? env.id.slice(0, 100) : '?';
    const now = nowIso();
    db.run(
      `INSERT INTO eco_inbox_rejects (source, event_id, type, code, message, attempts, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(source, event_id) DO UPDATE SET code = excluded.code, message = excluded.message, type = excluded.type,
         attempts = attempts + 1, last_at = excluded.last_at`,
      [src, id, typeof env.type === 'string' ? env.type.slice(0, 100) : null, code, message.slice(0, 1000), now, now],
    );
  }

  function receive(raw: unknown): InboxOutcome {
    const r = (raw ?? {}) as { id?: unknown; source?: unknown; type?: unknown };
    const id = typeof r.id === 'string' ? r.id : null;
    const refuse = (code: string, message: string): InboxOutcome => {
      reject(r, code, message);
      return { id, result: 'rejected', code, message };
    };
    const v = validateEvent(raw);
    if (!v.ok) return refuse(v.code, v.message);
    const env = v.data as Envelope;
    if (companyOfSource(env.source) !== company()) return refuse('eco.foreign_company', `event from another company: ${env.source}`);
    if (env.source === source()) return refuse('eco.own_event', 'an event Mizan published itself');
    const consumer = consumers.get(env.type);
    if (!consumer) return refuse('eco.not_accepted', `accounting does not consume ${env.type}`);
    try {
      const result = db.tx(() => {
        if (db.get('SELECT 1 FROM eco_inbox WHERE source = ? AND event_id = ?', [env.source, env.id])) return 'duplicate' as const;
        const res = consumer.apply(env.data, env);
        db.run('INSERT INTO eco_inbox (source, event_id, type, result, received_at) VALUES (?, ?, ?, ?, ?)', [env.source, env.id, env.type, res, nowIso()]);
        db.run('DELETE FROM eco_inbox_rejects WHERE source = ? AND event_id = ?', [env.source, env.id]);
        return res;
      });
      return { id, result };
    } catch (err) {
      if (err instanceof AppError) return refuse(err.code, err.message);
      return refuse('eco.apply_failed', (err as Error).message ?? String(err));
    }
  }

  const http = { current: realHttp as Http };
  const built: Omit<EcoInternal, 'peers'> = {
    http,
    companyId: company,
    source,
    globalId,
    localId,
    registerSnapshot(src) {
      if (sources.has(src.type)) throw new Error(`eco: snapshot type ${src.type} registered twice`);
      sources.set(src.type, src);
    },
    registerConsumer(c) {
      if (consumers.has(c.type)) throw new Error(`eco: consumer for ${c.type} registered twice`);
      consumers.set(c.type, c as EcoConsumer<unknown>);
    },
    registerReservations(fn) {
      reservations.push(fn);
    },
    reservedQty: (itemId, warehouseId) => reservations.reduce((s, fn) => s + (fn(itemId, warehouseId) || 0), 0),
    changed,
    publish,
    supplyPlan(): EcoSupplyPlanLine[] {
      const plan = db.get<{ id: string }>('SELECT id FROM eco_supply_plans ORDER BY received_at DESC, rowid DESC LIMIT 1');
      if (!plan) return [];
      return db.all<EcoSupplyPlanLine>(
        `SELECT item_id, item_global_id, item_code, period, demand_qty, planned_qty, constraint_kind AS "constraint"
         FROM eco_supply_plan WHERE plan_id = ? ORDER BY item_code, period`,
        [plan.id],
      );
    },
    sources: () => [...sources.values()],
    toEnvelope: (r) => ({
      specversion: '1.0', id: r.id, source: source(), type: r.type, subject: r.subject, time: r.time, datacontenttype: 'application/json',
      ecoseq: r.seq, ecocorrelation: r.correlation, ...(r.causation ? { ecocausation: r.causation } : {}), data: JSON.parse(r.data),
    }) as Envelope,
    resync() {
      return db.tx(() => {
        const h = helpers();
        let n = 0;
        for (const src of sources.values()) for (const id of src.all()) if (publishSnapshot(src, id, h)) n++;
        return n;
      });
    },
    receive,
  };
  const service = built as EcoInternal;
  service.peers = createPeers(ctx, service, http);
  return service;
}
