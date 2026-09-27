import { Link, useNavigate } from 'react-router';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { todayIso } from '../../core/format';
import { downloadCsv } from '../../lib/csv';
import { Card } from '../../ui/Card';
import { Loading, EmptyState } from '../../ui/Page';
import { Money } from '../../ui/Money';
import { ReportFrame, useCsvMoney, usePeriod } from '../../ui/Report';

/** Partner ageing (receivables for AR, payables for AP) — one page, mounted by each module. */
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

export function AgingPage({ type }: { type: 'receivable' | 'payable' }) {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const csv = useCsvMoney();
  const { params, set } = usePeriod();
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
            {(['receivable', 'payable'] as const).filter((x) => can(x === 'receivable' ? 'ar.reports.read' : 'ap.reports.read')).map((x) => (
              <button key={x} aria-pressed={type === x} onClick={() => navigate(`/reports/aging/${x}?${params.toString()}`)}>
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

