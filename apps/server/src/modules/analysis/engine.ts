/**
 * The analysis engine: pure functions from statement figures to ratios, scores and findings.
 * No database here — everything is testable with hand-worked numbers.
 *
 * Conventions
 *  - Money in minor units (integers); ratios as plain numbers (0.25 = 25 %).
 *  - Balances used against a flow (turnover, returns) are averages of opening and closing;
 *    when there is no opening (first period) the closing balance is used and flagged.
 *  - "Days" measures use the number of days in the period, so they need no annualising;
 *    turnovers and returns are also given annualised (× 365 ÷ days) for periods under a year.
 *  - A ratio that cannot be computed returns `value: null` and a `reason` instead of ∞ or NaN.
 */

export interface BalanceFigures {
  cash: number;
  marketableSecurities: number;
  receivables: number;
  inventory: number;
  currentAssets: number;
  fixedAssetsNet: number;
  assets: number;
  payables: number;
  shortTermDebt: number;
  currentLiabilities: number;
  nonCurrentLiabilities: number;
  liabilities: number;
  retainedEarnings: number;
  equity: number;
}

export interface Snapshot {
  from: string;
  to: string;
  days: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  depreciation: number;
  operatingProfit: number;
  otherIncome: number;
  otherExpenses: number;
  ebit: number;
  ebitda: number;
  interestExpense: number;
  profitBeforeTax: number;
  incomeTax: number;
  netProfit: number;
  /** Costs that move with sales (cost of sales and operating costs, by each account's variable share). */
  variableCosts: number;
  /** Operating costs that do not (cost of sales + operating expenses − variable). */
  fixedCosts: number;
  /** Rent / lease expense (accounts tagged "lease") — a fixed charge. */
  leaseExpense: number;
  operatingCashFlow: number;
  capex: number;
  dividends: number;
  begin: BalanceFigures;
  end: BalanceFigures;
  /** True when there were no balances before the period (averages use closing balances). */
  noOpening: boolean;
}

export interface MarketData {
  sharesOutstanding: number | null;
  /** Share price in minor units. */
  sharePrice: number | null;
  preferredDividends: number;
}

export type RatioGroup = 'liquidity' | 'solvency' | 'activity' | 'profitability' | 'cashflow' | 'leverage' | 'market';
export type Unit = 'x' | 'pct' | 'days' | 'money' | 'score';
export type Status = 'good' | 'watch' | 'risk' | 'info' | 'na';

export interface Ratio {
  key: string;
  group: RatioGroup;
  unit: Unit;
  value: number | null;
  /** Same ratio for the comparison period, when there is one. */
  previous?: number | null;
  /** Annualised value for turnovers/returns when the period is shorter than a year. */
  annualized?: number | null;
  status: Status;
  /** Why the value is missing or not meaningful (i18n key under analysis.reasons). */
  reason?: string;
}

const avg = (a: number, b: number, noOpening: boolean) => (noOpening ? b : (a + b) / 2);

