import { z } from 'zod';
import { parseQty, zAckV1, type SupplyPlanV1 } from '../../eco-contracts/index.js';
import type { AppModule, MachineCtx } from '../../kernel/modules.js';
import { AppError } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import { parse, zId } from '../../kernel/validate.js';
import type {} from '../../contracts/eco.js';
import { migrations } from './schema.js';
import { createEco, type EcoInternal, type OutboxRow } from './service.js';
import { peerView } from './peers.js';
import { authenticate, createKey, ECO_SCOPES, listKeys, requireScope, revokeKey, type EcoScope } from './keys.js';

/**
 * eco — Mizan's native side of the ecosystem (manufacturing GMES, HR-System, Space Planner).
 *
 * - Company id: UUIDv7, set once (migration), root of every global id Mizan mints.
 * - Outbox / feed: owners' snapshots (items, warehouses, parties, stock positions, purchase orders …)
 *   written in the SAME transaction as the change; consumers read GET /eco/v1/feed?after=<seq>.
 * - Inbox: manufacturing pushes its conclusions (requisitions, supply plan) to POST /eco/v1/inbox;
 *   (source, id) is remembered, so a redelivery is applied once; refusals stay visible.
 * - Acks: consumers report what became of each event (POST /eco/v1/acks).
 * Machine calls use an x-eco-key with scopes; /api/* stays for signed-in people.
 */
const zEvents = z.object({ status: z.enum(['parked', 'applied', 'skipped', 'pending']).optional(), type: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(5000).default(500) });

