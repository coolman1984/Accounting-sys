import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { addDays, addMonths, daysBetween, endOfMonth, startOfMonth, today } from '../../kernel/dates.js';
import { parse, zDate } from '../../kernel/validate.js';
import { createStatements } from '../ledger/statements.js';
import type { Movement } from '../ledger/service.js';
import { computeRatios, dupont, findings, zScore, type BalanceFigures, type MarketData, type Snapshot } from './engine.js';

/** Company data the books do not hold (for market ratios). */
interface AnalysisSettings {
  sharesOutstanding: number | null;
  sharePrice: number | null;
  preferredDividends: number;
}
const DEFAULT_SETTINGS: AnalysisSettings = { sharesOutstanding: null, sharePrice: null, preferredDividends: 0 };

function createAnalysis(ctx: ModuleContext) {
  const { services } = ctx;
  const st = createStatements(ctx);
  const ledger = () => services.get('ledger');

  const balance = (asOf: string): BalanceFigures => {
    const t = st.balanceSheet(asOf).totals;
    return {
      cash: t.cash,
      marketableSecurities: t.marketableSecurities,
      receivables: t.receivables,
      inventory: t.inventory,
      currentAssets: t.currentAssets,
      fixedAssetsNet: t.fixedAssetsNet,
      assets: t.assets,
      payables: t.payables,
      shortTermDebt: t.shortTermDebt,
      currentLiabilities: t.currentLiabilities,
      nonCurrentLiabilities: t.nonCurrentLiabilities,
      liabilities: t.liabilities,
      retainedEarnings: t.retainedEarnings,
      equity: t.equity,
    };
  };

  /** Everything the engine needs for one period, straight from the ledger. */
  function snapshot(from: string, to: string): Snapshot {
    const is = st.incomeStatement(from, to).totals;
    const cf = st.cashFlow(from, to);
    const accts = ledger().accounts().filter((a) => !a.is_group);
    const mv = ledger().movements({ from, to, excludeClosing: true });
    const net = (m?: Movement) => (m ? m.debit - m.credit : 0);
    // Cost behaviour: each operating cost account's variable share (default: cost of sales variable, the rest fixed).
    let variable = 0;
    let lease = 0;
    for (const a of accts) {
      if (a.type !== 'expense') continue;
      const amt = net(mv.get(a.id));
      if (a.analysis_tag === 'lease') lease += amt;
      if (!['cogs', 'operating_expense', 'depreciation'].includes(a.subtype)) continue;
      const bp = a.variable_bp ?? (a.subtype === 'cogs' ? 10000 : 0);
      variable += (amt * bp) / 10000;
    }
    const operatingCosts = is.cogs + is.operatingExpenses;
    const before = addDays(from, -1);
    const begin = balance(before);
    const noOpening = ledger().movements({ to: before }).size === 0;
    return {
      from,
      to,
      days: daysBetween(from, to) + 1,
      revenue: is.revenue,
      cogs: is.cogs,
      grossProfit: is.grossProfit,
      operatingExpenses: is.operatingExpenses,
      depreciation: is.depreciation,
      operatingProfit: is.operatingProfit,
      otherIncome: is.otherIncome,
      otherExpenses: is.otherExpenses,
      ebit: is.ebit,
      ebitda: is.ebitda,
      interestExpense: is.interestExpense,
      profitBeforeTax: is.profitBeforeTax,
      incomeTax: is.incomeTax,
      netProfit: is.netProfit,
      variableCosts: Math.round(variable),
      fixedCosts: Math.round(operatingCosts - variable),
      leaseExpense: lease,
      operatingCashFlow: cf.operating.total,
      capex: cf.capex,
      dividends: cf.dividends,
      begin,
      end: balance(to),
      noOpening,
    };
  }

  /**
   * Checks that decide whether the ratios can be trusted: a missing interest or tax
   * account, fixed assets without depreciation, no revenue… Each is advice, not an error.
   */
  function dataQuality(s: Snapshot): { key: string; params?: Record<string, number | string> }[] {
    const accts = ledger().accounts().filter((a) => !a.is_group);
    const out: { key: string; params?: Record<string, number | string> }[] = [];
    if (s.revenue <= 0) out.push({ key: 'noRevenue' });
    if (s.end.shortTermDebt + s.end.nonCurrentLiabilities > 0 && s.interestExpense === 0) out.push({ key: 'loansWithoutInterest' });
    if (!accts.some((a) => a.subtype === 'interest_expense')) out.push({ key: 'noInterestAccount' });
    if (s.profitBeforeTax > 0 && s.incomeTax === 0) out.push({ key: 'noIncomeTax' });
    if (s.end.fixedAssetsNet > 0 && s.depreciation === 0) out.push({ key: 'noDepreciation' });
    if (!accts.some((a) => a.variable_bp != null)) out.push({ key: 'defaultCostBehaviour' });
    if (s.noOpening) out.push({ key: 'noOpening' });
    if (s.end.cash < 0) out.push({ key: 'negativeCash', params: { amount: -s.end.cash } });
    return out;
  }

  return { snapshot, dataQuality };
}

