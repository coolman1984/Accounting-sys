import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, AlertTriangle, Save } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate } from '../../core/format';
import { Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Money } from '../../ui/Money';
import { DecimalInput, Field } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { useToast } from '../../ui/Toast';
import { PeriodControls, ReportFrame, usePeriod } from '../../ui/Report';

type WhtType = 'supplies' | 'contracting' | 'services' | 'commissions';
const TYPES: WhtType[] = ['supplies', 'contracting', 'services', 'commissions'];
interface Settings {
  agent: boolean;
  minBase: number;
  rates: Record<WhtType, number>;
}
interface Report {
  rows: { id: number; number: string; date: string; party_id: number; party_name: string; tax_number: string | null; wht_type: WhtType; wht_base: number; wht_rate_bp: number; wht_amount: number }[];
  byType: { type: WhtType; count: number; base: number; amount: number }[];
  base: number;
  total: number;
  ledger: { accountId: number; balance: number } | null;
}

/**
 * Withholding (خصم وإضافة): what the company deducted from suppliers (Form 41, paid each quarter)
 * and what customers deducted from it (a credit against its income tax), reconciled to the books.
 */
export function WithholdingPage() {
  const { t, locale } = useI18n();
  const { from, to, set } = usePeriod('thisQuarter');
  const [side, setSide] = useState<'deducted' | 'suffered'>('deducted');
  const { data, isLoading } = useApi<Report>('/reports/withholding', { from, to, side });
  // The books hold every period together; a difference is expected only if earlier periods are unpaid.
  const reconciled = data?.ledger ? data.ledger.balance === data.total : null;
  return (
    <ReportFrame
      title={t('wht.reportTitle')}
      subtitle={t('reports.periodLabel', { from, to })}
      controls={
        <>
          <div className="segmented">
            {(['deducted', 'suffered'] as const).map((s) => (
              <button key={s} aria-pressed={side === s} onClick={() => setSide(s)}>
                {t('wht.side.' + s)}
              </button>
            ))}
          </div>
          <PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />
        </>
      }
    >
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <p className="muted" style={{ margin: 0 }}>
            {t(side === 'deducted' ? 'wht.deductedExplain' : 'wht.sufferedExplain')}
          </p>
          <div className="grid-3">
            <Card className="kpi">
              <div className="kpi-label">{t('wht.base')}</div>
              <div className="kpi-value">
                <Money v={data.base} />
              </div>
            </Card>
            <Card className="kpi">
              <div className="kpi-label">{t(side === 'deducted' ? 'wht.totalDeducted' : 'wht.totalSuffered')}</div>
              <div className="kpi-value" style={{ color: 'var(--primary)' }}>
                <Money v={data.total} />
              </div>
            </Card>
            <Card className="kpi">
              <div className="kpi-label">{t('wht.inBooks')}</div>
              <div className="kpi-value">{data.ledger ? <Money v={data.ledger.balance} /> : '—'}</div>
              {reconciled != null && (
                <div className={reconciled ? 'success-text row' : 'warning-text row'} style={{ gap: 6, fontSize: 12.5, marginTop: 4 }}>
                  {reconciled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                  {reconciled ? t('wht.reconciled') : t('wht.notReconciled')}
                </div>
              )}
            </Card>
          </div>
          {data.byType.length > 0 && (
            <Card className="table-card">
              <CardHeader title={t('wht.byType')} />
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('wht.type')}</th>
                    <th className="end">{t('wht.count')}</th>
                    <th className="end">{t('wht.base')}</th>
                    <th className="end">{t('wht.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byType.map((r) => (
                    <tr key={r.type}>
                      <td>{t('wht.types.' + r.type)}</td>
                      <td className="end num">{r.count}</td>
                      <td className="end">
                        <Money v={r.base} />
                      </td>
                      <td className="end">
                        <Money v={r.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Card className="table-card">
            <CardHeader title={t('wht.details')} sub={t('wht.detailsSub')} />
            {!data.rows.length ? (
              <div className="card-body muted">{t('wht.noneInPeriod')}</div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('common.number')}</th>
                      <th>{t(side === 'deducted' ? 'wht.supplier' : 'wht.customer')}</th>
                      <th>{t('common.taxNumber')}</th>
                      <th>{t('wht.type')}</th>
                      <th className="end">{t('wht.base')}</th>
                      <th className="end">{t('wht.rate')}</th>
                      <th className="end">{t('wht.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="nowrap">{formatDate(r.date, locale)}</td>
                        <td>
                          <Link to={`${side === 'deducted' ? '/payments' : '/receipts'}/${r.id}`} className="num">
                            {r.number}
                          </Link>
                        </td>
                        <td>{r.party_name}</td>
                        <td className={r.tax_number ? 'num' : 'warning-text'}>{r.tax_number ?? t('wht.noTaxNumber')}</td>
                        <td>{t('wht.types.' + r.wht_type)}</td>
                        <td className="end">
                          <Money v={r.wht_base} />
                        </td>
                        <td className="end num">{r.wht_rate_bp / 100}%</td>
                        <td className="end">
                          <Money v={r.wht_amount} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <WithholdingSettings />
        </div>
      )}
    </ReportFrame>
  );
}

function WithholdingSettings() {
  const { t } = useI18n();
  const { can } = useSession();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const { data } = useApi<Settings>('/tax/withholding');
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  const save = useApiMutation(() => api.put('/tax/withholding', f));
  if (!f) return null;
  const editable = can('tax.codes.write');
  return (
    <Card>
      <CardHeader
        title={t('wht.settings')}
        sub={t('wht.settingsSub')}
        actions={
          editable && (
            <Button size="sm" variant="primary" icon={<Save />} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => toast.success(t('common.saved')), onError: (e) => toast.error(errText(e)) })}>
              {t('common.save')}
            </Button>
          )
        }
      />
      <div className="card-body stack">
        <div className="grid-3">
          <Field label={t('wht.agent')} hint={t('wht.agentHint')}>
            <Switch checked={f.agent} disabled={!editable} onChange={(v) => setF({ ...f, agent: v })} />
          </Field>
          <Field label={t('wht.minBase')} hint={t('wht.minBaseHint')}>
            <DecimalInput scale={scale} value={f.minBase} disabled={!editable} onChange={(v) => setF({ ...f, minBase: v ?? 0 })} />
          </Field>
        </div>
        <div className="grid-4">
          {TYPES.map((k) => (
            <Field key={k} label={`${t('wht.types.' + k)} (%)`}>
              <DecimalInput scale={2} trim value={f.rates[k]} disabled={!editable} onChange={(v) => setF({ ...f, rates: { ...f.rates, [k]: v ?? 0 } })} />
            </Field>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
          {t('wht.ratesNote')}
        </p>
      </div>
    </Card>
  );
}