/** Ratio helper: a / b, or a reason when b is zero or the sign makes it meaningless. */
function div(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

/** Thresholds: higher is better unless `lowerIsBetter`. */
function grade(v: number | null, good: number, watch: number, lowerIsBetter = false): Status {
  if (v == null) return 'na';
  if (lowerIsBetter) return v <= good ? 'good' : v <= watch ? 'watch' : 'risk';
  return v >= good ? 'good' : v >= watch ? 'watch' : 'risk';
}

export function interestBearingDebt(b: BalanceFigures): number {
  // Short-term borrowings plus non-current liabilities (for small companies these are loans).
  return b.shortTermDebt + b.nonCurrentLiabilities;
}

export function computeRatios(s: Snapshot, m: MarketData): Ratio[] {
  const e = s.end;
  const b = s.begin;
  const A = (k: keyof BalanceFigures) => avg(b[k], e[k], s.noOpening);
  const year = s.days > 0 ? 365 / s.days : 1;
  const annual = s.days < 360;
  const out: Ratio[] = [];
  const push = (r: Ratio) => out.push(r);
  const na = (key: string, group: RatioGroup, unit: Unit, reason: string): Ratio => ({ key, group, unit, value: null, status: 'na', reason });

  // ------------------------------------------------------------- liquidity
  const cl = e.currentLiabilities;
  const quick = e.cash + e.marketableSecurities + e.receivables;
  push({ key: 'workingCapital', group: 'liquidity', unit: 'money', value: e.currentAssets - cl, status: e.currentAssets - cl >= 0 ? 'good' : 'risk' });
  if (cl <= 0) {
    push(na('currentRatio', 'liquidity', 'x', 'noCurrentLiabilities'));
    push(na('quickRatio', 'liquidity', 'x', 'noCurrentLiabilities'));
    push(na('cashRatio', 'liquidity', 'x', 'noCurrentLiabilities'));
    push(na('ocfRatio', 'liquidity', 'x', 'noCurrentLiabilities'));
  } else {
    const cr = div(e.currentAssets, cl);
    push({ key: 'currentRatio', group: 'liquidity', unit: 'x', value: cr, status: grade(cr, 1.5, 1) });
    const qr = div(quick, cl);
    push({ key: 'quickRatio', group: 'liquidity', unit: 'x', value: qr, status: grade(qr, 1, 0.7) });
    const cash = div(e.cash + e.marketableSecurities, cl);
    push({ key: 'cashRatio', group: 'liquidity', unit: 'x', value: cash, status: grade(cash, 0.2, 0.1) });
    const ocf = div(s.operatingCashFlow, cl);
    push({ key: 'ocfRatio', group: 'liquidity', unit: 'x', value: ocf, status: grade(ocf, 1, 0.5) });
  }
  // Defensive interval: days the company could run on its quick assets (cash operating costs per day).
  const dailyCash = (s.cogs + s.operatingExpenses - s.depreciation) / Math.max(s.days, 1);
  push(dailyCash > 0 ? { key: 'defensiveInterval', group: 'liquidity', unit: 'days', value: quick / dailyCash, status: grade(quick / dailyCash, 90, 30) } : na('defensiveInterval', 'liquidity', 'days', 'noCosts'));

  // -------------------------------------------------------------- solvency
  const negEquity = e.equity <= 0;
  const debt = interestBearingDebt(e);
  const dr = div(e.liabilities, e.assets);
  push(e.assets > 0 ? { key: 'debtRatio', group: 'solvency', unit: 'pct', value: dr, status: grade(dr, 0.5, 0.7, true) } : na('debtRatio', 'solvency', 'pct', 'noAssets'));
  if (negEquity) {
    push(na('debtToEquity', 'solvency', 'x', 'negativeEquity'));
    push(na('longTermDebtToEquity', 'solvency', 'x', 'negativeEquity'));
    push(na('equityMultiplier', 'solvency', 'x', 'negativeEquity'));
  } else {
    const de = div(e.liabilities, e.equity);
    push({ key: 'debtToEquity', group: 'solvency', unit: 'x', value: de, status: grade(de, 1, 2, true) });
    const lde = div(e.nonCurrentLiabilities, e.equity);
    push({ key: 'longTermDebtToEquity', group: 'solvency', unit: 'x', value: lde, status: grade(lde, 0.5, 1, true) });
    const em = div(A('assets'), A('equity'));
    push({ key: 'equityMultiplier', group: 'solvency', unit: 'x', value: em, status: grade(em, 2, 3, true) });
  }
  const dc = debt + e.equity > 0 ? debt / (debt + e.equity) : null;
  push(dc == null ? na('debtToCapital', 'solvency', 'pct', 'negativeEquity') : { key: 'debtToCapital', group: 'solvency', unit: 'pct', value: dc, status: grade(dc, 0.4, 0.6, true) });
  if (s.interestExpense <= 0) push(na('timesInterestEarned', 'solvency', 'x', 'noInterest'));
  else {
    const tie = div(s.ebit, s.interestExpense);
    push({ key: 'timesInterestEarned', group: 'solvency', unit: 'x', value: tie, status: grade(tie, 5, 2) });
  }
  const charges = s.interestExpense + s.leaseExpense;
  if (charges <= 0) push(na('fixedChargeCoverage', 'solvency', 'x', 'noFixedCharges'));
  else {
    const fc = div(s.ebit + s.leaseExpense, charges);
    push({ key: 'fixedChargeCoverage', group: 'solvency', unit: 'x', value: fc, status: grade(fc, 2, 1.25) });
  }
  push(e.liabilities > 0 ? { key: 'cashFlowToDebt', group: 'solvency', unit: 'x', value: div(s.operatingCashFlow * year, e.liabilities), status: grade(div(s.operatingCashFlow * year, e.liabilities), 0.3, 0.15) } : na('cashFlowToDebt', 'solvency', 'x', 'noLiabilities'));

  // -------------------------------------------------------------- activity
  const purchases = s.cogs + e.inventory - b.inventory;
  const avgAR = A('receivables');
  const avgInv = A('inventory');
  const avgAP = A('payables');
  let dso: number | null = null;
  let dio: number | null = null;
  let dpo: number | null = null;
  if (s.revenue <= 0) {
    push(na('receivablesTurnover', 'activity', 'x', 'noRevenue'));
    push(na('dso', 'activity', 'days', 'noRevenue'));
  } else {
    const t = div(s.revenue, avgAR);
    push(avgAR > 0 ? { key: 'receivablesTurnover', group: 'activity', unit: 'x', value: t, annualized: annual && t != null ? t * year : undefined, status: 'info' } : na('receivablesTurnover', 'activity', 'x', 'noReceivables'));
    dso = (avgAR / s.revenue) * s.days;
    push({ key: 'dso', group: 'activity', unit: 'days', value: dso, status: grade(dso, 45, 75, true) });
  }
  if (avgInv <= 0 && s.cogs <= 0) {
    push(na('inventoryTurnover', 'activity', 'x', 'noInventory'));
    push(na('dio', 'activity', 'days', 'noInventory'));
  } else if (s.cogs <= 0) {
    push(na('inventoryTurnover', 'activity', 'x', 'noCogs'));
    push(na('dio', 'activity', 'days', 'noCogs'));
  } else {
    const t = div(s.cogs, avgInv);
    push(avgInv > 0 ? { key: 'inventoryTurnover', group: 'activity', unit: 'x', value: t, annualized: annual && t != null ? t * year : undefined, status: 'info' } : na('inventoryTurnover', 'activity', 'x', 'noInventory'));
    dio = (avgInv / s.cogs) * s.days;
    push({ key: 'dio', group: 'activity', unit: 'days', value: dio, status: avgInv > 0 ? grade(dio, 60, 120, true) : 'info' });
  }
  if (purchases <= 0) {
    push(na('payablesTurnover', 'activity', 'x', 'noPurchases'));
    push(na('dpo', 'activity', 'days', 'noPurchases'));
  } else {
    const t = div(purchases, avgAP);
    push(avgAP > 0 ? { key: 'payablesTurnover', group: 'activity', unit: 'x', value: t, annualized: annual && t != null ? t * year : undefined, status: 'info' } : na('payablesTurnover', 'activity', 'x', 'noPayables'));
    dpo = (avgAP / purchases) * s.days;
    push({ key: 'dpo', group: 'activity', unit: 'days', value: dpo, status: 'info' });
  }
  if (dso != null) {
    const opCycle = dso + (dio ?? 0);
    push({ key: 'operatingCycle', group: 'activity', unit: 'days', value: opCycle, status: grade(opCycle, 60, 120, true) });
    const ccc = opCycle - (dpo ?? 0);
    push({ key: 'cashConversionCycle', group: 'activity', unit: 'days', value: ccc, status: grade(ccc, 30, 90, true) });
  } else {
    push(na('operatingCycle', 'activity', 'days', 'noRevenue'));
    push(na('cashConversionCycle', 'activity', 'days', 'noRevenue'));
  }
  const at = div(s.revenue, A('assets'));
  push(A('assets') > 0 ? { key: 'assetTurnover', group: 'activity', unit: 'x', value: at, annualized: annual && at != null ? at * year : undefined, status: 'info' } : na('assetTurnover', 'activity', 'x', 'noAssets'));
  const fat = div(s.revenue, A('fixedAssetsNet'));
  push(A('fixedAssetsNet') > 0 ? { key: 'fixedAssetTurnover', group: 'activity', unit: 'x', value: fat, annualized: annual && fat != null ? fat * year : undefined, status: 'info' } : na('fixedAssetTurnover', 'activity', 'x', 'noFixedAssets'));
  const avgWc = avg(b.currentAssets - b.currentLiabilities, e.currentAssets - e.currentLiabilities, s.noOpening);
  push(avgWc > 0 ? { key: 'workingCapitalTurnover', group: 'activity', unit: 'x', value: div(s.revenue, avgWc), status: 'info' } : na('workingCapitalTurnover', 'activity', 'x', 'noWorkingCapital'));

  // --------------------------------------------------------- profitability
  if (s.revenue <= 0) {
    for (const k of ['grossMargin', 'operatingMargin', 'ebitdaMargin', 'netMargin']) push(na(k, 'profitability', 'pct', 'noRevenue'));
  } else {
    const gm = s.grossProfit / s.revenue;
    push({ key: 'grossMargin', group: 'profitability', unit: 'pct', value: gm, status: grade(gm, 0.3, 0.1) });
    const om = s.operatingProfit / s.revenue;
    push({ key: 'operatingMargin', group: 'profitability', unit: 'pct', value: om, status: grade(om, 0.1, 0) });
    push({ key: 'ebitdaMargin', group: 'profitability', unit: 'pct', value: s.ebitda / s.revenue, status: grade(s.ebitda / s.revenue, 0.15, 0) });
    const nm = s.netProfit / s.revenue;
    push({ key: 'netMargin', group: 'profitability', unit: 'pct', value: nm, status: grade(nm, 0.1, 0) });
  }
  const roa = div(s.netProfit, A('assets'));
  push(A('assets') > 0 ? { key: 'roa', group: 'profitability', unit: 'pct', value: roa, annualized: annual && roa != null ? roa * year : undefined, status: grade(roa != null ? roa * year : null, 0.05, 0) } : na('roa', 'profitability', 'pct', 'noAssets'));
  if (A('equity') <= 0) push(na('roe', 'profitability', 'pct', 'negativeEquity'));
  else {
    const roe = s.netProfit / A('equity');
    push({ key: 'roe', group: 'profitability', unit: 'pct', value: roe, annualized: annual ? roe * year : undefined, status: grade(roe * year, 0.15, 0) });
  }
  const taxRate = s.profitBeforeTax > 0 ? Math.min(Math.max(s.incomeTax / s.profitBeforeTax, 0), 1) : 0;
  const investedCapital = avg(interestBearingDebt(b) + b.equity, interestBearingDebt(e) + e.equity, s.noOpening);
  if (investedCapital <= 0) push(na('roic', 'profitability', 'pct', 'negativeEquity'));
  else {
    const roic = (s.ebit * (1 - taxRate)) / investedCapital;
    push({ key: 'roic', group: 'profitability', unit: 'pct', value: roic, annualized: annual ? roic * year : undefined, status: grade(roic * year, 0.1, 0) });
  }

  // -------------------------------------------------- cash flow & growth
  if (s.netProfit <= 0) push(na('earningsQuality', 'cashflow', 'x', s.netProfit === 0 ? 'noProfit' : 'loss'));
  else {
    const q = s.operatingCashFlow / s.netProfit;
    push({ key: 'earningsQuality', group: 'cashflow', unit: 'x', value: q, status: grade(q, 1, 0.5) });
  }
  const fcf = s.operatingCashFlow - s.capex;
  push({ key: 'freeCashFlow', group: 'cashflow', unit: 'money', value: fcf, status: fcf >= 0 ? 'good' : 'watch' });
  push(A('assets') > 0 ? { key: 'accrualsRatio', group: 'cashflow', unit: 'pct', value: (s.netProfit - s.operatingCashFlow) / A('assets'), status: grade((s.netProfit - s.operatingCashFlow) / A('assets'), 0.05, 0.1, true) } : na('accrualsRatio', 'cashflow', 'pct', 'noAssets'));
  if (s.netProfit <= 0) {
    push(na('payoutRatio', 'cashflow', 'pct', 'loss'));
    push(na('sustainableGrowth', 'cashflow', 'pct', 'loss'));
  } else {
    const payout = s.dividends / s.netProfit;
    push({ key: 'payoutRatio', group: 'cashflow', unit: 'pct', value: payout, status: 'info' });
    const roeAnnual = A('equity') > 0 ? (s.netProfit / A('equity')) * (annual ? year : 1) : null;
    push(roeAnnual == null ? na('sustainableGrowth', 'cashflow', 'pct', 'negativeEquity') : { key: 'sustainableGrowth', group: 'cashflow', unit: 'pct', value: roeAnnual * (1 - Math.min(payout, 1)), status: 'info' });
  }

  // ---------------------------------------------- leverage & break-even
  const cm = s.revenue - s.variableCosts;
  const cmRatio = s.revenue > 0 ? cm / s.revenue : null;
  push({ key: 'contributionMargin', group: 'leverage', unit: 'money', value: cm, status: cm > 0 ? 'good' : 'risk' });
  push(cmRatio == null ? na('contributionMarginRatio', 'leverage', 'pct', 'noRevenue') : { key: 'contributionMarginRatio', group: 'leverage', unit: 'pct', value: cmRatio, status: 'info' });
  if (cmRatio == null || cmRatio <= 0) {
    push(na('breakEvenRevenue', 'leverage', 'money', cmRatio == null ? 'noRevenue' : 'noContribution'));
    push(na('marginOfSafety', 'leverage', 'pct', cmRatio == null ? 'noRevenue' : 'noContribution'));
  } else {
    const be = s.fixedCosts / cmRatio;
    push({ key: 'breakEvenRevenue', group: 'leverage', unit: 'money', value: Math.round(be), status: s.revenue >= be ? 'good' : 'risk' });
    const mos = (s.revenue - be) / s.revenue;
    push({ key: 'marginOfSafety', group: 'leverage', unit: 'pct', value: mos, status: grade(mos, 0.2, 0) });
  }
  // Operating profit for leverage = contribution − fixed costs (= operating profit).
  if (s.operatingProfit <= 0) push(na('dol', 'leverage', 'x', 'belowBreakEven'));
  else push({ key: 'dol', group: 'leverage', unit: 'x', value: cm / s.operatingProfit, status: grade(cm / s.operatingProfit, 3, 6, true) });
  if (s.profitBeforeTax <= 0) push(na('dfl', 'leverage', 'x', 'noProfit'));
  else push({ key: 'dfl', group: 'leverage', unit: 'x', value: s.ebit / s.profitBeforeTax, status: grade(s.ebit / s.profitBeforeTax, 1.5, 2.5, true) });
  const dol = out.find((r) => r.key === 'dol')!.value;
  const dfl = out.find((r) => r.key === 'dfl')!.value;
  push(dol != null && dfl != null ? { key: 'dtl', group: 'leverage', unit: 'x', value: dol * dfl, status: 'info' } : na('dtl', 'leverage', 'x', 'belowBreakEven'));

  // --------------------------------------------------------------- market
  if (!m.sharesOutstanding) push(na('eps', 'market', 'money', 'noShares'));
  else {
    const eps = (s.netProfit - m.preferredDividends) / m.sharesOutstanding;
    push({ key: 'eps', group: 'market', unit: 'money', value: eps, annualized: annual ? eps * year : undefined, status: eps > 0 ? 'good' : 'risk' });
    push({ key: 'bookValuePerShare', group: 'market', unit: 'money', value: e.equity / m.sharesOutstanding, status: e.equity > 0 ? 'info' : 'risk' });
    if (m.sharePrice) {
      const epsYear = eps * (annual ? year : 1);
      push(epsYear > 0 ? { key: 'priceEarnings', group: 'market', unit: 'x', value: m.sharePrice / epsYear, status: 'info' } : na('priceEarnings', 'market', 'x', 'loss'));
      push(e.equity > 0 ? { key: 'priceToBook', group: 'market', unit: 'x', value: m.sharePrice / (e.equity / m.sharesOutstanding), status: 'info' } : na('priceToBook', 'market', 'x', 'negativeEquity'));
      push({ key: 'dividendYield', group: 'market', unit: 'pct', value: (s.dividends * (annual ? year : 1)) / m.sharesOutstanding / m.sharePrice, status: 'info' });
      push({ key: 'earningsYield', group: 'market', unit: 'pct', value: epsYear / m.sharePrice, status: 'info' });
    } else push(na('priceEarnings', 'market', 'x', 'noPrice'));
  }
  return out;
}

/** DuPont: ROE = net margin × asset turnover × equity multiplier; 5 parts split the margin into tax burden, interest burden and EBIT margin. */
export function dupont(s: Snapshot) {
  const A = (k: keyof BalanceFigures) => avg(s.begin[k], s.end[k], s.noOpening);
  if (s.revenue <= 0 || A('assets') <= 0 || A('equity') <= 0) return null;
  const netMargin = s.netProfit / s.revenue;
  const assetTurnover = s.revenue / A('assets');
  const equityMultiplier = A('assets') / A('equity');
  return {
    netMargin,
    assetTurnover,
    equityMultiplier,
    roe: netMargin * assetTurnover * equityMultiplier,
    taxBurden: s.profitBeforeTax !== 0 ? s.netProfit / s.profitBeforeTax : null,
    interestBurden: s.ebit !== 0 ? s.profitBeforeTax / s.ebit : null,
    ebitMargin: s.ebit / s.revenue,
  };
}

/** Altman Z'' (private, non-manufacturing, 1995): 6.56 X1 + 3.26 X2 + 6.72 X3 + 1.05 X4. */
export function zScore(s: Snapshot) {
  const e = s.end;
  if (e.assets <= 0) return null;
  const x1 = (e.currentAssets - e.currentLiabilities) / e.assets;
  const x2 = e.retainedEarnings / e.assets;
  // EBIT is a yearly figure in the model: annualise shorter periods.
  const x3 = (s.ebit * (s.days < 360 ? 365 / s.days : 1)) / e.assets;
  const x4 = e.liabilities > 0 ? e.equity / e.liabilities : 10; // no debt: capped high
  const z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * Math.min(x4, 10);
  return { z, x1, x2, x3, x4, zone: z > 2.6 ? 'safe' : z >= 1.1 ? 'grey' : 'distress' } as const;
}

export interface Finding {
  key: string;
  severity: 'risk' | 'watch' | 'good';
  params?: Record<string, number | string>;
}

/** Plain-language findings, most important first (the "accountant's notes"). */
export function findings(s: Snapshot, ratios: Ratio[], prev: Snapshot | null, z: ReturnType<typeof zScore>): Finding[] {
  const r = (k: string) => ratios.find((x) => x.key === k)?.value ?? null;
  const out: Finding[] = [];
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const round = (v: number) => Math.round(v);
  if (s.end.equity <= 0) out.push({ key: 'negativeEquity', severity: 'risk' });
  if (s.netProfit < 0) out.push({ key: 'loss', severity: 'risk', params: { amount: -s.netProfit } });
  const cr = r('currentRatio');
  if (cr != null && cr < 1) out.push({ key: 'liquidityRisk', severity: 'risk', params: { ratio: Math.round(cr * 100) / 100 } });
  const be = r('breakEvenRevenue');
  if (be != null && s.revenue < be) out.push({ key: 'belowBreakEven', severity: 'risk', params: { breakEven: be, gap: be - s.revenue } });
  if (z?.zone === 'distress') out.push({ key: 'distress', severity: 'risk', params: { z: Math.round(z.z * 100) / 100 } });
  const tie = r('timesInterestEarned');
  if (tie != null && tie < 2) out.push({ key: 'interestCover', severity: 'risk', params: { times: Math.round(tie * 10) / 10 } });
  const de = r('debtToEquity');
  if (de != null && de > 2) out.push({ key: 'highLeverage', severity: 'watch', params: { ratio: Math.round(de * 10) / 10 } });
  const dso = r('dso');
  const dpo = r('dpo');
  if (dso != null && dpo != null && dso > dpo + 15) out.push({ key: 'financingCustomers', severity: 'watch', params: { dso: round(dso), dpo: round(dpo), gap: round(dso - dpo) } });
  else if (dso != null && dso > 75) out.push({ key: 'slowCollection', severity: 'watch', params: { dso: round(dso) } });
  const dio = r('dio');
  if (dio != null && dio > 120 && s.end.inventory > 0) out.push({ key: 'slowInventory', severity: 'watch', params: { dio: round(dio) } });
  const q = r('earningsQuality');
  if (q != null && q >= 0 && q < 0.5) out.push({ key: 'cashPoorProfit', severity: 'watch', params: { ratio: Math.round(q * 100) / 100 } });
  const mos = r('marginOfSafety');
  if (mos != null && mos >= 0 && mos < 0.1) out.push({ key: 'thinSafety', severity: 'watch', params: { pct: pct(mos) } });
  if (z?.zone === 'grey') out.push({ key: 'greyZone', severity: 'watch', params: { z: Math.round(z.z * 100) / 100 } });
  if (prev && prev.revenue > 0 && s.revenue > 0) {
    const g = (s.revenue - prev.revenue) / prev.revenue;
    if (g <= -0.1) out.push({ key: 'revenueDown', severity: 'watch', params: { pct: pct(-g) } });
    if (g >= 0.1) out.push({ key: 'revenueUp', severity: 'good', params: { pct: pct(g) } });
    const gmNow = s.grossProfit / s.revenue;
    const gmPrev = prev.grossProfit / prev.revenue;
    if (gmPrev - gmNow >= 0.05) out.push({ key: 'marginDown', severity: 'watch', params: { from: pct(gmPrev), to: pct(gmNow) } });
  }
  if (s.operatingCashFlow < 0 && s.netProfit > 0) out.push({ key: 'negativeCfo', severity: 'watch', params: { amount: -s.operatingCashFlow } });
  const roe = ratios.find((x) => x.key === 'roe');
  const roeY = roe?.annualized ?? roe?.value ?? null;
  if (roeY != null && roeY >= 0.15 && s.netProfit > 0) out.push({ key: 'strongReturn', severity: 'good', params: { pct: pct(roeY) } });
  if (cr != null && cr >= 1.5 && (de == null || de <= 1)) out.push({ key: 'solidBalance', severity: 'good', params: { ratio: Math.round(cr * 100) / 100 } });
  const order = { risk: 0, watch: 1, good: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
