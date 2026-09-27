import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { acc, setupCompany, type TestClient } from './helpers.js';

/**
 * A hand-worked company for 2026 (amounts in EGP):
 *   capital 500,000; loan 200,000 (long term); equipment 300,000; depreciation 30,000
 *   revenue 1,000,000 on credit, 800,000 collected; cost of sales 600,000 paid
 *   stock bought on credit 100,000 (unpaid); rent 60,000 (lease); salaries 100,000
 *   interest 20,000; income tax 40,000 (unpaid); dividends 50,000
 * → gross profit 400,000; EBIT 210,000; profit before tax 190,000; net profit 150,000
 * → assets 940,000 = liabilities 340,000 + equity 600,000; operating cash flow 20,000
 */
describe('financial analysis', () => {
  let c: TestClient;
  const K = 100; // minor units
  const close = (a: number | null | undefined, b: number, eps = 1e-4) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≈ ${b}`);
  let data: any;
  const ratio = (k: string) => data.ratios.find((r: any) => r.key === k);

  before(async () => {
    c = await setupCompany({ vatRateBp: null });
    const [bank, ar, inv, equip, accDep, ap, taxPay, loan, capital, divs, sales, cogs, rent, salaries, dep, interest, tax] = await Promise.all(
      ['1120', '1130', '1140', '1210', '1290', '2110', '2180', '2210', '3100', '3400', '4100', '5100', '5220', '5210', '5290', '5700', '5950'].map((x) => acc(c, x)),
    );
    const customer = (await c.post('/api/parties', { kind: 'customer', name: 'Buyer' })).id;
    const supplier = (await c.post('/api/parties', { kind: 'supplier', name: 'Maker' })).id;
    const je = (date: string, lines: [number, number, number, number?][]) =>
      c.post('/api/journal', { date, post: true, lines: lines.map(([accountId, debit, credit, partyId]) => ({ accountId, debit: debit * K, credit: credit * K, partyId })) });
    await je('2026-01-01', [[bank, 500_000, 0], [capital, 0, 500_000]]);
    await je('2026-01-01', [[bank, 200_000, 0], [loan, 0, 200_000]]);
    await je('2026-01-02', [[equip, 300_000, 0], [bank, 0, 300_000]]);
    await je('2026-03-01', [[ar, 1_000_000, 0, customer], [sales, 0, 1_000_000]]);
    await je('2026-03-02', [[cogs, 600_000, 0], [bank, 0, 600_000]]);
    await je('2026-04-01', [[inv, 100_000, 0], [ap, 0, 100_000, supplier]]);
    await je('2026-05-01', [[rent, 60_000, 0], [salaries, 100_000, 0], [bank, 0, 160_000]]);
    await je('2026-06-01', [[dep, 30_000, 0], [accDep, 0, 30_000]]);
    await je('2026-06-02', [[interest, 20_000, 0], [bank, 0, 20_000]]);
    await je('2026-07-01', [[bank, 800_000, 0], [ar, 0, 800_000, customer]]);
    await je('2026-12-31', [[tax, 40_000, 0], [taxPay, 0, 40_000]]);
    await je('2026-12-31', [[divs, 50_000, 0], [bank, 0, 50_000]]);
    await c.put('/api/analysis/settings', { sharesOutstanding: 10_000, sharePrice: 120 * K, preferredDividends: 0 });
    data = await c.get('/api/analysis?from=2026-01-01&to=2026-12-31&compare=none');
  });
  after(() => c.close());

  test('statements feeding the analysis: EBIT, EBT, tax, net profit, EBITDA, cash flow', () => {
    const s = data.snapshot;
    assert.equal(s.revenue, 1_000_000 * K);
    assert.equal(s.grossProfit, 400_000 * K);
    assert.equal(s.operatingProfit, 210_000 * K);
    assert.equal(s.ebit, 210_000 * K);
    assert.equal(s.ebitda, 240_000 * K);
    assert.equal(s.profitBeforeTax, 190_000 * K);
    assert.equal(s.netProfit, 150_000 * K);
    assert.equal(s.end.assets, 940_000 * K);
    assert.equal(s.end.liabilities, 340_000 * K);
    assert.equal(s.end.equity, 600_000 * K);
    assert.equal(s.operatingCashFlow, 20_000 * K);
    assert.equal(s.capex, 300_000 * K);
    assert.equal(s.dividends, 50_000 * K);
    assert.equal(s.leaseExpense, 60_000 * K);
    assert.equal(s.noOpening, true, 'first year: averages fall back to closing balances');
  });

  test('liquidity and solvency', () => {
    close(ratio('currentRatio').value, 670 / 140);
    close(ratio('quickRatio').value, 570 / 140);
    close(ratio('cashRatio').value, 370 / 140);
    close(ratio('debtRatio').value, 340 / 940);
    close(ratio('debtToEquity').value, 340 / 600);
    close(ratio('timesInterestEarned').value, 10.5);
    close(ratio('fixedChargeCoverage').value, 270 / 80);
    assert.equal(ratio('workingCapital').value, 530_000 * K);
  });

  test('activity: days and the cash conversion cycle', () => {
    close(ratio('dso').value, 73);
    close(ratio('dio').value, (100 / 600) * 365);
    close(ratio('dpo').value, (100 / 700) * 365);
    close(ratio('cashConversionCycle').value, 73 + (100 / 600) * 365 - (100 / 700) * 365);
    close(ratio('assetTurnover').value, 1000 / 940);
  });

  test('profitability, DuPont and return on invested capital', () => {
    close(ratio('grossMargin').value, 0.4);
    close(ratio('operatingMargin').value, 0.21);
    close(ratio('netMargin').value, 0.15);
    close(ratio('roa').value, 150 / 940);
    close(ratio('roe').value, 0.25);
    close(ratio('roic').value, (210 * (1 - 40 / 190)) / 800);
    close(data.dupont.roe, 0.25);
    close(data.dupont.netMargin * data.dupont.assetTurnover * data.dupont.equityMultiplier, 0.25);
    close(data.dupont.taxBurden * data.dupont.interestBurden * data.dupont.ebitMargin, 0.15);
  });

  test('cash quality, payout and sustainable growth', () => {
    close(ratio('earningsQuality').value, 20 / 150);
    assert.equal(ratio('freeCashFlow').value, (20_000 - 300_000) * K);
    close(ratio('payoutRatio').value, 1 / 3);
    close(ratio('sustainableGrowth').value, 0.25 * (2 / 3));
  });

  test('break-even and leverage (cost of sales variable, the rest fixed)', () => {
    assert.equal(ratio('contributionMargin').value, 400_000 * K);
    close(ratio('contributionMarginRatio').value, 0.4);
    assert.equal(ratio('breakEvenRevenue').value, 475_000 * K);
    close(ratio('marginOfSafety').value, 0.525);
    close(ratio('dol').value, 400 / 210);
    close(ratio('dfl').value, 210 / 190);
    close(ratio('dtl').value, (400 / 210) * (210 / 190));
  });

  test('market ratios from the share data', () => {
    assert.equal(ratio('eps').value, 15 * K);
    close(ratio('priceEarnings').value, 8);
    assert.equal(ratio('bookValuePerShare').value, 60 * K);
  });

  test('distress score and the accountant’s notes', () => {
    close(data.zScore.z, 6.56 * (530 / 940) + 3.26 * (150 / 940) + 6.72 * (210 / 940) + 1.05 * (600 / 340), 1e-3);
    assert.equal(data.zScore.zone, 'safe');
    const keys = data.findings.map((f: any) => f.key);
    assert.ok(keys.includes('cashPoorProfit'), 'profit that did not turn into cash is flagged');
    assert.ok(keys.includes('strongReturn'));
    const dq = data.dataQuality.map((d: any) => d.key);
    assert.ok(dq.includes('defaultCostBehaviour'));
    assert.ok(dq.includes('noOpening'));
  });

  test('changing an account’s cost behaviour moves the break-even', async () => {
    const salaries = await acc(c, '5210');
    const a = (await c.get('/api/accounts')).find((x: any) => x.id === salaries);
    await c.put(`/api/accounts/${salaries}`, { code: a.code, nameEn: a.name_en, nameAr: a.name_ar, type: a.type, subtype: a.subtype, parentId: a.parent_id, variableBp: 5000 });
    const d = await c.get('/api/analysis?from=2026-01-01&to=2026-12-31&compare=none');
    // Variable 650,000 → CM 350,000 (35 %); fixed 140,000 → break-even 400,000.
    assert.equal(d.ratios.find((r: any) => r.key === 'breakEvenRevenue').value, 400_000 * K);
    const be = await c.get('/api/analysis/break-even?from=2026-01-01&to=2026-12-31&targetProfit=' + 70_000 * K + '&priceChangeBp=1000');
    assert.equal(be.targetRevenue, 600_000 * K);
    assert.equal(be.scenario.revenue, 1_100_000 * K);
    assert.equal(be.scenario.operatingProfit, (1_100_000 - 650_000 - 140_000) * K);
  });

  test('trend: one row per month', async () => {
    const t = await c.get('/api/analysis/trend?to=2026-12-31&months=12');
    assert.equal(t.length, 12);
    assert.equal(t[2].revenue, 1_000_000 * K);
  });

  test('edge cases: an empty company gives reasons, not errors', async () => {
    const e = await setupCompany();
    const d = await e.get('/api/analysis?from=2026-01-01&to=2026-12-31');
    const r = (k: string) => d.ratios.find((x: any) => x.key === k);
    assert.equal(r('currentRatio').value, null);
    assert.equal(r('currentRatio').reason, 'noCurrentLiabilities');
    assert.equal(r('grossMargin').reason, 'noRevenue');
    assert.equal(r('timesInterestEarned').reason, 'noInterest');
    assert.equal(r('eps').reason, 'noShares');
    assert.ok(d.ratios.every((x: any) => x.value == null || Number.isFinite(x.value)), 'no infinities or NaN');
    await e.close();
  });

  test('edge cases: negative equity and a loss', async () => {
    const e = await setupCompany({ vatRateBp: null });
    const [bank, loan, capital, rent] = await Promise.all(['1120', '2210', '3100', '5220'].map((x) => acc(e, x)));
    await e.post('/api/journal', { date: '2026-01-01', post: true, lines: [{ accountId: bank, debit: 10_000 * K }, { accountId: capital, credit: 10_000 * K }] });
    await e.post('/api/journal', { date: '2026-01-02', post: true, lines: [{ accountId: bank, debit: 50_000 * K }, { accountId: loan, credit: 50_000 * K }] });
    await e.post('/api/journal', { date: '2026-02-01', post: true, lines: [{ accountId: rent, debit: 30_000 * K }, { accountId: bank, credit: 30_000 * K }] });
    const d = await e.get('/api/analysis?from=2026-01-01&to=2026-12-31');
    const r = (k: string) => d.ratios.find((x: any) => x.key === k);
    assert.equal(r('roe').reason, 'negativeEquity');
    assert.equal(r('debtToEquity').reason, 'negativeEquity');
    assert.equal(r('earningsQuality').reason, 'loss');
    const keys = d.findings.map((f: any) => f.key);
    assert.ok(keys.includes('negativeEquity'));
    assert.ok(keys.includes('loss'));
    assert.equal(d.findings[0].severity, 'risk', 'risks come first');
    assert.ok(d.dataQuality.some((q: any) => q.key === 'loansWithoutInterest'));
    await e.close();
  });

  test('statement of changes in equity reconciles to the balance sheet', async () => {
    const eq = await c.get('/api/reports/equity-changes?from=2026-01-01&to=2026-12-31');
    assert.equal(eq.reconciled, true);
    const closing = eq.lines.find((l: any) => l.key === 'closing');
    assert.equal(closing.total, 600_000 * K);
    assert.equal(eq.lines.find((l: any) => l.key === 'dividends').total, -50_000 * K);
  });
});
