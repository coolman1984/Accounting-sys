import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';
import { schedule, addMonth } from '../modules/assets/engine.js';

/**
 * A van: cost 120,000, residual 12,000, 60 months straight line from Jan 2026 → 1,800 a month.
 * Depreciation booked for January, then March (catching up February): 5,400.
 * Sold on 20 May for 100,000: April and May are charged at disposal (3,600) → accumulated 9,000,
 * book value 111,000, loss 11,000.
 */
describe('fixed assets: register, depreciation runs, disposal, roll-forward', () => {
  let c: TestClient;
  const K = 100;
  let bank: number, vehicles: number, accum: number, depExp: number, van: number, vehiclesCat: number;
  const balance = async (id: number) => {
    const t = await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(t.balanced, true);
    const r = t.rows.find((x: any) => x.id === id);
    return r ? r.closing_debit - r.closing_credit : 0;
  };

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    [bank, vehicles, accum, depExp] = await Promise.all(['1120', '1220', '1290', '5290'].map((x) => acc(c, x)));
    const capital = await acc(c, '3100');
    await c.post('/api/journal', { date: '2026-01-01', post: true, lines: [{ accountId: bank, debit: 500_000 * K, credit: 0 }, { accountId: capital, debit: 0, credit: 500_000 * K }] });
  });
  after(() => c.close());

  test('engine: straight line and declining balance never go below the residual value', () => {
    const sl = schedule({ cost: 120_000, residual: 12_000, lifeMonths: 60, method: 'straight_line', startMonth: '2026-01' });
    assert.equal(sl.length, 60);
    assert.equal(sl[0].amount, 1800);
    assert.equal(sl.at(-1)!.bookValue, 12_000);
    const db = schedule({ cost: 36_000, residual: 1_000, lifeMonths: 36, method: 'declining', startMonth: '2026-01' });
    assert.equal(db[0].amount, 2000, 'book value × 2/3 a year ÷ 12');
    assert.ok(db[1].amount < db[0].amount, 'falls as the book value falls');
    assert.equal(db.reduce((s, r) => s + r.amount, 0), 35_000);
    assert.equal(db.at(-1)!.bookValue, 1_000);
    const mid = schedule({ cost: 120_000, residual: 0, lifeMonths: 60, method: 'straight_line', startMonth: '2026-01', openingAccumulated: 60_000, openingMonths: 30 });
    assert.equal(mid.length, 30, 'an asset brought in half-used keeps its remaining life');
    assert.equal(mid[0].amount, 2000);
    assert.equal(addMonth('2026-11', 3), '2027-02');
  });

  test('categories come from the chart; registering can book the purchase', async () => {
    const cats = await c.get('/api/assets/categories');
    assert.equal(cats.length, 3);
    vehiclesCat = cats.find((x: any) => x.asset_account_id === vehicles).id;
    const bad = await c.raw('POST', '/api/assets', { name: 'x', categoryId: vehiclesCat, acquisitionDate: '2026-01-10', cost: 100, residual: 100, lifeMonths: 60, method: 'straight_line' });
    assert.equal(bad.body.error.code, 'assets.residual');
    van = (
      await c.post('/api/assets', {
        name: 'Delivery van', categoryId: vehiclesCat, acquisitionDate: '2026-01-10', cost: 120_000 * K, residual: 12_000 * K, lifeMonths: 60, method: 'straight_line',
        acquisition: { counterAccountId: bank },
      })
    ).id;
    const v = await c.get(`/api/assets/${van}`);
    assert.equal(v.code, 'FA-00001');
    assert.equal(v.monthly, 1_800 * K);
    assert.equal(await balance(vehicles), 120_000 * K);
  });

  test('monthly runs catch up missed months in one entry', async () => {
    const p = await c.get('/api/assets/depreciation/preview?month=2026-01');
    assert.equal(p.total, 1_800 * K);
    await c.post('/api/assets/depreciation/run', { month: '2026-01' });
    const again = await c.raw('POST', '/api/assets/depreciation/run', { month: '2026-01' });
    assert.equal(again.body.error.code, 'assets.run_exists');
    const r = await c.post('/api/assets/depreciation/run', { month: '2026-03' });
    assert.equal(r.total, 3_600 * K, 'February and March');
    assert.equal(await balance(depExp), 5_400 * K);
    assert.equal(await balance(accum), -5_400 * K);
    const locked = await c.raw('PUT', `/api/assets/${van}`, { name: 'Van', categoryId: vehiclesCat, acquisitionDate: '2026-01-10', cost: 1, residual: 0, lifeMonths: 60, method: 'straight_line' });
    assert.equal(locked.body.error.code, 'assets.locked');
  });

  test('disposal charges depreciation to the month of sale and books the loss', async () => {
    const d = await c.post(`/api/assets/${van}/dispose`, { date: '2026-05-20', proceeds: 100_000 * K, proceedsAccountId: bank });
    assert.equal(d.status, 'disposed');
    assert.equal(d.accumulated, 9_000 * K);
    assert.equal(d.gain, -11_000 * K);
    assert.equal(await balance(vehicles), 0);
    assert.equal(await balance(accum), 0);
    assert.equal(await balance(depExp), 9_000 * K);
    const s = await c.get('/api/assets/depreciation/preview?month=2026-06');
    assert.equal(s.total, 0, 'a disposed asset is not depreciated any more');
  });

  test('roll-forward reconciles cost and depreciation for the year', async () => {
    const r = await c.get('/api/assets/report?from=2026-01-01&to=2026-12-31');
    const v = r.rows.find((x: any) => x.id === vehiclesCat);
    assert.equal(v.additions, 120_000 * K);
    assert.equal(v.disposals, 120_000 * K);
    assert.equal(v.costClosing, 0);
    assert.equal(v.charge, 9_000 * K);
    assert.equal(v.accDisposals, 9_000 * K);
    assert.equal(v.accClosing, 0);
    const q2 = await c.get('/api/assets/report?from=2026-04-01&to=2026-06-30');
    const w = q2.rows.find((x: any) => x.id === vehiclesCat);
    assert.equal(w.costOpening, 120_000 * K);
    assert.equal(w.accOpening, 5_400 * K);
    assert.equal(w.accOpening + w.charge - w.accDisposals, w.accClosing);
  });

  test('undo: a run before a disposal waits for the disposal to be undone first', async () => {
    const runs = await c.get('/api/assets/depreciation/runs');
    const march = runs.find((x: any) => x.month === '2026-03');
    const blocked = await c.raw('POST', `/api/assets/depreciation/runs/${march.id}/undo`);
    assert.equal(blocked.body.error.code, 'assets.disposed_after');
    await c.post(`/api/assets/${van}/undo-disposal`);
    await c.post(`/api/assets/depreciation/runs/${march.id}/undo`);
    assert.equal(await balance(accum), -1_800 * K);
    assert.equal(await balance(vehicles), 120_000 * K);
    const del = await c.raw('DELETE', `/api/assets/${van}`);
    assert.equal(del.body.error.code, 'assets.in_books');
  });
});
