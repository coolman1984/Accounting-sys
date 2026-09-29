import { zEnvelope, type Envelope } from '../../eco-contracts/index.js';
import type { ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso } from '../../kernel/dates.js';
import type { EcoInternal, OutboxRow } from './service.js';

export interface PeerRow {
  id: number;
  name: string;
  url: string;
  key_sealed: string;
  consumer: string;
  push: number;
  pull: number;
  types: string | null;
  push_cursor: number;
  pull_cursor: number;
  active: number;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface SyncReport {
  peer: string;
  pushed: number;
  parked: number;
  skipped: number;
  pulled: number;
  applied: number;
  rejected: number;
  error?: string;
}

/** What the outside world looks like: injectable for tests (default: the global fetch of Node 22). */
export type Http = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const OK = new Set(['applied', 'unchanged', 'stale', 'duplicate']);
const PAGE = 100;

const trimUrl = (u: string) => u.replace(/\/+$/, '');

export function peerView(p: PeerRow) {
  const { key_sealed: _k, ...rest } = p;
  return { ...rest, types: p.types ? p.types.split(' ') : null };
}

/**
 * Peers: the applications Mizan exchanges facts with over HTTP.
 *  - push: our outbox (after the peer's cursor) is POSTed to its /eco/v1/inbox; the peer's per-event answer decides:
 *    applied / unchanged / stale / duplicate move on; `eco.not_accepted` (it does not consume that type) is recorded as
 *    skipped; any other refusal is recorded as parked (visible in Integration → events, and in the health check),
 *    and the cursor still moves — one bad event never blocks the feed; the next version of that entity supersedes it.
 *  - pull: its GET /eco/v1/feed is read after our cursor and each event goes through the same inbox as a pushed one;
 *    what became of every event is reported back with POST /eco/v1/acks.
 * A network failure stops the run without moving any cursor: the next run resumes from the same place.
 */
export function createPeers(ctx: ModuleContext, eco: EcoInternal, http: { current: Http }) {
  const { db, secrets } = ctx;

  const get = (id: number) => db.get<PeerRow>('SELECT * FROM eco_peers WHERE id = ?', [id]) ?? notFound('eco_peer', id);
  const list = () => db.all<PeerRow>('SELECT * FROM eco_peers ORDER BY name');

  function add(input: { name: string; url: string; key: string; consumer: string; push: boolean; pull: boolean; types: string[] | null }) {
    if (!/^[A-Za-z0-9._-]{2,60}$/.test(input.name)) fail('eco.peer_name', 'Peer name: 2 to 60 letters, digits, dot, dash or underscore');
    if (!/^https?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/.test(input.url)) fail('eco.peer_url', 'Use the full address, e.g. http://192.168.1.20:4900');
    if (db.get('SELECT 1 FROM eco_peers WHERE name = ?', [input.name])) conflict('eco.peer_exists', `A peer named ${input.name} exists`, { name: input.name });
    if (!input.push && !input.pull) fail('eco.peer_direction', 'Choose push, pull or both');
    return db.insert('eco_peers', {
      name: input.name, url: trimUrl(input.url), key_sealed: secrets.seal(input.key), consumer: input.consumer,
      push: input.push, pull: input.pull, types: input.types?.length ? input.types.join(' ') : null, created_at: nowIso(),
    });
  }

  function update(id: number, input: { url?: string; key?: string | null; consumer?: string; push?: boolean; pull?: boolean; types?: string[] | null; active?: boolean }) {
    const cur = get(id);
    if (input.url !== undefined && !/^https?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/.test(input.url)) fail('eco.peer_url', 'Use the full address, e.g. http://192.168.1.20:4900');
    db.update('eco_peers', id, {
      url: input.url === undefined ? undefined : trimUrl(input.url),
      key_sealed: input.key ? secrets.seal(input.key) : undefined,
      consumer: input.consumer,
      push: input.push,
      pull: input.pull,
      types: input.types === undefined ? undefined : input.types?.length ? input.types.join(' ') : null,
      active: input.active,
    });
    return cur;
  }

  const remove = (id: number) => (get(id), db.run('DELETE FROM eco_peers WHERE id = ?', [id]));

  async function call(p: PeerRow, method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await http.current(trimUrl(p.url) + path, {
      method,
      headers: { 'x-eco-key': secrets.open(p.key_sealed), 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (res.status >= 400) throw new Error(`${p.name} answered ${res.status}: ${json?.error?.code ?? json?.error?.message ?? 'error'}`);
    return json;
  }

  const ack = (eventId: string, consumer: string, status: 'parked' | 'skipped', code: string, message: string) =>
    db.run(
      `INSERT INTO eco_ack (event_id, consumer, status, code, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, consumer) DO UPDATE SET status = excluded.status, code = excluded.code, message = excluded.message, updated_at = excluded.updated_at`,
      [eventId, consumer, status, code, message.slice(0, 1000), nowIso()],
    );

  async function push(p: PeerRow, r: SyncReport) {
    const wanted = p.types ? new Set(p.types.split(' ')) : null;
    for (;;) {
      const rows = db.all<OutboxRow>('SELECT * FROM eco_outbox WHERE seq > ? ORDER BY seq LIMIT ?', [p.push_cursor, PAGE]);
      if (!rows.length) return;
      const send = rows.filter((x) => !wanted || wanted.has(x.type));
      let results: { id: string | null; result: string; code?: string; message?: string }[] = [];
      if (send.length) {
        const answer = await call(p, 'POST', '/eco/v1/inbox', { events: send.map((x) => eco.toEnvelope(x)) });
        results = answer?.results ?? [];
        if (results.length !== send.length) throw new Error(`${p.name} answered ${results.length} results for ${send.length} events`);
      }
      db.tx(() => {
        send.forEach((ev, i) => {
          const res = results[i]!;
          if (OK.has(res.result)) r.pushed++;
          else if (res.code === 'eco.not_accepted') (ack(ev.id, p.name, 'skipped', res.code, res.message ?? 'not consumed by this application'), r.skipped++);
          else (ack(ev.id, p.name, 'parked', res.code ?? 'rejected', res.message ?? 'refused'), r.parked++);
        });
        p.push_cursor = rows[rows.length - 1]!.seq;
        db.run('UPDATE eco_peers SET push_cursor = ? WHERE id = ?', [p.push_cursor, p.id]);
      });
      if (rows.length < PAGE) return;
    }
  }

  async function pull(p: PeerRow, r: SyncReport) {
    for (;;) {
      const page = await call(p, 'GET', `/eco/v1/feed?after=${p.pull_cursor}&limit=${PAGE}`);
      const events: unknown[] = page?.events ?? [];
      if (!events.length) return;
      const acks: { event_id: string; consumer: string; status: 'applied' | 'parked' | 'skipped'; detail: Record<string, string> }[] = [];
      for (const raw of events) {
        const out = eco.receive(raw);
        const id = out.id ?? (raw as { id?: string }).id;
        if (OK.has(out.result)) r.applied++;
        else r.rejected++;
        if (id) {
          if (OK.has(out.result)) acks.push({ event_id: id, consumer: p.consumer, status: 'applied', detail: { code: out.result } });
          else if (out.code === 'eco.not_accepted') acks.push({ event_id: id, consumer: p.consumer, status: 'skipped', detail: { code: out.code, message: out.message ?? '' } });
          else acks.push({ event_id: id, consumer: p.consumer, status: 'parked', detail: { code: out.code ?? 'rejected', message: out.message ?? '' } });
        }
      }
      // The cursor moves only after every event of the page went through our inbox (applied or refused on record).
      const seqs = events.map((e) => (zEnvelope.safeParse(e).success ? (e as Envelope).ecoseq : 0));
      const last = Math.max(...seqs, 0);
      if (last <= p.pull_cursor) throw new Error(`${p.name}: the feed did not advance past ${p.pull_cursor}`);
      p.pull_cursor = last;
      db.run('UPDATE eco_peers SET pull_cursor = ? WHERE id = ?', [last, p.id]);
      if (acks.length) await call(p, 'POST', '/eco/v1/acks', { acks }).catch(() => undefined);
      if (events.length < PAGE) return;
    }
  }

  /** One pass with one peer. Never throws: a failure is recorded on the peer and reported. */
  async function sync(id: number): Promise<SyncReport> {
    const p = get(id);
    const r: SyncReport = { peer: p.name, pushed: 0, parked: 0, skipped: 0, pulled: 0, applied: 0, rejected: 0 };
    if (!p.active) return { ...r, error: 'inactive' };
    try {
      if (p.push) await push(p, r);
      if (p.pull) await pull(p, r);
      r.pulled = r.applied + r.rejected;
      db.run('UPDATE eco_peers SET last_ok_at = ?, last_error = NULL WHERE id = ?', [nowIso(), id]);
    } catch (e) {
      r.error = (e as Error).message;
      db.run('UPDATE eco_peers SET last_error = ? WHERE id = ?', [r.error.slice(0, 500), id]);
    }
    return r;
  }

  const syncAll = async () => {
    const out: SyncReport[] = [];
    for (const p of list()) if (p.active) out.push(await sync(p.id));
    return out;
  };

  return { get, list, add, update, remove, sync, syncAll };
}

export type PeerService = ReturnType<typeof createPeers>;

export const realHttp: Http = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, json: () => res.json() };
};