export const analysisModule: AppModule = {
  id: 'analysis',
  dependsOn: ['ledger'],
  permissions: ['analysis.reports.read', 'analysis.settings.manage'],
  apps: [{ id: 'analysis', order: 70, permissions: ['analysis'] }],
  roles: [{ id: 'financial_analyst', permissions: ['analysis.*', 'gl.reports.read', 'gl.accounts.read'] }],

  routes(r, ctx) {
    const { services } = ctx;
    const a = createAnalysis(ctx);
    const settings = () => ({ ...DEFAULT_SETTINGS, ...services.get('settings').get<Partial<AnalysisSettings>>('analysis', {}) });

    const currentYear = () => {
      const t = today();
      const fy = services.get('ledger').fiscalYears().find((f) => f.start_date <= t && f.end_date >= t);
      return fy ? { from: fy.start_date, to: t < fy.end_date ? t : fy.end_date } : { from: t.slice(0, 4) + '-01-01', to: t };
    };

    /** The full analysis of a period, compared with the period before it (same length) unless told otherwise. */
    r.get('/analysis', 'analysis.reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(
        z.object({ from: zDate.default(def.from), to: zDate.default(def.to), compareFrom: zDate.nullish(), compareTo: zDate.nullish(), compare: z.enum(['previous', 'none']).default('previous') }),
        query,
      );
      const days = daysBetween(q.from, q.to);
      const cmp =
        q.compareFrom && q.compareTo
          ? { from: q.compareFrom, to: q.compareTo }
          : q.compare === 'previous'
            ? { from: addDays(q.from, -(days + 1)), to: addDays(q.from, -1) }
            : null;
      const market: MarketData = settings();
      const s = a.snapshot(q.from, q.to);
      const pRaw = cmp ? a.snapshot(cmp.from, cmp.to) : null;
      // A comparison period with no books at all (before the company started) would only show zeros.
      const p = pRaw && (pRaw.end.assets !== 0 || pRaw.revenue !== 0 || pRaw.end.liabilities !== 0) ? pRaw : null;
      const ratios = computeRatios(s, market);
      const prevRatios = p ? computeRatios(p, market) : [];
      for (const x of ratios) {
        const px = prevRatios.find((y) => y.key === x.key);
        if (px) x.previous = px.annualized ?? px.value;
      }
      const zs = zScore(s);
      return {
        from: q.from,
        to: q.to,
        compare: p ? cmp : null,
        snapshot: s,
        previous: p,
        ratios,
        dupont: dupont(s),
        previousDupont: p ? dupont(p) : null,
        zScore: zs,
        findings: findings(s, ratios, p, zs),
        dataQuality: a.dataQuality(s),
        market,
      };
    });

    /** Month by month for a trend chart: revenue, profit, cash, current ratio, margins, days. */
    r.get('/analysis/trend', 'analysis.reports.read', ({ query }) => {
      const q = parse(z.object({ to: zDate.default(today()), months: z.coerce.number().int().min(3).max(24).default(12) }), query);
      const lastStart = startOfMonth(q.to);
      const out = [];
      for (let i = q.months - 1; i >= 0; i--) {
        const from = addMonths(lastStart, -i);
        const to = i === 0 ? q.to : endOfMonth(from);
        const s = a.snapshot(from, to);
        const ratios = computeRatios(s, settings());
        const v = (k: string) => ratios.find((x) => x.key === k)?.value ?? null;
        out.push({
          month: from.slice(0, 7),
          revenue: s.revenue,
          netProfit: s.netProfit,
          operatingCashFlow: s.operatingCashFlow,
          cash: s.end.cash,
          grossMargin: v('grossMargin'),
          netMargin: v('netMargin'),
          currentRatio: v('currentRatio'),
          dso: v('dso'),
          cashConversionCycle: v('cashConversionCycle'),
        });
      }
      return out;
    });

    r.get('/analysis/settings', 'analysis.reports.read', () => settings());

    r.put('/analysis/settings', 'analysis.settings.manage', ({ body, user }) => {
      const s = parse(
        z.object({
          sharesOutstanding: z.number().int().positive().nullish().transform((v) => v ?? null),
          sharePrice: z.number().int().positive().nullish().transform((v) => v ?? null),
          preferredDividends: z.number().int().min(0).default(0),
        }),
        body,
      );
      services.get('settings').set('analysis', s);
      services.get('audit').log({ userId: user.id, action: 'update', entity: 'settings', summary: 'analysis', data: s });
      return { ok: true };
    });

    /** What-if for break-even: target profit or a change in price / volume / fixed costs. */
    r.get('/analysis/break-even', 'analysis.reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(
        z.object({
          from: zDate.default(def.from),
          to: zDate.default(def.to),
          targetProfit: z.coerce.number().int().default(0),
          priceChangeBp: z.coerce.number().int().min(-9000).max(100000).default(0),
          volumeChangeBp: z.coerce.number().int().min(-10000).max(100000).default(0),
          fixedChange: z.coerce.number().int().default(0),
        }),
        query,
      );
      const s = a.snapshot(q.from, q.to);
      const revenue = s.revenue;
      const cm = revenue - s.variableCosts;
      const cmRatio = revenue > 0 ? cm / revenue : 0;
      const breakEven = cmRatio > 0 ? s.fixedCosts / cmRatio : null;
      const target = cmRatio > 0 ? (s.fixedCosts + q.targetProfit) / cmRatio : null;
      // Scenario: price moves revenue per unit, volume moves units; variable cost per unit is unchanged.
      const p = 1 + q.priceChangeBp / 10000;
      const v = 1 + q.volumeChangeBp / 10000;
      const newRevenue = revenue * p * v;
      const newVariable = s.variableCosts * v;
      const newFixed = s.fixedCosts + q.fixedChange;
      const newProfit = newRevenue - newVariable - newFixed;
      const newCmRatio = newRevenue > 0 ? (newRevenue - newVariable) / newRevenue : 0;
      return {
        ...q,
        revenue,
        variableCosts: s.variableCosts,
        fixedCosts: s.fixedCosts,
        contributionMargin: cm,
        contributionMarginRatio: cmRatio,
        operatingProfit: revenue - s.variableCosts - s.fixedCosts,
        breakEven: breakEven == null ? null : Math.round(breakEven),
        targetRevenue: target == null ? null : Math.round(target),
        scenario: {
          revenue: Math.round(newRevenue),
          variableCosts: Math.round(newVariable),
          fixedCosts: newFixed,
          operatingProfit: Math.round(newProfit),
          breakEven: newCmRatio > 0 ? Math.round(newFixed / newCmRatio) : null,
        },
      };
    });
  },
};
