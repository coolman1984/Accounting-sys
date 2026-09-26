import { Link } from 'react-router';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useApi, useDate } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { todayIso } from '../../core/format';
import { sourceLink } from '../../core/links';
import type { Account } from '../../core/types';
import { downloadCsv } from '../../lib/csv';
import { Card } from '../../ui/Card';
import { Loading, EmptyState } from '../../ui/Page';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { AccountPicker } from '../../ui/Pickers';
import { PeriodControls, ReportFrame, useCsvMoney, usePeriod } from './shared';

// ------------------------------------------------------------- trial balance

interface TBRow {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  type: string;
  opening_debit: number;
  opening_credit: number;
  debit: number;
  credit: number;
  closing_debit: number;
  closing_credit: number;
}

export function TrialBalancePage() {
  const { t, pick } = useI18n();
  const csv = useCsvMoney();
  const { from, to, set } = usePeriod();
  const { data, isLoading } = useApi<{ rows: TBRow[]; totals: Omit<TBRow, 'id' | 'code' | 'name_en' | 'name_ar' | 'type'>; balanced: boolean }>(
    '/reports/trial-balance',
    { from, to },
  );
  const cols = ['opening_debit', 'opening_credit', 'debit', 'credit', 'closing_debit', 'closing_credit'] as const;

  return (
    <ReportFrame
      title={t('reports.trialBalance')}
      subtitle={t('reports.periodLabel', { from, to })}
      badge={
        data &&
        (data.balanced ? (
          <Badge tone="green">
            <CheckCircle2 size={12} /> {t('reports.balanced')}
          </Badge>
        ) : (
          <Badge tone="red">
            <AlertTriangle size={12} /> {t('reports.notBalanced')}
          </Badge>
        ))
      }
      onExport={() =>
        data &&
        downloadCsv(
          `trial-balance-${from}-${to}`,
          [
            t('common.code'),
            t('common.account'),
            ...(['reports.opening', 'reports.movement', 'reports.closing'] as const).flatMap((g) => [`${t(g)} ${t('common.debit')}`, `${t(g)} ${t('common.credit')}`]),
          ],
          data.rows.map((r) => [r.code, pick(r.name_en, r.name_ar), ...cols.map((c) => csv(r[c]))]),
        )
      }
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
                  <th rowSpan={2}>{t('common.account')}</th>
                  <th colSpan={2} className="center">
                    {t('reports.opening')}
                  </th>
                  <th colSpan={2} className="center">
                    {t('reports.movement')}
                  </th>
                  <th colSpan={2} className="center">
                    {t('reports.closing')}
                  </th>
                </tr>
                <tr>
                  {[0, 1, 2].map((i) => (
                    <FragmentCols key={i} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/reports/general-ledger?accountId=${r.id}&from=${from}&to=${to}`}>
                        <span className="num faint" style={{ marginInlineEnd: 10 }}>
                          {r.code}
                        </span>
                        {pick(r.name_en, r.name_ar)}
                      </Link>
                    </td>
                    {cols.map((c) => (
                      <td key={c} className="end">
                        <Money v={r[c]} dashZero />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('common.totals')}</td>
                  {cols.map((c) => (
                    <td key={c} className="end">
                      <Money v={data.totals[c]} />
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

function FragmentCols() {
  const { t } = useI18n();
  return (
    <>
      <th className="end">{t('common.debit')}</th>
      <th className="end">{t('common.credit')}</th>
    </>
  );
}

// ------------------------------------------------------------ general ledger

interface GL {
  account: Account;
  opening: number;
  closing: number;
  totals: { debit: number; credit: number };
  rows: {
    entry_id: number;
    number: string;
    date: string;
    reference: string | null;
    memo: string | null;
    description: string | null;
    source_type: string;
    source_id: number | null;
    party_name: string | null;
    debit: number;
    credit: number;
    balance: number;
    account_code: string;
  }[];
}

export function GeneralLedgerPage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const csv = useCsvMoney();
  const { from, to, params, set } = usePeriod();
  const accountId = params.get('accountId') ? Number(params.get('accountId')) : null;
  const { data, isLoading } = useApi<GL>(accountId ? '/reports/general-ledger' : null, { accountId: accountId ?? undefined, from, to });
  // Show balances in the account's natural direction (credit-normal accounts as positive credits).
  const flip = data && !['asset', 'expense'].includes(data.account.type) ? -1 : 1;

  return (
    <ReportFrame
      title={t('reports.generalLedger')}
      subtitle={data ? `${data.account.code} · ${pick(data.account.name_en, data.account.name_ar)}` : t('reports.pickAccount')}
      onExport={
        data
          ? () =>
              downloadCsv(
                `ledger-${data.account.code}-${from}-${to}`,
                [t('common.date'), t('common.number'), t('common.memo'), t('common.debit'), t('common.credit'), t('common.balance')],
                [
                  [from, '', t('reports.opening'), '', '', csv(data.opening * flip!)],
                  ...data.rows.map((r) => [r.date, r.number, r.description || r.memo || '', csv(r.debit), csv(r.credit), csv(r.balance * flip!)]),
                ],
              )
          : undefined
      }
      controls={
        <>
          <div style={{ minWidth: 280 }}>
            <AccountPicker includeGroups value={accountId} onChange={(id) => set({ accountId: id ? String(id) : null })} />
          </div>
          <PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />
        </>
      }
    >
      <Card className="table-card">
        {!accountId ? (
          <EmptyState title={t('reports.pickAccount')} />
        ) : isLoading || !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('common.number')}</th>
                  <th>{t('common.description')}</th>
                  <th className="end">{t('common.debit')}</th>
                  <th className="end">{t('common.credit')}</th>
                  <th className="end">{t('common.balance')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="group-row">
                  <td colSpan={5}>{t('reports.opening')}</td>
                  <td className="end">
                    <Money v={data.opening * flip!} parens />
                  </td>
                </tr>
                {data.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap">{date(r.date)}</td>
                    <td className="nowrap">
                      <Link to={`/journal/${r.entry_id}`}>{r.number}</Link>
                    </td>
                    <td>
                      {sourceLink(r.source_type, r.source_id) ? (
                        <Link to={sourceLink(r.source_type, r.source_id)!} className="muted">
                          {r.memo}
                        </Link>
                      ) : (
                        <span className="muted">{r.description || r.memo}</span>
                      )}
                      {r.party_name && <div className="faint" style={{ fontSize: 12 }}>{r.party_name}</div>}
                    </td>
                    <td className="end">{r.debit ? <Money v={r.debit} /> : ''}</td>
                    <td className="end">{r.credit ? <Money v={r.credit} /> : ''}</td>
                    <td className="end">
                      <Money v={r.balance * flip!} parens />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>{t('reports.closing')}</td>
                  <td className="end">
                    <Money v={data.totals.debit} />
                  </td>
                  <td className="end">
                    <Money v={data.totals.credit} />
                  </td>
                  <td className="end">
                    <Money v={data.closing * flip!} parens />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// ---------------------------------------------------------------------- aging

interface AgingRow {
  party_id: number;
  party_name: string;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  unapplied: number;
  total: number;
}

export function AgingPage() {
  const { t } = useI18n();
  const csv = useCsvMoney();
  const { params, set } = usePeriod();
  const type = (params.get('type') as 'receivable' | 'payable') ?? 'receivable';
  const asOf = params.get('asOf') ?? todayIso();
  const { data, isLoading } = useApi<{ rows: AgingRow[]; totals: Omit<AgingRow, 'party_id' | 'party_name'> }>('/reports/aging', { type, asOf });
  const cols = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unapplied', 'total'] as const;
  const partyBase = type === 'receivable' ? '/customers' : '/suppliers';

  return (
    <ReportFrame
      title={`${t('reports.aging')} · ${t(type === 'receivable' ? 'reports.receivable' : 'reports.payable')}`}
      subtitle={`${t('common.asOf')} ${asOf}`}
      onExport={() =>
        data &&
        downloadCsv(
          `aging-${type}-${asOf}`,
          [t('reports.party'), ...cols.map((c) => (c === 'total' ? t('common.total') : t('reports.' + c)))],
          data.rows.map((r) => [r.party_name, ...cols.map((c) => csv(r[c]))]),
        )
      }
      controls={
        <>
          <div className="segmented">
            {(['receivable', 'payable'] as const).map((x) => (
              <button key={x} aria-pressed={type === x} onClick={() => set({ type: x })}>
                {t('reports.' + x)}
              </button>
            ))}
          </div>
          <span className="muted">{t('common.asOf')}</span>
          <input className="input" type="date" style={{ width: 'auto' }} value={asOf} onChange={(e) => set({ asOf: e.target.value })} />
        </>
      }
    >
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !data.rows.length ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reports.party')}</th>
                  {cols.map((c) => (
                    <th key={c} className="end">
                      {c === 'total' ? t('common.total') : t('reports.' + c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.party_id}>
                    <td>
                      <Link to={`${partyBase}/${r.party_id}`} style={{ fontWeight: 550 }}>
                        {r.party_name}
                      </Link>
                    </td>
                    {cols.map((c) => (
                      <td key={c} className={`end ${c === 'd90_plus' && r[c] > 0 ? 'danger-text' : ''}`} style={c === 'total' ? { fontWeight: 650 } : undefined}>
                        <Money v={r[c]} dashZero />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('common.totals')}</td>
                  {cols.map((c) => (
                    <td key={c} className="end">
                      <Money v={data.totals[c]} dashZero />
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

// ----------------------------------------------------------------- tax summary

export function TaxSummaryPage() {
  const { t, pick } = useI18n();
  const { from, to, set } = usePeriod('thisQuarter');
  const { data, isLoading } = useApi<{
    rows: { tax_id: number; code: string; name_en: string; name_ar: string; rate_bp: number; side: string; net: number; tax: number }[];
    output: number;
    input: number;
    net: number;
  }>('/reports/tax-summary', { from, to });

  return (
    <ReportFrame
      title={t('reports.taxSummary')}
      subtitle={t('reports.periodLabel', { from, to })}
      controls={<PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />}
    >
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <div className="grid-3">
            <Card className="kpi">
              <div className="kpi-label">{t('reports.outputTax')}</div>
              <div className="kpi-value">
                <Money v={data.output} />
              </div>
            </Card>
            <Card className="kpi">
              <div className="kpi-label">{t('reports.inputTax')}</div>
              <div className="kpi-value">
                <Money v={data.input} />
              </div>
            </Card>
            <Card className="kpi" >
              <div className="kpi-label">{t('reports.netTaxDue')}</div>
              <div className="kpi-value" style={{ color: 'var(--primary)' }}>
                <Money v={data.net} parens />
              </div>
            </Card>
          </div>
          <Card className="table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.tax')}</th>
                  <th>{t('taxes.scope')}</th>
                  <th className="end">{t('reports.rate')}</th>
                  <th className="end">{t('reports.taxable')}</th>
                  <th className="end">{t('docs.tax')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{pick(r.name_en, r.name_ar)}</td>
                    <td className="muted">{t('taxes.scopes.' + r.side)}</td>
                    <td className="end num">{r.rate_bp / 100}%</td>
                    <td className="end">
                      <Money v={r.net} parens />
                    </td>
                    <td className="end">
                      <Money v={r.tax} parens />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </ReportFrame>
  );
}
