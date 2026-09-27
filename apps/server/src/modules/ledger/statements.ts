import type { ModuleContext } from '../../kernel/modules.js';
import { addDays } from '../../kernel/dates.js';
import type { Account, Movement } from './service.js';

/**
 * The financial statements, computed from posted ledger movements only.
 * Shared by the GL report routes and by the analysis app (which imports this core file).
 *
 * Classification comes from account subtypes:
 *   income statement  revenue (operating_income) − cogs = gross profit − operating expenses
 *                     (operating_expense, depreciation) = operating profit ± other items
 *                     = EBIT − interest_expense = profit before tax − income_tax = net profit
 *   balance sheet     current / non-current assets and liabilities, equity (+ unclosed profit)
 *   cash flow         indirect method; working capital, investing, financing by subtype
 */
export interface StatementRow {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  subtype: string;
  amount: number;
  compare?: number;
}

export const CURRENT_ASSETS = ['cash', 'bank', 'marketable_securities', 'receivable', 'inventory', 'current_asset'];
export const NON_CURRENT_ASSETS = ['fixed_asset', 'accumulated_depreciation', 'non_current_asset'];
export const CURRENT_LIABILITIES = ['payable', 'short_term_debt', 'current_liability'];
export const NON_CURRENT_LIABILITIES = ['non_current_liability'];
export const EQUITY = ['equity', 'retained_earnings', 'dividends'];
const CLOSING_SOURCES = ['closing', 'closing_reversal'];

const netDebit = (m?: Movement) => (m ? m.debit - m.credit : 0);

export type IncomeTotals = ReturnType<ReturnType<typeof createStatements>['incomeStatement']>['totals'];
export type BalanceTotals = ReturnType<ReturnType<typeof createStatements>['balanceSheet']>['totals'];