export const ecoModule: AppModule = {
  id: 'eco',
  dependsOn: ['system', 'ledger'],
  migrations,
  permissions: ['eco.events.read', 'eco.settings.manage'],
  apps: [{ id: 'eco', order: 95, permissions: ['eco'] }],
  roles: [{ id: 'integration_admin', permissions: ['eco.*'] }],

  health({ db, services }) {
    const r = db.get<{ n: number; mx: number | null }>('SELECT COUNT(*) n, MAX(seq) mx FROM eco_outbox')!;
    const parked = db.get<{ n: number }>("SELECT COUNT(*) n FROM eco_ack WHERE status = 'parked'")!.n;
    const rejected = db.get<{ n: number }>('SELECT COUNT(*) n FROM eco_inbox_rejects')!.n;
    const configured = process.env.MIZAN_ECO_COMPANY_ID?.trim().toLowerCase();
    const company = services.get('eco').companyId();
    return [
      { id: 'feed_gap_free', ok: r.n === (r.mx ?? 0), details: { events: r.n, lastSeq: r.mx ?? 0 } },
      { id: 'no_parked_events', ok: parked === 0, details: { parked } },
      { id: 'no_rejected_events', ok: rejected === 0, severity: 'warning', details: { rejected } },
      // The configured id is only read once, at the first start; a different one later is NOT applied silently.
      { id: 'company_id', ok: !configured || configured === company, details: { companyId: company, configured: configured ?? undefined } },
    ];
  },

  setup(ctx) {
    const eco = createEco(ctx);
    ctx.services.provide('eco', eco);

    // mes.supply_plan.v1 — kept as is (item × month) for whoever plans against it (S&OP, cash forecast …).
    eco.registerConsumer<SupplyPlanV1>({
      type: 'mes.supply_plan.v1',
      apply(d, env) {
        const cur = ctx.db.get<{ version: number }>('SELECT version FROM eco_supply_plans WHERE id = ?', [d.id]);
        if (cur && d.version < cur.version) return 'stale';
        if (cur && d.version === cur.version) return 'unchanged';
        const row = { code: d.code, version: d.version, mrp_run: d.mrp_run.code, source: env.source, received_at: nowIso() };
        if (cur) {
          ctx.db.run('UPDATE eco_supply_plans SET code = :code, version = :version, mrp_run = :mrp_run, source = :source, received_at = :received_at WHERE id = :id', { ...row, id: d.id });
          ctx.db.run('DELETE FROM eco_supply_plan WHERE plan_id = ?', [d.id]);
        } else ctx.db.insert('eco_supply_plans', { ...row, id: d.id });
        for (const l of d.lines) {
          const local = eco.localId('item', l.item.id);
          ctx.db.insert('eco_supply_plan', {
            plan_id: d.id,
            item_global_id: l.item.id,
            item_code: l.item.code,
            item_id: local == null ? null : Number(local),
            period: l.period,
            demand_qty: parseQty(l.demand_qty),
            planned_qty: parseQty(l.planned_qty),
            constraint_kind: l.constraint,
          });
        }
        return 'applied';
      },
    });
  },

  routes(r, { db, services, apps }) {
    const eco = services.get('eco') as EcoInternal;
    const audit = services.get('audit');

    /** A machine call: the eco app must be on and the key must carry the scope. */
    const caller = (c: MachineCtx, scope: EcoScope) => {
      const who = requireScope(authenticate(db, c.headers['x-eco-key']), scope);
      if (!apps.isEnabled('eco')) throw new AppError('eco.disabled', 'The integration app is switched off', 403);
      return who;
    };

    const events = (q: z.infer<typeof zEvents>) => {
      const where: string[] = [];
      const p: Record<string, string | number> = { limit: q.limit };
      if (q.status === 'pending') where.push('a.event_id IS NULL');
      else if (q.status) (where.push('a.status = :status'), (p.status = q.status));
      if (q.type) (where.push('o.type = :type'), (p.type = q.type));
      return db.all(
        `SELECT o.seq, o.id, o.type, o.subject, o.correlation, o.time, a.consumer, a.status, a.code, a.message, a.target_ref, a.figures, a.updated_at
         FROM eco_outbox o LEFT JOIN eco_ack a ON a.event_id = o.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY o.seq DESC LIMIT :limit`,
        p,
      );
    };

    // ------------------------------------------------------------------ machine endpoints (x-eco-key)
    r.machine('GET', '/eco/v1/feed', 'eco.feed.read', (c) => {
      caller(c, 'eco.feed.read');
      const q = parse(z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }), c.query);
      const rows = db.all<OutboxRow>('SELECT * FROM eco_outbox WHERE seq > ? ORDER BY seq LIMIT ?', [q.after, q.limit]);
      const head = db.get<{ s: number | null }>('SELECT MAX(seq) s FROM eco_outbox')!.s ?? 0;
      return { source: eco.source(), head, events: rows.map(eco.toEnvelope) };
    });

    r.machine('POST', '/eco/v1/acks', 'eco.acks.write', (c) => {
      const who = caller(c, 'eco.acks.write');
      const body = parse(z.object({ acks: z.array(zAckV1).min(1).max(500) }), c.body);
      const now = nowIso();
      return db.tx(() => {
        let unknown = 0;
        for (const a of body.acks) {
          if (a.consumer !== who.name) throw new AppError('eco.ack_consumer', `key ${who.name} cannot acknowledge for ${a.consumer}`, 403);
          if (!db.get('SELECT 1 FROM eco_outbox WHERE id = ?', [a.event_id])) {
            unknown++;
            continue;
          }
          db.run(
            `INSERT INTO eco_ack (event_id, consumer, status, code, message, target_ref, figures, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(event_id, consumer) DO UPDATE SET status = excluded.status, code = excluded.code, message = excluded.message,
               target_ref = excluded.target_ref, figures = excluded.figures, updated_at = excluded.updated_at`,
            [a.event_id, a.consumer, a.status, a.detail.code ?? null, a.detail.message ?? null, a.detail.target_ref ?? null, a.detail.figures ? JSON.stringify(a.detail.figures) : null, now],
          );
        }
        return { recorded: body.acks.length - unknown, unknown };
      });
    });

    r.machine('POST', '/eco/v1/inbox', 'eco.inbox.write', (c) => {
      caller(c, 'eco.inbox.write');
      const body = parse(z.object({ events: z.array(z.unknown()).min(1).max(500) }), c.body);
      return { results: body.events.map((e) => eco.receive(e)) };
    });

    r.machine('GET', '/eco/v1/events', 'eco.events.read', (c) => {
      caller(c, 'eco.events.read');
      return events(parse(zEvents, c.query));
    });

    // ------------------------------------------------------------------ people (session)
    r.get('/eco/company', 'auth', () => {
      const row = db.get<{ company_id: string; origin: string; created_at: string }>('SELECT company_id, origin, created_at FROM eco_company WHERE id = 1')!;
      return { companyId: row.company_id, origin: row.origin, createdAt: row.created_at, source: eco.source(), enabled: apps.isEnabled('eco') };
    });

    r.get('/eco/status', 'eco.events.read', () => {
      const out = db.get<{ n: number; mx: number | null }>('SELECT COUNT(*) n, MAX(seq) mx FROM eco_outbox')!;
      return {
        events: out.n,
        head: out.mx ?? 0,
        parked: db.get<{ n: number }>("SELECT COUNT(*) n FROM eco_ack WHERE status = 'parked'")!.n,
        received: db.get<{ n: number }>('SELECT COUNT(*) n FROM eco_inbox')!.n,
        rejected: db.get<{ n: number }>('SELECT COUNT(*) n FROM eco_inbox_rejects')!.n,
        types: eco.sources().map((s) => s.type),
        consumers: db.all('SELECT consumer, COUNT(*) n, MAX(updated_at) last FROM eco_ack GROUP BY consumer ORDER BY consumer'),
      };
    });

    r.get('/eco/keys', 'eco.settings.manage', () => listKeys(db));
    r.post('/eco/keys', 'eco.settings.manage', ({ body, user }) => {
      const input = parse(z.object({ name: z.string().max(60), scopes: z.array(z.string().max(40)).min(1).max(10) }), body);
      const k = db.tx(() => {
        const created = createKey(db, input, user.id);
        audit.log({ userId: user.id, action: 'create', entity: 'eco_key', entityId: created.id, summary: `${created.name}: ${input.scopes.join(' ')}` });
        return created;
      });
      return { ...k, note: 'Shown once: store it in the other application now.' };
    });
    r.post('/eco/keys/:id/revoke', 'eco.settings.manage', ({ params, user }) => {
      const id = parse(zId, params.id);
      db.tx(() => {
        const k = revokeKey(db, id);
        audit.log({ userId: user.id, action: 'revoke', entity: 'eco_key', entityId: id, summary: k.name });
      });
      return { ok: true };
    });
    r.get('/eco/scopes', 'eco.settings.manage', () => [...ECO_SCOPES]);

    // Publish every snapshot whose content differs from the last one sent (first connection, or after the app was off).
    r.post('/eco/resync', 'eco.settings.manage', ({ user }) => {
      if (!apps.isEnabled('eco')) throw new AppError('eco.disabled', 'The integration app is switched off', 409);
      const published = eco.resync();
      audit.log({ userId: user.id, action: 'resync', entity: 'eco', summary: `${published} snapshots` });
      return { published };
    });

    // ---- peers: applications this server exchanges facts with (its keys are sealed and never returned)
    const zPeer = z.object({
      name: z.string().max(60),
      url: z.string().max(300),
      key: z.string().min(8).max(300),
      consumer: z.string().min(2).max(60).optional(),
      push: z.boolean().default(true),
      pull: z.boolean().default(false),
      types: z.array(z.string().max(100)).max(50).nullish().transform((v) => v ?? null),
    });
    r.get('/eco/peers', 'eco.settings.manage', () => eco.peers.list().map(peerView));
    r.post('/eco/peers', 'eco.settings.manage', ({ body, user }) => {
      const i = parse(zPeer, body);
      const id = db.tx(() => {
        const id = eco.peers.add({ ...i, consumer: i.consumer ?? 'mizan' });
        audit.log({ userId: user.id, action: 'create', entity: 'eco_peer', entityId: id, summary: `${i.name} ${i.url}` });
        return id;
      });
      return { id };
    });
    r.put('/eco/peers/:id', 'eco.settings.manage', ({ params, body, user }) => {
      const id = parse(zId, params.id);
      const i = parse(zPeer.partial().extend({ active: z.boolean().optional(), key: z.string().min(8).max(300).nullish() }), body);
      db.tx(() => {
        eco.peers.update(id, i);
        audit.log({ userId: user.id, action: 'update', entity: 'eco_peer', entityId: id, summary: Object.keys(i).filter((k) => k !== 'key').join(',') + (i.key ? ' key' : '') });
      });
      return { ok: true };
    });
    r.delete('/eco/peers/:id', 'eco.settings.manage', ({ params, user }) => {
      const id = parse(zId, params.id);
      db.tx(() => {
        eco.peers.remove(id);
        audit.log({ userId: user.id, action: 'delete', entity: 'eco_peer', entityId: id });
      });
      return { ok: true };
    });
    r.post('/eco/peers/:id/sync', 'eco.settings.manage', async ({ params }) => eco.peers.sync(parse(zId, params.id)));
    r.post('/eco/sync', 'eco.settings.manage', async () => ({ peers: await eco.peers.syncAll() }));

    r.get('/eco/supply-plan', 'eco.events.read', () => eco.supplyPlan());

    // Every published event with what each consumer made of it; ?status=parked lists the exceptions.
    r.get('/integration/events', 'eco.events.read', ({ query }) => events(parse(zEvents, query)));
    // Events received from the other applications: accepted (result) and refused (with the reason).
    r.get('/integration/inbox', 'eco.events.read', ({ query }) => ({
      received: db.all('SELECT * FROM eco_inbox ORDER BY received_at DESC LIMIT ?', [Math.min(Number(query.limit ?? 500) || 500, 5000)]),
      rejected: db.all('SELECT * FROM eco_inbox_rejects ORDER BY last_at DESC'),
    }));
  },
};
