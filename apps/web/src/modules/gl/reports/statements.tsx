import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useApi } from '../../../core/hooks';
import { useI18n } from '../../../core/i18n';
import { todayIso } from '../../../core/format';
import { downloadCsv } from '../../../lib/csv';
import { Card } from '../../../ui/Card';
import { Checkbox } from '../../../ui/Field';
import { Loading } from '../../../ui/Page';
import { Badge } from '../../../ui/Badge';
import { Money } from '../../../ui/Money';
import { PeriodControls, previousPeriod, ReportFrame, Section, TotalLine, useCsvMoney, usePeriod, type StatementRow } from '../../../ui/Report';

// ------------------------------------------------------------ income statement

interface IS {
  sections: Record<'revenue' | 'cogs' | 'operatingExpenses' | 'otherIncome' | 'otherExpenses' | 'interest' | 'incomeTax', StatementRow[]>;
  totals: Record<string, number>;
  compareTotals: Record<string, number> | null;
}

export function IncomeStatementPage() {
  const { t, pick } = useI18n();
  const csv = useCsvMoney();
  const { from, to, params, set } = usePeriod();
  const compare = params.get('compare') === '1';
  const showPct = params.get('pct') === '1';
  const prev = previousPeriod(from, to);
  const { data, isLoading } = useApi<IS>('/reports/income-statement', {
    from,
    to,
    compareFrom: compare ? prev.from : undefined,
    compareTo: compare ? prev.to : undefined,
  });

  const exportCsv = () => {
    if (!data) return;
    const rows: (string | number)[][] = [];
    const add = (label: string, list: StatementRow[], total: number) => {
      rows.push([label, '', '']);
      list.forEach((r) => rows.push([r.code, pick(r.name_en, r.name_ar), csv(r.amount)]));
      rows.push(['', t('common.total'), csv(total)]);
    };
    add(t('reports.revenue'), data.sections.revenue, data.totals.revenue);
    add(t('reports.cogs'), data.sections.cogs, data.totals.cogs);
    rows.push(['', t('reports.grossProfit'), csv(data.totals.grossProfit)]);
    add(t('reports.operatingExpenses'), data.sections.operatingExpenses, data.totals.operatingExpenses);
    rows.push(['', t('reports.operatingProfit'), csv(data.totals.operatingProfit)]);
    add(t('reports.otherIncome'), data.sections.otherIncome, data.totals.otherIncome);
    add(t('reports.otherExpenses'), data.sections.otherExpenses, data.totals.otherExpenses);
    rows.push(['', t('reports.ebit'), csv(data.totals.ebit)]);
    add(t('reports.interestExpense'), data.sections.interest, data.totals.interestExpense);
    rows.push(['', t('reports.profitBeforeTax'), csv(data.totals.profitBeforeTax)]);
    add(t('reports.incomeTax'), data.sections.incomeTax, data.totals.incomeTax);
    rows.push(['', t('reports.netProfit'), csv(data.totals.netProfit)]);
    downloadCsv(`income-statement-${from}-${to}`, [t('common.code'), t('common.account'), t('common.amount')], rows);
  };

  const c = data?.compareTotals;
  // Common-size: every line as a share of revenue.
  const pct = showPct && data ? { base: data.totals.revenue, compareBase: c?.revenue } : null;
  return (
    <ReportFrame
      title={t('reports.incomeStatement')}
      subtitle={t('reports.periodLabel', { from, to })}
      onExport={exportCsv}
      controls={
        <>
          <PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />
          <Checkbox label={t('common.comparePrevious')} checked={compare} onChange={(v) => set({ compare: v ? '1' : null })} />
          <Checkbox label={t('reports.commonSize')} checked={showPct} onChange={(v) => set({ pct: v ? '1' : null })} />
        </>
      }
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.account')}</th>
                  <th className="end">{t('reports.periodLabel', { from, to })}</th>
                  {pct && <th className="end">%</th>}
                  {compare && <th className="end">{t('reports.periodLabel', { from: prev.from, to: prev.to })}</th>}
                  {compare && pct && <th className="end">%</th>}
                </tr>
              </thead>
              <tbody>
                <Section pct={pct} title={t('reports.revenue')} rows={data.sections.revenue} total={data.totals.revenue} compareTotal={c?.revenue} showCompare={compare} from={from} to={to} />
                <Section pct={pct} title={t('reports.cogs')} rows={data.sections.cogs} total={data.totals.cogs} compareTotal={c?.cogs} showCompare={compare} from={from} to={to} />
                <TotalLine pct={pct} label={t('reports.grossProfit')} value={data.totals.grossProfit} compare={c?.grossProfit} showCompare={compare} />
                <Section pct={pct}
                  title={t('reports.operatingExpenses')}
                  rows={data.sections.operatingExpenses}
                  total={data.totals.operatingExpenses}
                  compareTotal={c?.operatingExpenses}
                  showCompare={compare}
                  from={from}
                  to={to}
                />
                <TotalLine pct={pct} label={t('reports.operatingProfit')} value={data.totals.operatingProfit} compare={c?.operatingProfit} showCompare={compare} />
                {(data.sections.otherIncome.length > 0 || (c?.otherIncome ?? 0) !== 0) && (
                  <Section pct={pct} title={t('reports.otherIncome')} rows={data.sections.otherIncome} total={data.totals.otherIncome} compareTotal={c?.otherIncome} showCompare={compare} from={from} to={to} />
                )}
                {(data.sections.otherExpenses.length > 0 || (c?.otherExpenses ?? 0) !== 0) && (
                  <Section pct={pct} title={t('reports.otherExpenses')} rows={data.sections.otherExpenses} total={data.totals.otherExpenses} compareTotal={c?.otherExpenses} showCompare={compare} from={from} to={to} />
                )}
                <TotalLine pct={pct} label={t('reports.ebit')} value={data.totals.ebit} compare={c?.ebit} showCompare={compare} />
                {(data.sections.interest.length > 0 || (c?.interestExpense ?? 0) !== 0) && (
                  <Section pct={pct} title={t('reports.interestExpense')} rows={data.sections.interest} total={data.totals.interestExpense} compareTotal={c?.interestExpense} showCompare={compare} from={from} to={to} />
                )}
                <TotalLine pct={pct} label={t('reports.profitBeforeTax')} value={data.totals.profitBeforeTax} compare={c?.profitBeforeTax} showCompare={compare} />
                {(data.sections.incomeTax.length > 0 || (c?.incomeTax ?? 0) !== 0) && (
                  <Section pct={pct} title={t('reports.incomeTax')} rows={data.sections.incomeTax} total={data.totals.incomeTax} compareTotal={c?.incomeTax} showCompare={compare} from={from} to={to} />
                )}
                <TotalLine pct={pct} grand label={data.totals.netProfit >= 0 ? t('reports.netProfit') : t('reports.netLoss')} value={data.totals.netProfit} compare={c?.netProfit} showCompare={compare} />
                <tr>
                  <td className="faint" style={{ fontSize: 12.5 }}>{t('reports.ebitdaMemo')}</td>
                  <td className="end faint">
                    <Money v={data.totals.ebitda} parens />
                  </td>
                  {pct && <td />}
                  {compare && (
                    <td className="end faint">
                      <Money v={c?.ebitda ?? 0} parens />
                    </td>
                  )}
                  {compare && pct && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// --------------------------------------------------------------- balance sheet

interface BS {
  sections: Record<'currentAssets' | 'nonCurrentAssets' | 'currentLiabilities' | 'nonCurrentLiabilities' | 'equity', StatementRow[]>;
  currentEarnings: number;
  compareCurrentEarnings: number | null;
  totals: Record<string, number> & { balanced: boolean };
  compareTotals: (Record<string, number> & { balanced: boolean }) | null;
}

export function BalanceSheetPage() {
  const { t, pick } = useI18n();
  const csv = useCsvMoney();
  const { params, set } = usePeriod();
  const asOf = params.get('asOf') ?? todayIso();
  const compare = params.get('compare') === '1';
  const showPct = params.get('pct') === '1';
  const cmpDate = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`;
  const { data, isLoading } = useApi<BS>('/reports/balance-sheet', { asOf, compareAsOf: compare ? cmpDate : undefined });
  const c = data?.compareTotals;
  // Common-size: every line as a share of total assets.
  const pct = showPct && data ? { base: data.totals.assets, compareBase: c?.assets } : null;

  const exportCsv = () => {
    if (!data) return;
    const rows: (string | number)[][] = [];
    const add = (label: string, list: StatementRow[]) => {
      rows.push([label, '', '']);
      list.forEach((r) => rows.push([r.code, pick(r.name_en, r.name_ar), csv(r.amount)]));
    };
    add(t('reports.currentAssets'), data.sections.currentAssets);
    add(t('reports.nonCurrentAssets'), data.sections.nonCurrentAssets);
    rows.push(['', t('reports.totalAssets'), csv(data.totals.assets)]);
    add(t('reports.currentLiabilities'), data.sections.currentLiabilities);
    add(t('reports.nonCurrentLiabilities'), data.sections.nonCurrentLiabilities);
    rows.push(['', t('reports.totalLiabilities'), csv(data.totals.liabilities)]);
    add(t('reports.equity'), data.sections.equity);
    rows.push(['', t('reports.currentEarnings'), csv(data.currentEarnings)]);
    rows.push(['', t('reports.totalEquity'), csv(data.totals.equity)]);
    rows.push(['', t('reports.liabilitiesAndEquity'), csv(data.totals.liabilitiesAndEquity)]);
    downloadCsv(`balance-sheet-${asOf}`, [t('common.code'), t('common.account'), t('common.amount')], rows);
  };

  return (
    <ReportFrame
      title={t('reports.balanceSheet')}
      subtitle={`${t('common.asOf')} ${asOf}`}
      onExport={exportCsv}
      badge={
        data &&
        (data.totals.balanced ? (
          <Badge tone="green">
            <CheckCircle2 size={12} /> {t('reports.balanced')}
          </Badge>
        ) : (
          <Badge tone="red">
            <AlertTriangle size={12} /> {t('reports.notBalanced')}
          </Badge>
        ))
      }
      controls={
        <>
          <span className="muted">{t('common.asOf')}</span>
          <input className="input" type="date" style={{ width: 'auto' }} value={asOf} onChange={(e) => set({ asOf: e.target.value })} />
          <Checkbox label={`${t('common.compareTo')} ${cmpDate}`} checked={compare} onChange={(v) => set({ compare: v ? '1' : null })} />
          <Checkbox label={t('reports.commonSize')} checked={showPct} onChange={(v) => set({ pct: v ? '1' : null })} />
        </>
      }
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.account')}</th>
                  <th className="end">{asOf}</th>
                  {pct && <th className="end">%</th>}
                  {compare && <th className="end">{cmpDate}</th>}
                  {compare && pct && <th className="end">%</th>}
                </tr>
              </thead>
              <tbody>
                <Section pct={pct} title={t('reports.currentAssets')} rows={data.sections.currentAssets} total={data.totals.currentAssets} compareTotal={c?.currentAssets} showCompare={compare} to={asOf} />
                <Section pct={pct} title={t('reports.nonCurrentAssets')} rows={data.sections.nonCurrentAssets} total={data.totals.nonCurrentAssets} compareTotal={c?.nonCurrentAssets} showCompare={compare} to={asOf} />
                <TotalLine pct={pct} grand label={t('reports.totalAssets')} value={data.totals.assets} compare={c?.assets} showCompare={compare} />
                <Section pct={pct} title={t('reports.currentLiabilities')} rows={data.sections.currentLiabilities} total={data.totals.currentLiabilities} compareTotal={c?.currentLiabilities} showCompare={compare} to={asOf} />
                <Section pct={pct}
                  title={t('reports.nonCurrentLiabilities')}
                  rows={data.sections.nonCurrentLiabilities}
                  total={data.totals.nonCurrentLiabilities}
                  compareTotal={c?.nonCurrentLiabilities}
                  showCompare={compare}
                  to={asOf}
                />
                <TotalLine pct={pct} label={t('reports.totalLiabilities')} value={data.totals.liabilities} compare={c?.liabilities} showCompare={compare} />
                <Section pct={pct}
                  title={t('reports.equity')}
                  rows={[
                    ...data.sections.equity,
                    {
                      id: -1,
                      code: '',
                      name_en: t('reports.currentEarnings'),
                      name_ar: t('reports.currentEarnings'),
                      amount: data.currentEarnings,
                      compare: data.compareCurrentEarnings ?? 0,
                    },
                  ]}
                  total={data.totals.equity}
                  compareTotal={c?.equity}
                  showCompare={compare}
                  to={asOf}
                />
                <TotalLine pct={pct} grand label={t('reports.liabilitiesAndEquity')} value={data.totals.liabilitiesAndEquity} compare={c?.liabilitiesAndEquity} showCompare={compare} />
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// ------------------------------------------------------------------ cash flow

interface CF {
  operating: { netIncome: number; nonCash: StatementRow[]; workingCapital: StatementRow[]; total: number };
  investing: { rows: StatementRow[]; total: number };
  financing: { rows: StatementRow[]; total: number };
  netChange: number;
  openingCash: number;
  closingCash: number;
  reconciled: boolean;
}

export function CashFlowPage() {
  const { t, pick } = useI18n();
  const csv = useCsvMoney();
  const { from, to, set } = usePeriod();
  const { data, isLoading } = useApi<CF>('/reports/cash-flow', { from, to });

  const exportCsv = () => {
    if (!data) return;
    const rows: (string | number)[][] = [[t('reports.operating'), ''], [t('reports.netIncome'), csv(data.operating.netIncome)]];
    const add = (list: StatementRow[]) => list.forEach((r) => rows.push([`${r.code} ${pick(r.name_en, r.name_ar)}`, csv(r.amount)]));
    add(data.operating.nonCash);
    add(data.operating.workingCapital);
    rows.push([t('common.total'), csv(data.operating.total)], [t('reports.investing'), '']);
    add(data.investing.rows);
    rows.push([t('common.total'), csv(data.investing.total)], [t('reports.financing'), '']);
    add(data.financing.rows);
    rows.push(
      [t('common.total'), csv(data.financing.total)],
      [t('reports.netChange'), csv(data.netChange)],
      [t('reports.openingCash'), csv(data.openingCash)],
      [t('reports.closingCash'), csv(data.closingCash)],
    );
    downloadCsv(`cash-flow-${from}-${to}`, [t('common.description'), t('common.amount')], rows);
  };

  return (
    <ReportFrame
      title={t('reports.cashFlow')}
      subtitle={t('reports.periodLabel', { from, to })}
      onExport={exportCsv}
      badge={data?.reconciled && <Badge tone="green">{t('reports.reconciled')}</Badge>}
      controls={<PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />}
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                <tr className="group-row">
                  <td colSpan={2}>{t('reports.operating')}</td>
                </tr>
                <tr>
                  <td style={{ paddingInlineStart: 34 }}>{t('reports.netIncome')}</td>
                  <td className="end num">
                    <Money v={data.operating.netIncome} parens />
                  </td>
                </tr>
                {[...data.operating.nonCash, ...data.operating.workingCapital].map((r) => (
                  <tr key={r.id}>
                    <td style={{ paddingInlineStart: 34 }}>
                      <span className="num faint" style={{ marginInlineEnd: 10 }}>
                        {r.code}
                      </span>
                      {pick(r.name_en, r.name_ar)}
                    </td>
                    <td className="end">
                      <Money v={r.amount} parens />
                    </td>
                  </tr>
                ))}
                <TotalLine label={t('common.total')} value={data.operating.total} />
                <Section title={t('reports.investing')} rows={data.investing.rows} total={data.investing.total} from={from} to={to} />
                <Section title={t('reports.financing')} rows={data.financing.rows} total={data.financing.total} from={from} to={to} />
                <TotalLine grand label={t('reports.netChange')} value={data.netChange} />
                <TotalLine label={t('reports.openingCash')} value={data.openingCash} />
                <TotalLine label={t('reports.closingCash')} value={data.closingCash} />
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// ------------------------------------------------------ changes in equity

interface EquityChanges {
  columns: ('capital' | 'retained' | 'dividends' | 'unclosed')[];
  lines: ({ key: string; total: number } & Record<'capital' | 'retained' | 'dividends' | 'unclosed', number>)[];
  reconciled: boolean;
}

/** Statement of changes in equity: what moved owners' equity during the period, column by column. */
export function EquityChangesPage() {
  const { t } = useI18n();
  const csv = useCsvMoney();
  const { from, to, set } = usePeriod();
  const { data, isLoading } = useApi<EquityChanges>('/reports/equity-changes', { from, to });
  const exportCsv = () =>
    data &&
    downloadCsv(
      `equity-changes-${from}-${to}`,
      ['', ...data.columns.map((c) => t('reports.equityCols.' + c)), t('common.total')],
      data.lines.map((l) => [t('reports.equityRows.' + l.key), ...data.columns.map((c) => csv(l[c])), csv(l.total)]),
    );
  return (
    <ReportFrame
      title={t('reports.equityChanges')}
      subtitle={t('reports.periodLabel', { from, to })}
      onExport={exportCsv}
      controls={<PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />}
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  {data.columns.map((c) => (
                    <th key={c} className="end">
                      {t('reports.equityCols.' + c)}
                    </th>
                  ))}
                  <th className="end">{t('common.total')}</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.key} className={l.key === 'opening' || l.key === 'closing' ? 'total-row' : ''}>
                    <td>{t('reports.equityRows.' + l.key)}</td>
                    {data.columns.map((c) => (
                      <td key={c} className="end">
                        <Money v={l[c]} parens dashZero />
                      </td>
                    ))}
                    <td className="end" style={{ fontWeight: 600 }}>
                      <Money v={l.total} parens />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data && (
        <p className={data.reconciled ? 'success-text' : 'danger-text'} style={{ fontSize: 13 }}>
          {data.reconciled ? t('reports.equityReconciled') : t('reports.equityNotReconciled')}
        </p>
      )}
    </ReportFrame>
  );
}