export function createStatements({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const postable = () => ledger().accounts().filter((a) => !a.is_group);

  const rowsFor = (accounts: Account[], value: (a: Account) => number, compare?: (a: Account) => number): StatementRow[] =>
    accounts
      .map((a) => ({
        id: a.id,
        code: a.code,
        name_en: a.name_en,
        name_ar: a.name_ar,
        subtype: a.subtype,
        amount: value(a),
        ...(compare ? { compare: compare(a) } : {}),
      }))
      .filter((x) => x.amount !== 0 || (x.compare ?? 0) !== 0);

  const total = (rows: StatementRow[], key: 'amount' | 'compare' = 'amount') => rows.reduce((s, x) => s + (x[key] ?? 0), 0);

  // ------------------------------------------------------------ income statement
  function incomeStatement(from: string, to: string, cmp?: { from: string; to: string }) {
    const mv = ledger().movements({ from, to, excludeClosing: true });
    const mc = cmp ? ledger().movements({ from: cmp.from, to: cmp.to, excludeClosing: true }) : null;
    const accts = postable();
    const credit = (m: Map<number, Movement>) => (a: Account) => -netDebit(m.get(a.id));
    const debit = (m: Map<number, Movement>) => (a: Account) => netDebit(m.get(a.id));
    const section = (filter: (a: Account) => boolean, sign: 'credit' | 'debit') => {
      const f = sign === 'credit' ? credit : debit;
      return rowsFor(accts.filter(filter), f(mv), mc ? f(mc) : undefined);
    };
    const revenue = section((a) => a.type === 'income' && a.subtype === 'operating_income', 'credit');
    const cogs = section((a) => a.type === 'expense' && a.subtype === 'cogs', 'debit');
    const opex = section((a) => a.type === 'expense' && (a.subtype === 'operating_expense' || a.subtype === 'depreciation'), 'debit');
    const otherIncome = section((a) => a.type === 'income' && a.subtype === 'other_income', 'credit');
    const otherExpense = section((a) => a.type === 'expense' && a.subtype === 'other_expense', 'debit');
    const interest = section((a) => a.type === 'expense' && a.subtype === 'interest_expense', 'debit');
    const incomeTax = section((a) => a.type === 'expense' && a.subtype === 'income_tax', 'debit');
    const t = (k: 'amount' | 'compare') => {
      const rev = total(revenue, k);
      const gross = rev - total(cogs, k);
      const operating = gross - total(opex, k);
      const ebit = operating + total(otherIncome, k) - total(otherExpense, k);
      const ebt = ebit - total(interest, k);
      const net = ebt - total(incomeTax, k);
      const depreciation = opex.filter((r) => r.subtype === 'depreciation').reduce((s, r) => s + (r[k] ?? 0), 0);
      return {
        revenue: rev,
        cogs: total(cogs, k),
        grossProfit: gross,
        operatingExpenses: total(opex, k),
        depreciation,
        operatingProfit: operating,
        otherIncome: total(otherIncome, k),
        otherExpenses: total(otherExpense, k),
        /** Earnings before interest and tax. */
        ebit,
        ebitda: ebit + depreciation,
        interestExpense: total(interest, k),
        profitBeforeTax: ebt,
        incomeTax: total(incomeTax, k),
        netProfit: net,
      };
    };
    return {
      from,
      to,
      compare: cmp ?? null,
      sections: { revenue, cogs, operatingExpenses: opex, otherIncome, otherExpenses: otherExpense, interest, incomeTax },
      totals: t('amount'),
      compareTotals: cmp ? t('compare') : null,
    };
  }

  // --------------------------------------------------------------- balance sheet
  function balanceSheet(asOf: string, compareAsOf?: string | null) {
    const mv = ledger().movements({ to: asOf });
    const mc = compareAsOf ? ledger().movements({ to: compareAsOf }) : null;
    const accts = postable();
    const dr = (m: Map<number, Movement>) => (a: Account) => netDebit(m.get(a.id));
    const cr = (m: Map<number, Movement>) => (a: Account) => -netDebit(m.get(a.id));
    const sec = (subs: string[], side: 'dr' | 'cr') => {
      const f = side === 'dr' ? dr : cr;
      return rowsFor(accts.filter((a) => subs.includes(a.subtype)), f(mv), mc ? f(mc) : undefined);
    };
    const currentAssets = sec(CURRENT_ASSETS, 'dr');
    const nonCurrentAssets = sec(NON_CURRENT_ASSETS, 'dr');
    const currentLiabilities = sec(CURRENT_LIABILITIES, 'cr');
    const nonCurrentLiabilities = sec(NON_CURRENT_LIABILITIES, 'cr');
    const equity = sec(EQUITY, 'cr');
    // Profit not yet closed into retained earnings.
    const unclosed = (m: Map<number, Movement>) =>
      -accts.filter((a) => a.type === 'income' || a.type === 'expense').reduce((s, a) => s + netDebit(m.get(a.id)), 0);
    const earnings = unclosed(mv);
    const earningsCmp = mc ? unclosed(mc) : undefined;
    const bySub = (rows: StatementRow[], subs: string[], k: 'amount' | 'compare') => rows.filter((r) => subs.includes(r.subtype)).reduce((s, r) => s + (r[k] ?? 0), 0);
    const t = (k: 'amount' | 'compare', e: number) => {
      const assets = total(currentAssets, k) + total(nonCurrentAssets, k);
      const liabilities = total(currentLiabilities, k) + total(nonCurrentLiabilities, k);
      const eq = total(equity, k) + e;
      return {
        cash: bySub(currentAssets, ['cash', 'bank'], k),
        marketableSecurities: bySub(currentAssets, ['marketable_securities'], k),
        receivables: bySub(currentAssets, ['receivable'], k),
        inventory: bySub(currentAssets, ['inventory'], k),
        currentAssets: total(currentAssets, k),
        fixedAssetsNet: bySub(nonCurrentAssets, ['fixed_asset', 'accumulated_depreciation'], k),
        nonCurrentAssets: total(nonCurrentAssets, k),
        assets,
        payables: bySub(currentLiabilities, ['payable'], k),
        shortTermDebt: bySub(currentLiabilities, ['short_term_debt'], k),
        currentLiabilities: total(currentLiabilities, k),
        nonCurrentLiabilities: total(nonCurrentLiabilities, k),
        liabilities,
        retainedEarnings: bySub(equity, ['retained_earnings'], k) + e,
        equity: eq,
        liabilitiesAndEquity: liabilities + eq,
        balanced: assets === liabilities + eq,
      };
    };
    return {
      asOf,
      compareAsOf: compareAsOf ?? null,
      sections: { currentAssets, nonCurrentAssets, currentLiabilities, nonCurrentLiabilities, equity },
      currentEarnings: earnings,
      compareCurrentEarnings: earningsCmp ?? null,
      totals: t('amount', earnings),
      compareTotals: mc ? t('compare', earningsCmp!) : null,
    };
  }

  // ------------------------------------------------------------------ cash flow
  function cashFlow(from: string, to: string) {
    const mv = ledger().movements({ from, to, excludeClosing: true });
    const before = ledger().movements({ to: addDays(from, -1) });
    const accts = postable();
    const isCash = (a: Account) => a.subtype === 'cash' || a.subtype === 'bank';
    const flow = (a: Account) => -netDebit(mv.get(a.id)); // cash effect of a change in a non-cash account
    const pick = (subs: string[]) => rowsFor(accts.filter((a) => subs.includes(a.subtype)), flow);

    const netIncome = -accts.filter((a) => a.type === 'income' || a.type === 'expense').reduce((s, a) => s + netDebit(mv.get(a.id)), 0);
    const nonCash = pick(['accumulated_depreciation']);
    const workingCapital = pick(['receivable', 'inventory', 'current_asset', 'payable', 'current_liability']);
    const investing = pick(['fixed_asset', 'non_current_asset', 'marketable_securities']);
    const financing = pick(['short_term_debt', 'non_current_liability', ...EQUITY]);

    const operatingTotal = netIncome + total(nonCash) + total(workingCapital);
    const investingTotal = total(investing);
    const financingTotal = total(financing);
    const netChange = operatingTotal + investingTotal + financingTotal;
    const cashAccts = accts.filter(isCash);
    const openingCash = cashAccts.reduce((s, a) => s + netDebit(before.get(a.id)), 0);
    const cashChange = cashAccts.reduce((s, a) => s + netDebit(mv.get(a.id)), 0);
    // Money spent on fixed assets (gross additions), for free cash flow.
    const capex = accts.filter((a) => a.subtype === 'fixed_asset').reduce((s, a) => s + (mv.get(a.id)?.debit ?? 0), 0);
    const dividendsPaid = accts.filter((a) => a.subtype === 'dividends').reduce((s, a) => s + netDebit(mv.get(a.id)), 0);
    return {
      from,
      to,
      operating: { netIncome, nonCash, workingCapital, total: operatingTotal },
      investing: { rows: investing, total: investingTotal },
      financing: { rows: financing, total: financingTotal },
      netChange,
      openingCash,
      closingCash: openingCash + cashChange,
      capex,
      dividends: dividendsPaid,
      reconciled: netChange === cashChange,
    };
  }

  // ------------------------------------------------------ changes in equity
  /**
   * Statement of changes in equity. Columns: capital (equity accounts), retained earnings,
   * dividends / drawings, and profit not yet closed. Rows: opening, profit, transfer at year-end
   * closing, capital movements, dividends, other movements, closing.
   */
  function equityChanges(from: string, to: string) {
    const accts = postable();
    const cols = ['capital', 'retained', 'dividends', 'unclosed'] as const;
    type Col = (typeof cols)[number];
    const colOf = (a: Account): Col | null =>
      a.subtype === 'equity' ? 'capital' : a.subtype === 'retained_earnings' ? 'retained' : a.subtype === 'dividends' ? 'dividends' : a.type === 'income' || a.type === 'expense' ? 'unclosed' : null;
    const zero = (): Record<Col, number> => ({ capital: 0, retained: 0, dividends: 0, unclosed: 0 });
    const opening = zero();
    for (const [id, m] of ledger().movements({ to: addDays(from, -1) })) {
      const a = accts.find((x) => x.id === id);
      const c = a && colOf(a);
      if (c) opening[c] += -netDebit(m);
    }
    // Period movements split by source: closing entries vs everything else.
    const rows = db.all<{ account_id: number; closing: number; amount: number }>(
      `SELECT l.account_id, CASE WHEN l.source_type IN ('${CLOSING_SOURCES.join("','")}') THEN 1 ELSE 0 END AS closing,
              SUM(l.credit - l.debit) AS amount
       FROM ledger l WHERE l.date BETWEEN ? AND ? GROUP BY l.account_id, closing`,
      [from, to],
    );
    const profit = zero();
    const closingTransfer = zero();
    const capitalMoves = zero();
    const dividends = zero();
    const other = zero();
    for (const r of rows) {
      const a = accts.find((x) => x.id === r.account_id);
      const c = a && colOf(a);
      if (!c) continue;
      if (r.closing) closingTransfer[c] += r.amount;
      else if (c === 'unclosed') profit[c] += r.amount;
      else if (c === 'capital') capitalMoves[c] += r.amount;
      else if (c === 'dividends') dividends[c] += r.amount;
      else other[c] += r.amount;
    }
    const closing = zero();
    for (const c of cols) closing[c] = opening[c] + profit[c] + closingTransfer[c] + capitalMoves[c] + dividends[c] + other[c];
    const sumRow = (r: Record<Col, number>) => cols.reduce((s, c) => s + r[c], 0);
    const lines = [
      { key: 'opening', ...opening, total: sumRow(opening) },
      { key: 'profit', ...profit, total: sumRow(profit) },
      { key: 'closingTransfer', ...closingTransfer, total: sumRow(closingTransfer) },
      { key: 'capital', ...capitalMoves, total: sumRow(capitalMoves) },
      { key: 'dividends', ...dividends, total: sumRow(dividends) },
      { key: 'other', ...other, total: sumRow(other) },
      { key: 'closing', ...closing, total: sumRow(closing) },
    ].filter((l) => l.key === 'opening' || l.key === 'closing' || l.total !== 0 || cols.some((c) => l[c] !== 0));
    // Must agree with the balance sheet's equity on `to`.
    const bs = balanceSheet(to).totals.equity;
    return { from, to, columns: cols, lines, reconciled: sumRow(closing) === bs };
  }

  return { incomeStatement, balanceSheet, cashFlow, equityChanges, rowsFor, total, postable };
}
