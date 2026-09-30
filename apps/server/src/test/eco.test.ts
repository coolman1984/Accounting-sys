import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQty, mizanId, newUuidv7, validateEvent } from '../eco-contracts/index.js';
import { createSecrets } from '../kernel/secrets.js';
import type { EcoInternal } from '../modules/eco/service.js';
import type { Http } from '../modules/eco/peers.js';
import { setupCompany, type TestClient } from './helpers.js';

/**
 * The integration module: keys, feed, inbox, acks, snapshots, requisitions and the supply plan from
 * manufacturing, peers. Manufacturing is played by hand-made envelopes signed with a key.
 */
describe('eco — the ecosystem side of Mizan', () => {
  let c: TestClient;
  let eco: EcoInternal;
  let company: string;
  let supplier: number, main: number, chip: number;
  let feedKey: string, inboxKey: string, ackKey: string;

  const db = () => c.app.kernel.db;
  const inject = (method: 'GET' | 'POST', url: string, key?: string, payload?: unknown) =>
    c.app.http.inject({ method, url, payload: payload as object, headers: key ? { 'x-eco-key': key } : {} }).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));
  const feed = async (after = 0, limit = 500) => (await inject('GET', `/eco/v1/feed?after=${after}&limit=${limit}`, feedKey)).body.events as any[];
  const ofType = (events: any[], type: string) => events.filter((e) => e.type === type);
  const outboxCount = () => db().get<{ n: number }>('SELECT COUNT(*) n FROM eco_outbox')!.n;
  const mkKey = async (name: string, scopes: string[]) => (await c.post('/api/eco/keys', { name, scopes })).key as string;
  const item = (body: object) => c.post('/api/items', { kind: 'product', unit: 'PCS', ...body }).then((r) => r.id as number);

  before(async () => {
    c = await setupCompany();
    eco = c.app.kernel.services.get('eco') as EcoInternal;
    company = eco.companyId();
    feedKey = await mkKey('reader', ['eco.feed.read']);
    inboxKey = await mkKey('gmes', ['eco.inbox.write', 'eco.acks.write']);
    ackKey = inboxKey;
    supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Shenzhen Panels', nameAlt: 'شنجن', country: 'CN' })).id;
    main = (await c.get('/api/inventory/warehouses')).find((w: any) => w.is_default).id;
    await c.post('/api/eco/resync'); // what existed before the module first ran (the default warehouse)
    chip = await item({ sku: 'CHIP', nameEn: 'Main chip', nameAr: 'شريحة', purchasePrice: 1000, materialType: 'raw', leadTimeDays: 70, moq: 100000, lotSizeRule: 'multiple', lotSize: 50000, safetyStock: 20000 });
  });
  after(() => c.close());

  const envelope = (type: string, data: any, id = newUuidv7(), seq = 1, source = `eco://${company}/gmes/plant-1`) => ({
    specversion: '1.0', id, source, type, subject: `x/${data.id}`, time: new Date().toISOString(), datacontenttype: 'application/json', ecoseq: seq, ecocorrelation: `x/${data.id}`, data,
  });
  const requisition = (over: Record<string, unknown> = {}) => ({
    id: newUuidv7(), code: 'PR-1', version: 1, origin: { app: 'gmes', type: 'requisition', key: '1' },
    item: { id: mizanId(company, 'item', chip), code: 'CHIP' }, qty: '150', uom: 'PCS', need_date: '2026-09-01', order_by_date: '2026-06-23',
    warehouse: { id: mizanId(company, 'warehouse', main), code: 'MAIN' }, mrp_run: { id: newUuidv7(), code: 'MRP-9' }, status: 'open',
    pegging: [{ kind: 'sales_order', reference: 'SO-1/1', qty: '150' }], ...over,
  });
  const send = async (events: unknown[], key = inboxKey) => (await inject('POST', '/eco/v1/inbox', key, { events })).body.results as any[];

  test('company id: a UUIDv7 made once, shown by the API, and never changed', async () => {
    const r = await c.get('/api/eco/company');
    assert.equal(r.companyId, company);
    assert.match(company, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(r.source, `eco://${company}/mizan/main`);
    assert.throws(() => db().run("UPDATE eco_company SET company_id = 'x'"), /never changes/);
    assert.throws(() => db().run('DELETE FROM eco_company'), /never changes/);
  });

  test('key auth: 401 without a key, 401 for a wrong key, 403 for a missing scope; /api stays cookie-only', async () => {
    assert.equal((await inject('GET', '/eco/v1/feed')).status, 401);
    assert.equal((await inject('GET', '/eco/v1/feed', 'mk_nonsense')).status, 401);
    assert.equal((await inject('GET', '/eco/v1/feed', inboxKey)).status, 403, 'a key with inbox rights cannot read the feed');
    assert.equal((await inject('POST', '/eco/v1/inbox', feedKey, { events: [{}] })).status, 403);
    assert.equal((await inject('GET', '/eco/v1/events', feedKey)).status, 403);
    assert.equal((await inject('GET', '/eco/v1/feed', feedKey)).status, 200);
    const viaApi = await inject('GET', '/api/items', feedKey);
    assert.equal(viaApi.status, 401, 'a machine key never opens the people’s API');
    // Only the hash is stored.
    const rows = db().all<{ key_hash: string }>('SELECT key_hash FROM eco_keys');
    assert.ok(rows.every((r) => r.key_hash !== feedKey && /^[0-9a-f]{64}$/.test(r.key_hash)));
    // Revoked keys stop working at once.
    const temp = await mkKey('temp-key', ['eco.feed.read']);
    assert.equal((await inject('GET', '/eco/v1/feed', temp)).status, 200);
    const id = (await c.get('/api/eco/keys')).find((k: any) => k.name === 'temp-key').id;
    await c.post(`/api/eco/keys/${id}/revoke`);
    assert.equal((await inject('GET', '/eco/v1/feed', temp)).status, 401);
    assert.equal((await c.raw('POST', '/api/eco/keys', { name: 'temp-key', scopes: ['eco.feed.read'] })).status, 409, 'names are never reused');
    assert.equal((await c.raw('POST', '/api/eco/keys', { name: 'bad-scope', scopes: ['gl.everything'] })).status, 400);
  });

  test('items, parties and warehouses are published as valid, versioned snapshots', async () => {
    const events = await feed();
    for (const e of events) assert.equal(validateEvent(e).ok, true, `${e.type} is a valid contract`);
    const it = ofType(events, 'eco.item.v1').find((e) => e.data.code === 'CHIP');
    assert.equal(it.data.id, mizanId(company, 'item', chip));
    assert.equal(it.data.base_uom, 'PCS');
    assert.equal(it.source, `eco://${company}/mizan/main`);
    const party = ofType(events, 'eco.party.v1').find((e) => e.data.code.startsWith('S-'));
    assert.deepEqual(party.data.roles, ['supplier']);
    assert.equal(party.data.country, 'CN');
    assert.equal(party.data.name.ar, 'شنجن');
    assert.ok(ofType(events, 'eco.warehouse.v1').some((e) => e.data.code === 'MAIN' && e.data.is_default));
  });

  test('the feed is gap-free and in order, and health says so', async () => {
    const events = await feed();
    assert.deepEqual(events.map((e) => e.ecoseq), events.map((_, i) => i + 1));
    const page = await feed(1, 2);
    assert.deepEqual(page.map((e) => e.ecoseq), [2, 3]);
    const health = (await c.get('/api/system/health')).find((m: any) => m.module === 'eco');
    assert.equal(health.checks.find((x: any) => x.id === 'feed_gap_free').ok, true);
    assert.equal(health.checks.find((x: any) => x.id === 'no_parked_events').ok, true);
  });

  test('a snapshot is published in the transaction of the change: rolled back, no event', async () => {
    const before = outboxCount();
    const catalog = c.app.kernel.services.get('catalog');
    assert.throws(() =>
      db().tx(() => {
        catalog.createItem({ sku: 'GHOST', nameEn: 'Ghost', nameAr: 'شبح', kind: 'product', unit: 'PCS' }, null);
        assert.equal(outboxCount(), before, 'nothing is written before the transaction ends');
        throw new Error('rolled back');
      }), /rolled back/);
    assert.equal(outboxCount(), before);
    assert.equal(db().get('SELECT 1 FROM items WHERE sku = ?', ['GHOST']), undefined);
    // Committed: item and event together, one event however many times it changed inside the transaction.
    db().tx(() => {
      const id = catalog.createItem({ sku: 'REAL', nameEn: 'Real', nameAr: 'حقيقي', kind: 'product', unit: 'PCS' }, null);
      db().run("UPDATE items SET name_en = 'Real 2' WHERE id = ?", [id]);
      eco.changed('eco.item.v1', id);
    });
    assert.equal(outboxCount(), before + 1);
    assert.equal((await feed(before)).length, 1);
  });

  test('version only goes up, and only when the content changed', async () => {
    const list = () => ofType(db().all<any>('SELECT data, type FROM eco_outbox').map((r) => ({ type: r.type, data: JSON.parse(r.data) })), 'eco.item.v1').filter((e) => e.data.code === 'CHIP');
    const v1 = list();
    const cur = (await c.get('/api/items')).find((i: any) => i.id === chip);
    const body = { sku: cur.sku, nameEn: cur.name_en, nameAr: cur.name_ar, kind: 'product', unit: 'PCS', purchasePrice: 1000, materialType: 'raw', leadTimeDays: 70, moq: 100000, lotSizeRule: 'multiple', lotSize: 50000, safetyStock: 20000 };
    await c.put(`/api/items/${chip}`, body);
    assert.equal(list().length, v1.length, 'saving the same content publishes nothing');
    await c.put(`/api/items/${chip}`, { ...body, nameEn: 'Main chip v2' });
    const v2 = list();
    assert.equal(v2.length, v1.length + 1);
    assert.ok(v2.at(-1)!.data.version > v1.at(-1)!.data.version);
    assert.equal(v2.at(-1)!.data.name.en, 'Main chip v2');
    // The planning block travels with the item (manufacturing plans its purchases by it): changing a planning field is a new version.
    await c.put(`/api/items/${chip}`, { ...body, nameEn: 'Main chip v2', leadTimeDays: 75 });
    const v3 = list();
    assert.equal(v3.length, v2.length + 1);
    assert.equal(v3.at(-1)!.data.planning.lead_time_days, 75);
    assert.ok(v3.at(-1)!.data.version > v2.at(-1)!.data.version);
  });

  test('stock positions follow every move; `reserved` comes from the registry (default 0)', async () => {
    const r = await c.post('/api/inventory/receipts', { supplierId: supplier, date: '2026-02-01', warehouseId: main, post: true, lines: [{ itemId: chip, quantity: 30000, unitCost: 1000 }] });
    assert.ok(r.id);
    const pos = () => ofType(db().all<any>('SELECT type, data FROM eco_outbox').map((x) => ({ type: x.type, data: JSON.parse(x.data) })), 'acc.stock_position.v1').filter((e) => e.data.item.code === 'CHIP');
    assert.equal(pos().length, 1);
    assert.equal(pos()[0].data.on_hand, '30');
    assert.equal(pos()[0].data.reserved, '0');
    assert.equal(pos()[0].data.id, mizanId(company, 'stock_position', `${chip}:${main}`));
    eco.registerReservations((i, w) => (i === chip && w === main ? 12000 : 0));
    eco.changed('acc.stock_position.v1', `${chip}:${main}`);
    db().tx(() => eco.changed('acc.stock_position.v1', `${chip}:${main}`));
    assert.equal(pos().at(-1)!.data.reserved, '12');
    assert.ok(pos().at(-1)!.data.version > pos()[0].data.version);
  });

  test('a purchase order is published from approval, with received quantity after a partial receipt', async () => {
    const before = ofType(db().all<any>('SELECT type FROM eco_outbox'), 'acc.purchase_order.v1').length;
    const draft = (await c.post('/api/purchase-orders', { supplierId: supplier, date: '2026-04-01', expectedDate: '2026-06-10', warehouseId: main, lines: [{ itemId: chip, quantity: 100000, unitPrice: 1000, expectedDate: '2026-06-12' }] })).id;
    assert.equal(ofType(db().all<any>('SELECT type FROM eco_outbox'), 'acc.purchase_order.v1').length, before, 'a draft is not a commitment');
    await c.post(`/api/purchase-orders/${draft}/approve`);
    const po = await c.get(`/api/purchase-orders/${draft}`);
    const snap = () => db().all<any>('SELECT type, data FROM eco_outbox').filter((x) => x.type === 'acc.purchase_order.v1').map((x) => JSON.parse(x.data)).at(-1);
    assert.equal(snap().code, po.number);
    assert.equal(snap().status, 'open');
    assert.equal(snap().lines[0].qty, '100');
    assert.equal(snap().lines[0].received_qty, '0');
    assert.equal(snap().lines[0].expected_date, '2026-06-12', 'the line date wins over the order date');
    await c.post('/api/inventory/receipts', { supplierId: supplier, poId: draft, date: '2026-05-01', warehouseId: main, post: true, lines: [{ itemId: chip, quantity: 40000, unitCost: 1000, poLineId: po.lines[0].id }] });
    assert.equal(snap().lines[0].received_qty, '40');
    assert.equal(snap().lines[0].qty, '100');
    assert.equal(snap().status, 'open');
    assert.equal(validateEvent({ ...envelope('acc.purchase_order.v1', snap()), source: `eco://${company}/mizan/main` }).ok, true);
    await c.post(`/api/purchase-orders/${draft}/cancel`).catch(() => undefined); // has activity: refused, stays open
    assert.equal(snap().status, 'open');
  });

  test('inbox: manufacturing’s requisition is upserted, deduplicated, versioned and cancelled', async () => {
    const req = requisition();
    const first = envelope('mes.purchase_requisition.v1', req);
    assert.deepEqual((await send([first])).map((r) => r.result), ['applied']);
    const row = () => db().get<any>('SELECT * FROM purchase_requisitions WHERE global_id = ?', [req.id])!;
    assert.equal(row().source, 'mrp');
    assert.equal(row().quantity, 150000);
    assert.equal(row().status, 'open');
    assert.equal(row().order_by_date, '2026-06-23');
    assert.match(row().pegging, /sales_order SO-1\/1/);
    // The same event again is a duplicate; the same content in a new event is unchanged.
    assert.equal((await send([first]))[0].result, 'duplicate');
    assert.equal((await send([envelope('mes.purchase_requisition.v1', req)]))[0].result, 'unchanged');
    // A newer version updates the open requisition; an older one is stale.
    assert.equal((await send([envelope('mes.purchase_requisition.v1', { ...req, version: 2, qty: '200', need_date: '2026-09-10' })]))[0].result, 'applied');
    assert.equal(row().quantity, 200000);
    assert.equal(row().need_date, '2026-09-10');
    assert.equal((await send([envelope('mes.purchase_requisition.v1', { ...req, version: 1, qty: '5' })]))[0].result, 'stale');
    assert.equal(row().quantity, 200000);
    // Converted requisitions belong to purchasing: a newer version changes nothing but is remembered.
    const number = row().number;
    const list = await c.get('/api/purchase-requisitions');
    const id = list.find((r: any) => r.number === number).id;
    const poId = (await c.post('/api/purchase-requisitions/convert', { ids: [id], supplierId: supplier })).id;
    assert.equal(row().status, 'converted');
    assert.equal((await send([envelope('mes.purchase_requisition.v1', { ...req, version: 3, qty: '999' })]))[0].result, 'unchanged');
    assert.equal(row().quantity, 200000);
    assert.equal(row().global_version, 3);
    assert.equal(row().po_id, poId);
    // Cancelled while open: cancelled here too.
    const req2 = requisition({ code: 'PR-2' });
    await send([envelope('mes.purchase_requisition.v1', req2)]);
    assert.equal((await send([envelope('mes.purchase_requisition.v1', { ...req2, version: 2, status: 'cancelled' })]))[0].result, 'applied');
    assert.equal(db().get<any>('SELECT status FROM purchase_requisitions WHERE global_id = ?', [req2.id])!.status, 'cancelled');
    // Cancelling one that never arrived creates nothing.
    const req3 = requisition({ code: 'PR-3', status: 'cancelled' });
    assert.equal((await send([envelope('mes.purchase_requisition.v1', req3)]))[0].result, 'unchanged');
    assert.equal(db().get('SELECT 1 FROM purchase_requisitions WHERE global_id = ?', [req3.id]), undefined);
  });

  test('inbox: refusals are per event, with a code, and stay on record', async () => {
    const good = envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-OK' }));
    const unknownItem = envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-X', item: { id: newUuidv7(), code: 'NOPE' } }));
    const wrongUnit = envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-U', uom: 'KG' }));
    const foreign = envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-F' }), newUuidv7(), 1, `eco://${newUuidv7()}/gmes/plant-1`);
    const badShape = { ...envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-B' })), data: { nonsense: true } };
    const notForUs = envelope('eco.employee.v1', { id: newUuidv7(), code: 'E1', employment_status: 'Active', active: true, version: 1, origin: { app: 'hr', type: 'employee', key: 'E1' } });
    const results = await send([good, unknownItem, wrongUnit, foreign, badShape, notForUs]);
    assert.deepEqual(results.map((r) => r.result), ['applied', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
    assert.deepEqual(results.slice(1).map((r) => r.code), ['eco.unknown_item', 'eco.uom_mismatch', 'eco.foreign_company', 'contract.invalid', 'eco.not_accepted']);
    assert.equal(db().get<{ n: number }>('SELECT COUNT(*) n FROM eco_inbox_rejects')!.n, 5, 'every refused event is kept with its reason');
    const inbox = await c.get('/api/integration/inbox');
    assert.ok(inbox.rejected.some((r: any) => r.code === 'eco.uom_mismatch'));
    const health = (await c.get('/api/system/health')).find((m: any) => m.module === 'eco');
    assert.equal(health.checks.find((x: any) => x.id === 'no_rejected_events').ok, false);
    // A rolled-back apply leaves no inbox record, so the redelivery is applied (not "duplicate").
    assert.equal(db().get('SELECT 1 FROM eco_inbox WHERE event_id = ?', [wrongUnit.id]), undefined);
  });

  test('inbox: the supply plan is kept as item × month for other modules', async () => {
    const plan = {
      id: newUuidv7(), code: 'SUP-2026-10', version: 1, origin: { app: 'gmes', type: 'supply_plan', key: '1' }, mrp_run: { id: newUuidv7(), code: 'MRP-9' },
      lines: [
        { item: { id: mizanId(company, 'item', chip), code: 'CHIP' }, period: '2026-10', demand_qty: '500', planned_qty: '400.5', constraint: 'material' },
        { item: { id: newUuidv7(), code: 'UNKNOWN' }, period: '2026-11', demand_qty: '10', planned_qty: '10', constraint: 'none' },
      ],
    };
    assert.equal((await send([envelope('mes.supply_plan.v1', plan)]))[0].result, 'applied');
    const lines = eco.supplyPlan();
    assert.equal(lines.length, 2);
    const l = lines.find((x) => x.item_code === 'CHIP')!;
    assert.deepEqual([l.item_id, l.period, l.demand_qty, l.planned_qty, l.constraint], [chip, '2026-10', 500000, 400500, 'material']);
    assert.equal(lines.find((x) => x.item_code === 'UNKNOWN')!.item_id, null);
    // A newer version replaces the lines; an older one is stale.
    assert.equal((await send([envelope('mes.supply_plan.v1', { ...plan, version: 2, lines: [plan.lines[0]] })]))[0].result, 'applied');
    assert.equal(eco.supplyPlan().length, 1);
    assert.equal((await send([envelope('mes.supply_plan.v1', { ...plan, version: 1 })]))[0].result, 'stale');
    assert.equal((await c.get('/api/eco/supply-plan')).length, 1);
  });

  test('acks: a consumer reports what became of an event; parked ones are listed as exceptions', async () => {
    const events = await feed();
    const target = events[0];
    const ok = await inject('POST', '/eco/v1/acks', ackKey, { acks: [{ event_id: target.id, consumer: 'gmes', status: 'applied', detail: { target_ref: 'MDM-1' } }, { event_id: newUuidv7(), consumer: 'gmes', status: 'applied' }] });
    assert.deepEqual(ok.body, { recorded: 1, unknown: 1 });
    assert.equal((await inject('POST', '/eco/v1/acks', ackKey, { acks: [{ event_id: target.id, consumer: 'someone-else', status: 'applied' }] })).status, 403);
    assert.equal((await inject('POST', '/eco/v1/acks', feedKey, { acks: [{ event_id: target.id, consumer: 'reader', status: 'applied' }] })).status, 403);
    await inject('POST', '/eco/v1/acks', ackKey, { acks: [{ event_id: events[1].id, consumer: 'gmes', status: 'parked', detail: { code: 'item.unknown', message: 'no such item' } }] });
    const parked = await c.get('/api/integration/events?status=parked');
    assert.equal(parked.length, 1);
    assert.equal(parked[0].code, 'item.unknown');
    const health = (await c.get('/api/system/health')).find((m: any) => m.module === 'eco');
    assert.equal(health.checks.find((x: any) => x.id === 'no_parked_events').ok, false);
    // The event log itself can never be edited or deleted.
    assert.throws(() => db().run("UPDATE eco_outbox SET type = 'x'"), /immutable/);
    assert.throws(() => db().run('DELETE FROM eco_outbox'), /immutable/);
  });

  describe('peers', () => {
    const calls: { url: string; method: string; key: string; body?: any }[] = [];
    let answer: (url: string, body: any) => { status: number; json: unknown };
    const fake: Http = async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method, key: init.headers['x-eco-key']!, body });
      const r = answer(url, body);
      return { status: r.status, json: async () => r.json };
    };
    let peerId: number;

    test('the key given for a peer is sealed: never in the database, never returned', async () => {
      peerId = (await c.post('/api/eco/peers', { name: 'gmes-plant', url: 'http://192.168.1.20:4900/', key: 'gk_plain-secret-key', consumer: 'mizan', push: true, pull: true })).id;
      const raw = db().get<{ key_sealed: string }>('SELECT key_sealed FROM eco_peers WHERE id = ?', [peerId])!.key_sealed;
      assert.ok(!raw.includes('plain-secret') && raw.startsWith('v1:'));
      assert.ok(!JSON.stringify(await c.get('/api/eco/peers')).includes('plain-secret'));
      const s = createSecrets(':memory:', '.');
      assert.equal(s.open(s.seal('hello')), 'hello');
      assert.notEqual(s.seal('hello'), s.seal('hello'), 'a fresh nonce every time');
      assert.throws(() => s.open(s.seal('x').slice(0, -3) + 'AAA'));
    });

    test('push: our feed goes to its inbox; not-consumed types are skipped, refusals are parked, the cursor moves', async () => {
      eco.http.current = fake;
      const total = outboxCount();
      answer = (url, body) => {
        if (url.endsWith('/eco/v1/inbox')) {
          return {
            status: 200,
            json: {
              results: body.events.map((e: any) =>
                e.type === 'acc.stock_position.v1' ? { id: e.id, result: 'rejected', code: 'eco.not_accepted', message: 'no' }
                : e.type === 'acc.purchase_order.v1' ? { id: e.id, result: 'rejected', code: 'eco.unknown_item', message: 'item?' }
                : { id: e.id, result: 'applied' }),
            },
          };
        }
        return { status: 200, json: { events: [] } };
      };
      const r = await eco.peers.sync(peerId);
      assert.equal(r.error, undefined);
      assert.equal(calls[0].key, 'gk_plain-secret-key');
      assert.equal(calls[0].url, 'http://192.168.1.20:4900/eco/v1/inbox');
      assert.equal(r.pushed + r.skipped + r.parked, total);
      assert.ok(r.skipped >= 1 && r.parked >= 1);
      assert.equal(db().get<{ push_cursor: number }>('SELECT push_cursor FROM eco_peers WHERE id = ?', [peerId])!.push_cursor, total);
      const parked = db().all<any>("SELECT * FROM eco_ack WHERE consumer = 'gmes-plant' AND status = 'parked'");
      assert.ok(parked.length >= 1 && parked.every((p) => p.code === 'eco.unknown_item'));
      // Nothing new: nothing sent. A new change: exactly that event.
      calls.length = 0;
      await eco.peers.sync(peerId);
      assert.equal(calls.filter((x) => x.url.endsWith('/inbox')).length, 0);
      await c.post('/api/items', { sku: 'NEW1', nameEn: 'New', nameAr: 'جديد', kind: 'product', unit: 'PCS' });
      calls.length = 0;
      await eco.peers.sync(peerId);
      assert.equal(calls.find((x) => x.url.endsWith('/inbox'))!.body.events.length, 1);
    });

    test('a network failure moves no cursor and is recorded; the next run resumes', async () => {
      await c.post('/api/items', { sku: 'NEW2', nameEn: 'New 2', nameAr: 'جديد ٢', kind: 'product', unit: 'PCS' });
      const cursor = () => db().get<{ push_cursor: number }>('SELECT push_cursor FROM eco_peers WHERE id = ?', [peerId])!.push_cursor;
      const at = cursor();
      answer = () => ({ status: 503, json: null });
      const failed = await eco.peers.sync(peerId);
      assert.match(failed.error!, /503/);
      assert.equal(cursor(), at);
      assert.match(db().get<any>('SELECT last_error FROM eco_peers WHERE id = ?', [peerId])!.last_error, /503/);
      answer = (url, body) => (url.endsWith('/inbox') ? { status: 200, json: { results: body.events.map((e: any) => ({ id: e.id, result: 'applied' })) } } : { status: 200, json: { events: [] } });
      const ok = await eco.peers.sync(peerId);
      assert.equal(ok.error, undefined);
      assert.equal(cursor(), outboxCount());
      assert.equal(db().get<any>('SELECT last_error FROM eco_peers WHERE id = ?', [peerId])!.last_error, null);
    });

    test('pull: its feed goes through our inbox and the outcome is acknowledged to it', async () => {
      const ev = envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-PULL' }), newUuidv7(), 41);
      const bad = envelope('mes.purchase_requisition.v1', requisition({ code: 'PR-BAD', uom: 'KG' }), newUuidv7(), 42);
      const other = envelope('eco.employee.v1', { id: newUuidv7(), code: 'E2', employment_status: 'Active', active: true, version: 1, origin: { app: 'hr', type: 'employee', key: 'E2' } }, newUuidv7(), 43);
      calls.length = 0;
      answer = (url, body) => {
        if (url.includes('/eco/v1/feed')) return { status: 200, json: { events: url.includes('after=0') ? [ev, bad, other] : [] } };
        if (url.endsWith('/acks')) return { status: 200, json: { recorded: body.acks.length, unknown: 0 } };
        return { status: 200, json: { results: (body?.events ?? []).map((e: any) => ({ id: e.id, result: 'applied' })) } };
      };
      const r = await eco.peers.sync(peerId);
      assert.equal(r.error, undefined);
      assert.equal(r.applied, 1);
      assert.equal(r.rejected, 2);
      assert.equal(db().get<any>("SELECT quantity FROM purchase_requisitions WHERE global_code = 'PR-PULL'")!.quantity, 150000);
      const acks = calls.find((x) => x.url.endsWith('/acks'))!.body.acks;
      assert.deepEqual(acks.map((a: any) => [a.status, a.detail.code]), [['applied', 'applied'], ['parked', 'eco.uom_mismatch'], ['skipped', 'eco.not_accepted']]);
      assert.ok(acks.every((a: any) => a.consumer === 'mizan'));
      assert.equal(db().get<any>('SELECT pull_cursor FROM eco_peers WHERE id = ?', [peerId])!.pull_cursor, 43);
      // The cursor is past them: the next run asks for events after 43.
      calls.length = 0;
      await eco.peers.sync(peerId);
      assert.ok(calls.some((x) => x.url.includes('after=43')));
    });
  });

  test('editions: without the eco module every other module still works (the socket is optional)', async () => {
    const { sortModules } = await import('../kernel/modules.js');
    const { modules } = await import('../modules/index.js');
    const without = sortModules(modules.filter((m) => m.id !== 'eco'));
    assert.ok(without.some((m) => m.id === 'purchasing') && !without.some((m) => m.id === 'eco'));
    const at = (id: string) => without.findIndex((m) => m.id === id);
    const withEco = sortModules(modules);
    const atE = (id: string) => withEco.findIndex((m) => m.id === id);
    for (const id of ['catalog', 'parties', 'inventory', 'purchasing']) assert.ok(atE('eco') < atE(id), `eco is set up before ${id}`);
    assert.ok(at('purchasing') >= 0);
    assert.equal(formatQty(1500), '1.5');
  });
});
