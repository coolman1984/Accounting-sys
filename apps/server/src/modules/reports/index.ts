import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { addDays, addMonths, daysBetween, endOfMonth, startOfMonth, today } from '../../kernel/dates.js';
import { parse, zDate, zId } from '../../kernel/validate.js';
import type { Account, Movement } from '../ledger/service.js';

interface Row {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  subtype: string;
  amount: number;
  compare?: number;
}

const netDebit = (m?: Movement) => (m ? m.debit - m.credit : 0);

export const reportsModule: AppModule = {
  id: 'reports',
  dependsOn: ['ledger', 'parties', 'documents', 'payments'],
  permissions: ['reports.read'],
  apps: [{ id: 'accounting', core: true, order: 0, permissions: ['reports'] }],

  routes(r, { db, services }) {
    const ledger = services.get('ledger');

    /** Current fiscal year (or the calendar year) for defaults. */
    const currentYear = () => {
      const t = today();
      const fy = ledger.fiscalYears().find((f) => f.start_date <= t && f.end_date >= t);
      return fy ? { from: fy.start_date, to: fy.end_date } : { from: t.slice(0, 4) + '-01-01', to: t.slice(0, 4) + '-12-31' };
    };

    const postable = () => ledger.accounts().filter((a) => !a.is_group);

    const rowsFor = (accounts: Account[], value: (a: Account) => number, compare?: (a: Account) => number): Row[] =>
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

    const total = (rows: Row[], key: 'amount' | 'compare' = 'amount') => rows.reduce((s, x) => s + (x[key] ?? 0), 0);

    // --------------------------------------------------------- trial balance
    r.get('/reports/trial-balance', 'reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(z.object({ from: zDate.default(def.from), to: zDate.default(def.to) }), query);
      const opening = ledger.movements({ to: addDays(q.from, -1) });
      const period = ledger.movements({ from: q.from, to: q.to });
      const rows = postable()
        .map((a) => {
          const o = netDebit(opening.get(a.id));
          const p = period.get(a.id) ?? { debit: 0, credit: 0 };
          const c = o + p.debit - p.credit;
          return {
            id: a.id,
            code: a.code,
            name_en: a.name_en,
            name_ar: a.name_ar,
            type: a.type,
            opening_debit: o > 0 ? o : 0,
            opening_credit: o < 0 ? -o : 0,
            debit: p.debit,
            credit: p.credit,
            closing_debit: c > 0 ? c : 0,
            closing_credit: c < 0 ? -c : 0,
          };
        })
        .filter((x) => x.opening_debit || x.opening_credit || x.debit || x.credit);
      const sumOf = (k: keyof (typeof rows)[number]) => rows.reduce((s, x) => s + (x[k] as number), 0);
      const totals = {
        opening_debit: sumOf('opening_debit'),
        opening_credit: sumOf('opening_credit'),
        debit: sumOf('debit'),
        credit: sumOf('credit'),
        closing_debit: sumOf('closing_debit'),
        closing_credit: sumOf('closing_credit'),
      };
      return { ...q, rows, totals, balanced: totals.debit === totals.credit && totals.closing_debit === totals.closing_credit };
    });

    // ---------------------------------------------------------- general ledger
    r.get('/reports/general-ledger', 'reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(z.object({ accountId: zId, from: zDate.default(def.from), to: zDate.default(def.to) }), query);
      const account = ledger.account(q.accountId);
      // Group account => include all its descendants.
      const ids = db
        .all<{ id: number }>(
          `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT a.id FROM accounts a JOIN t ON a.parent_id = t.id) SELECT id FROM t`,
          [account.id],
        )
        .map((x) => x.id);
      const inList = ids.join(',');
      const opening = db.get<{ b: number }>(
        `SELECT COALESCE(SUM(debit - credit), 0) b FROM ledger WHERE account_id IN (${inList}) AND date < ?`,
        [q.from],
      )!.b;
      const lines = db.all<{ debit: number; credit: number; party_id: number | null }>(
        `SELECT l.entry_id, l.number, l.date, l.reference, l.memo, l.description, l.source_type, l.source_id,
                l.party_id, l.debit, l.credit, a.code AS account_code
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE l.account_id IN (${inList}) AND l.date BETWEEN ? AND ?
         ORDER BY l.date, l.entry_id, l.line_no`,
        [q.from, q.to],
      );
      const names = services.get('parties').names(lines.map((l) => l.party_id).filter((x): x is number => x != null));
      let running = opening;
      const rows = lines.map((l) => {
        running += l.debit - l.credit;
        return { ...l, party_name: l.party_id ? names.get(l.party_id) ?? null : null, balance: running };
      });
      return {
        ...q,
        account,
        opening,
        rows,
        totals: { debit: rows.reduce((s, x) => s + x.debit, 0), credit: rows.reduce((s, x) => s + x.credit, 0) },
        closing: running,
      };
    });

    // -------------------------------------------------------- income statement
    const incomeStatement = (from: string, to: string, cmp?: { from: string; to: string }) => {
      const mv = ledger.movements({ from, to, excludeClosing: true });
      const mc = cmp ? ledger.movements({ from: cmp.from, to: cmp.to, excludeClosing: true }) : null;
      const accts = postable();
      const credit = (m: Map<number, Movement>) => (a: Account) => -netDebit(m.get(a.id));
      const debit = (m: Map<number, Movement>) => (a: Account) => netDebit(m.get(a.id));
      const section = (filter: (a: Account) => boolean, sign: 'credit' | 'debit') => {
        const list = accts.filter(filter);
        const f = sign === 'credit' ? credit : debit;
        return rowsFor(list, f(mv), mc ? f(mc) : undefined);
      };
      const revenue = section((a) => a.type === 'income' && a.subtype === 'operating_income', 'credit');
      const cogs = section((a) => a.type === 'expense' && a.subtype === 'cogs', 'debit');
      const opex = section((a) => a.type === 'expense' && (a.subtype === 'operating_expense' || a.subtype === 'depreciation'), 'debit');
      const otherIncome = section((a) => a.type === 'income' && a.subtype === 'other_income', 'credit');
      const otherExpense = section((a) => a.type === 'expense' && a.subtype === 'other_expense', 'debit');
      const t = (k: 'amount' | 'compare') => {
        const rev = total(revenue, k);
        const gross = rev - total(cogs, k);
        const operating = gross - total(opex, k);
        const net = operating + total(otherIncome, k) - total(otherExpense, k);
        return {
          revenue: rev,
          cogs: total(cogs, k),
          grossProfit: gross,
          operatingExpenses: total(opex, k),
          operatingProfit: operating,
          otherIncome: total(otherIncome, k),
          otherExpenses: total(otherExpense, k),
          netProfit: net,
        };
      };
      return {
        from,
        to,
        compare: cmp ?? null,
        sections: { revenue, cogs, operatingExpenses: opex, otherIncome, otherExpenses: otherExpense },
        totals: t('amount'),
        compareTotals: cmp ? t('compare') : null,
      };
    };

    r.get('/reports/income-statement', 'reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(
        z.object({ from: zDate.default(def.from), to: zDate.default(def.to), compareFrom: zDate.nullish(), compareTo: zDate.nullish() }),
        query,
      );
      const cmp = q.compareFrom && q.compareTo ? { from: q.compareFrom, to: q.compareTo } : undefined;
      return incomeStatement(q.from, q.to, cmp);
    });

    // ----------------------------------------------------------- balance sheet
    const balanceSheet = (asOf: string, compareAsOf?: string | null) => {
      const mv = ledger.movements({ to: asOf });
      const mc = compareAsOf ? ledger.movements({ to: compareAsOf }) : null;
      const accts = postable();
      const dr = (m: Map<number, Movement>) => (a: Account) => netDebit(m.get(a.id));
      const cr = (m: Map<number, Movement>) => (a: Account) => -netDebit(m.get(a.id));
      const sec = (subs: string[], side: 'dr' | 'cr') => {
        const f = side === 'dr' ? dr : cr;
        return rowsFor(accts.filter((a) => subs.includes(a.subtype)), f(mv), mc ? f(mc) : undefined);
      };
      const currentAssets = sec(['cash', 'bank', 'receivable', 'inventory', 'current_asset'], 'dr');
      const nonCurrentAssets = sec(['fixed_asset', 'accumulated_depreciation', 'non_current_asset'], 'dr');
      const currentLiabilities = sec(['payable', 'current_liability'], 'cr');
      const nonCurrentLiabilities = sec(['non_current_liability'], 'cr');
      const equity = sec(['equity', 'retained_earnings'], 'cr');
      // Profit not yet closed into retained earnings.
      const unclosed = (m: Map<number, Movement>) =>
        -accts.filter((a) => a.type === 'income' || a.type === 'expense').reduce((s, a) => s + netDebit(m.get(a.id)), 0);
      const earnings = unclosed(mv);
      const earningsCmp = mc ? unclosed(mc) : undefined;
      const t = (k: 'amount' | 'compare', e: number) => {
        const assets = total(currentAssets, k) + total(nonCurrentAssets, k);
        const liabilities = total(currentLiabilities, k) + total(nonCurrentLiabilities, k);
        const eq = total(equity, k) + e;
        return {
          currentAssets: total(currentAssets, k),
          nonCurrentAssets: total(nonCurrentAssets, k),
          assets,
          currentLiabilities: total(currentLiabilities, k),
          nonCurrentLiabilities: total(nonCurrentLiabilities, k),
          liabilities,
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
    };

    r.get('/reports/balance-sheet', 'reports.read', ({ query }) => {
      const q = parse(z.object({ asOf: zDate.default(today()), compareAsOf: zDate.nullish() }), query);
      return balanceSheet(q.asOf, q.compareAsOf);
    });

    // --------------------------------------------------------------- cash flow
    r.get('/reports/cash-flow', 'reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(z.object({ from: zDate.default(def.from), to: zDate.default(def.to) }), query);
      const mv = ledger.movements({ from: q.from, to: q.to, excludeClosing: true });
      const before = ledger.movements({ to: addDays(q.from, -1) });
      const accts = postable();
      const isCash = (a: Account) => a.subtype === 'cash' || a.subtype === 'bank';
      const flow = (a: Account) => -netDebit(mv.get(a.id)); // cash effect of a change in a non-cash account
      const pick = (subs: string[]) => rowsFor(accts.filter((a) => subs.includes(a.subtype)), flow);

      const netIncome = -accts.filter((a) => a.type === 'income' || a.type === 'expense').reduce((s, a) => s + netDebit(mv.get(a.id)), 0);
      const nonCash = pick(['accumulated_depreciation']);
      const workingCapital = pick(['receivable', 'inventory', 'current_asset', 'payable', 'current_liability']);
      const investing = pick(['fixed_asset', 'non_current_asset']);
      const financing = pick(['non_current_liability', 'equity', 'retained_earnings']);

      const operatingTotal = netIncome + total(nonCash) + total(workingCapital);
      const investingTotal = total(investing);
      const financingTotal = total(financing);
      const netChange = operatingTotal + investingTotal + financingTotal;
      const cashAccts = accts.filter(isCash);
      const openingCash = cashAccts.reduce((s, a) => s + netDebit(before.get(a.id)), 0);
      const cashChange = cashAccts.reduce((s, a) => s + netDebit(mv.get(a.id)), 0);
      return {
        ...q,
        operating: { netIncome, nonCash, workingCapital, total: operatingTotal },
        investing: { rows: investing, total: investingTotal },
        financing: { rows: financing, total: financingTotal },
        netChange,
        openingCash,
        closingCash: openingCash + cashChange,
        reconciled: netChange === cashChange,
      };
    });

    // ------------------------------------------------------------------- aging
    r.get('/reports/aging', 'reports.read', ({ query }) => {
      const q = parse(z.object({ type: z.enum(['receivable', 'payable']).default('receivable'), asOf: zDate.default(today()) }), query);
      const kinds = q.type === 'receivable' ? ['sales_invoice', 'sales_credit'] : ['purchase_bill', 'purchase_credit'];
      // Sign so that a positive number is what the party owes us (receivable) / we owe them (payable).
      const docs = db.all<{ id: number; kind: string; party_id: number; number: string; date: string; due_date: string; outstanding: number }>(
        `SELECT d.id, d.kind, d.party_id, d.number, d.date, d.due_date,
                d.total - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.document_id = d.id AND s.date <= :asOf), 0)
                        - (CASE WHEN d.kind IN ('sales_credit', 'purchase_credit')
                                THEN COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.source_type = 'credit' AND s.source_id = d.id AND s.date <= :asOf), 0)
                                ELSE 0 END) AS outstanding
         FROM documents d
         WHERE d.kind IN (${kinds.map((k) => `'${k}'`).join(',')}) AND d.date <= :asOf
           AND (d.status = 'posted' OR (d.status = 'void' AND substr(d.voided_at, 1, 10) > :asOf))`,
        { asOf: q.asOf },
      );
      const buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
      type B = (typeof buckets)[number];
      const bucketOf = (due: string): B => {
        const late = daysBetween(due, q.asOf);
        if (late <= 0) return 'current';
        if (late <= 30) return 'd1_30';
        if (late <= 60) return 'd31_60';
        if (late <= 90) return 'd61_90';
        return 'd90_plus';
      };
      const byParty = new Map<number, Record<B | 'documents' | 'unapplied' | 'total', number>>();
      const blank = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, documents: 0, unapplied: 0, total: 0 });
      const details: (typeof docs[number] & { bucket: B; days_overdue: number })[] = [];
      for (const d of docs) {
        if (d.outstanding === 0) continue;
        const sign = d.kind === 'sales_invoice' || d.kind === 'purchase_bill' ? 1 : -1;
        const amt = d.outstanding * sign;
        const b = sign === 1 ? bucketOf(d.due_date) : 'current';
        const row = byParty.get(d.party_id) ?? blank();
        row[b] += amt;
        row.documents += amt;
        byParty.set(d.party_id, row);
        details.push({ ...d, outstanding: amt, bucket: b, days_overdue: Math.max(0, daysBetween(d.due_date, q.asOf)) });
      }
      // Reconcile with the ledger: anything not explained by documents (payments on account, opening balances).
      const ledgerBal = db.all<{ party_id: number; bal: number }>(
        `SELECT l.party_id, SUM(${q.type === 'receivable' ? 'l.debit - l.credit' : 'l.credit - l.debit'}) AS bal
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE a.subtype = :sub AND l.party_id IS NOT NULL AND l.date <= :asOf GROUP BY l.party_id`,
        { sub: q.type, asOf: q.asOf },
      );
      for (const lb of ledgerBal) {
        const row = byParty.get(lb.party_id) ?? blank();
        row.unapplied = lb.bal - row.documents;
        byParty.set(lb.party_id, row);
      }
      const names = services.get('parties').names([...byParty.keys()]);
      const rows = [...byParty.entries()]
        .map(([partyId, v]) => ({ party_id: partyId, party_name: names.get(partyId) ?? '', ...v, total: v.documents + v.unapplied }))
        .filter((x) => x.total !== 0 || x.documents !== 0)
        .sort((a, b) => b.total - a.total);
      const totals = blank();
      for (const x of rows) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += x[k];
      return { ...q, rows, totals, details };
    });

    // ------------------------------------------------------------- tax summary
    r.get('/reports/tax-summary', 'reports.read', ({ query }) => {
      const def = currentYear();
      const q = parse(z.object({ from: zDate.default(def.from), to: zDate.default(def.to) }), query);
      const rows = db.all<{ tax_id: number; code: string; name_en: string; name_ar: string; rate_bp: number; side: string; net: number; tax: number }>(
        `SELECT t.id AS tax_id, t.code, t.name_en, t.name_ar, l.tax_rate_bp AS rate_bp,
                CASE WHEN d.kind LIKE 'sales_%' THEN 'sales' ELSE 'purchases' END AS side,
                SUM(CASE WHEN d.kind IN ('sales_invoice', 'purchase_bill') THEN l.net ELSE -l.net END) AS net,
                SUM(CASE WHEN d.kind IN ('sales_invoice', 'purchase_bill') THEN l.tax ELSE -l.tax END) AS tax
         FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN taxes t ON t.id = l.tax_id
         WHERE d.status = 'posted' AND d.date BETWEEN ? AND ?
         GROUP BY t.id, l.tax_rate_bp, side ORDER BY t.code, side`,
        [q.from, q.to],
      );
      const output = rows.filter((x) => x.side === 'sales').reduce((s, x) => s + x.tax, 0);
      const input = rows.filter((x) => x.side === 'purchases').reduce((s, x) => s + x.tax, 0);
      return { ...q, rows, output, input, net: output - input };
    });

    // --------------------------------------------------------------- dashboard
    r.get('/reports/dashboard', 'reports.read', () => {
      const t = today();
      const accts = postable();
      const all = ledger.movements({ to: t });
      const sumSub = (subs: string[], sign = 1) =>
        accts.filter((a) => subs.includes(a.subtype)).reduce((s, a) => s + sign * netDebit(all.get(a.id)), 0);

      const monthStart = startOfMonth(t);
      const pl = (from: string, to: string) => {
        const m = ledger.movements({ from, to, excludeClosing: true });
        const revenue = -accts.filter((a) => a.type === 'income').reduce((s, a) => s + netDebit(m.get(a.id)), 0);
        const expenses = accts.filter((a) => a.type === 'expense').reduce((s, a) => s + netDebit(m.get(a.id)), 0);
        return { revenue, expenses, profit: revenue - expenses };
      };
      const series = [];
      for (let i = 11; i >= 0; i--) {
        const from = addMonths(monthStart, -i);
        series.push({ month: from.slice(0, 7), ...pl(from, endOfMonth(from)) });
      }
      const year = currentYear();
      const overdue = db.get<{ n: number; amount: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(total - amount_settled), 0) amount FROM documents
         WHERE kind = 'sales_invoice' AND status = 'posted' AND amount_settled < total AND due_date < ?`,
        [t],
      )!;
      const billsDue = db.get<{ n: number; amount: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(total - amount_settled), 0) amount FROM documents
         WHERE kind = 'purchase_bill' AND status = 'posted' AND amount_settled < total AND due_date <= ?`,
        [addDays(t, 7)],
      )!;
      const cashAccounts = db.all(
        `SELECT a.id, a.code, a.name_en, a.name_ar, COALESCE(SUM(l.debit - l.credit), 0) AS balance
         FROM accounts a LEFT JOIN ledger l ON l.account_id = a.id
         WHERE a.subtype IN ('cash', 'bank') AND a.is_group = 0 GROUP BY a.id ORDER BY a.code`,
      );
      const recent = db.all(
        `SELECT id, number, date, memo, source_type, total FROM journal_entries WHERE status = 'posted'
         ORDER BY date DESC, id DESC LIMIT 8`,
      );
      const topDebtors = db.all(
        `SELECT l.party_id, p.name, SUM(l.debit - l.credit) AS balance
         FROM ledger l JOIN accounts a ON a.id = l.account_id JOIN parties p ON p.id = l.party_id
         WHERE a.subtype = 'receivable' GROUP BY l.party_id HAVING balance > 0 ORDER BY balance DESC LIMIT 5`,
      );
      return {
        today: t,
        cash: sumSub(['cash', 'bank']),
        receivables: sumSub(['receivable']),
        payables: sumSub(['payable'], -1),
        month: pl(monthStart, t),
        lastMonth: pl(addMonths(monthStart, -1), addDays(monthStart, -1)),
        yearToDate: pl(year.from, t),
        series,
        overdue,
        billsDue,
        cashAccounts,
        recent,
        topDebtors,
        drafts: db.get<{ n: number }>(
          `SELECT (SELECT COUNT(*) FROM documents WHERE status = 'draft') + (SELECT COUNT(*) FROM payments WHERE status = 'draft')
                + (SELECT COUNT(*) FROM journal_entries WHERE status = 'draft') AS n`,
        )!.n,
      };
    });
  },
};
