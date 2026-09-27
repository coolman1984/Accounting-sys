import { useEffect, useMemo, useState } from 'react';
import { Coins, Plus, Scale, Trash2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate, todayIso } from '../../core/format';
import { PageHeader, EmptyState, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { RATE_ONE, RATE_SCALE, type CurrencyRow } from '../../ui/Currency';

const showRate = (r: number | null) => (r == null ? '—' : (r / RATE_ONE).toLocaleString('en', { maximumFractionDigits: 6 }));

// ---------------------------------------------------------------- currencies

function CurrencyDialog({ row, open, onClose }: { row: CurrencyRow | null; open: boolean; onClose(): void }) {
  const { t, locale } = useI18n();
  const { company, can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const base = company?.baseCurrency ?? '';
  const [f, setF] = useState({ code: '', nameEn: '', nameAr: '', symbol: '', isActive: true });
  const [rate, setRate] = useState<{ date: string; rate: number | null }>({ date: todayIso(), rate: null });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    setRate({ date: todayIso(), rate: null });
    setF(row ? { code: row.code, nameEn: row.name_en, nameAr: row.name_ar, symbol: row.symbol ?? '', isActive: !!row.is_active } : { code: '', nameEn: '', nameAr: '', symbol: '', isActive: true });
  }, [open, row]);
  const { data: rates } = useApi<{ id: number; date: string; rate: number }[]>(row ? '/fx/rates' : null, { currency: row?.code });
  const save = useApiMutation(() => (row ? api.put(`/currencies/${row.code}`, f) : api.post('/currencies', f)));
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const writable = can('fx.rates.write');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row ? `${row.code} · ${locale === 'ar' ? row.name_ar : row.name_en}` : t('fx.newCurrency')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {writable && (
            <Button variant="primary" loading={save.isPending} disabled={!f.code || !f.nameEn} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}>
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.code')} hint={t('fx.codeHint')}>
            <Input value={f.code} disabled={!!row} maxLength={3} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} dir="ltr" />
          </Field>
          <Field label={t('fx.symbol')}>
            <Input value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })} />
          </Field>
          <Field label={t('common.nameEn')}>
            <Input value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} dir="rtl" />
          </Field>
        </div>
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
        {row && (
          <Card>
            <CardHeader title={t('fx.rates')} sub={t('fx.ratesSub', { currency: row.code, base })} />
            {writable && (
              <div className="row" style={{ gap: 8, padding: '10px 14px', alignItems: 'flex-end' }}>
                <Field label={t('common.date')}>
                  <Input type="date" value={rate.date} onChange={(e) => setRate({ ...rate, date: e.target.value })} />
                </Field>
                <Field label={`1 ${row.code} = … ${base}`}>
                  <DecimalInput scale={RATE_SCALE} trim value={rate.rate} onChange={(v) => setRate({ ...rate, rate: v })} />
                </Field>
                <Button
                  icon={<Plus />}
                  disabled={!rate.rate}
                  onClick={() =>
                    act.mutate(() => api.post('/fx/rates', { currency: row.code, date: rate.date, rate: rate.rate }), {
                      onSuccess: () => (toast.success(t('common.saved')), setRate({ ...rate, rate: null })),
                      onError: (e) => toast.error(errText(e)),
                    })
                  }
                >
                  {t('common.add')}
                </Button>
              </div>
            )}
            <div className="table-wrap" style={{ maxHeight: 260 }}>
              <table className="table table-compact">
                <tbody>
                  {(rates ?? []).map((r) => (
                    <tr key={r.id}>
                      <td className="nowrap">{formatDate(r.date, locale)}</td>
                      <td className="end num">{showRate(r.rate)}</td>
                      <td className="end faint num" title={t('fx.inverse')}>
                        {(RATE_ONE / r.rate).toLocaleString('en', { maximumFractionDigits: 6 })}
                      </td>
                      <td className="shrink">
                        {writable && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => act.mutate(() => api.del(`/fx/rates/${r.id}`))} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rates?.length === 0 && <div className="card-body muted">{t('fx.noRates')}</div>}
            </div>
          </Card>
        )}
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function CurrenciesPage() {
  const { t, pick, locale } = useI18n();
  const { company, can } = useSession();
  const { data, isLoading } = useApi<CurrencyRow[]>('/currencies');
  const [dialog, setDialog] = useState<{ row: CurrencyRow | null } | null>(null);
  const columns = useMemo<Column<CurrencyRow>[]>(
    () => [
      { id: 'code', header: t('common.code'), pinned: true, width: 90, value: (c) => c.code, render: (c) => <strong className="num">{c.code}</strong> },
      { id: 'name', header: t('common.name'), value: (c) => pick(c.name_en, c.name_ar) },
      { id: 'symbol', header: t('fx.symbol'), value: (c) => c.symbol },
      { id: 'rate', header: t('fx.lastRate', { base: company?.baseCurrency ?? '' }), type: 'number', value: (c) => (c.last_rate ?? 0) / RATE_ONE, render: (c) => <span className="num">{showRate(c.last_rate)}</span> },
      { id: 'date', header: t('fx.rateDate'), type: 'date', value: (c) => c.last_rate_date, render: (c) => (c.last_rate_date ? formatDate(c.last_rate_date, locale) : <span className="warning-text">{t('fx.noRate')}</span>) },
      { id: 'status', header: t('common.status'), type: 'enum', value: (c) => (c.is_active ? 'active' : 'inactive'), format: (v) => t('common.' + v), render: (c) => (c.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>) },
    ],
    [t, pick, locale, company],
  );
  if (isLoading) return <Loading />;
  return (
    <div className="page">
      <PageHeader
        title={t('fx.title')}
        subtitle={t('fx.subtitle', { base: company?.baseCurrency ?? '' })}
        actions={
          can('fx.rates.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ row: null })}>
              {t('fx.newCurrency')}
            </Button>
          )
        }
      />
      <DataGrid id="fx.currencies" rows={data} columns={columns} rowKey={(c) => c.code} onRowClick={(c) => setDialog({ row: c })} exportName={t('fx.title')} empty={<EmptyState icon={<Coins size={22} />} title={t('common.noResults')} />} />
      <CurrencyDialog open={!!dialog} row={dialog?.row ?? null} onClose={() => setDialog(null)} />
    </div>
  );
}

// ---------------------------------------------------------------- revaluation

interface Preview {
  date: string;
  open: { side: 'receivable' | 'payable'; currency: string; fx: number; carrying: number; revalued: number; rate: number; difference: number }[];
  cash: { id: number; code: string; name_en: string; name_ar: string; currency: string; fx: number; carrying: number; revalued: number; rate: number; difference: number }[];
  net: number;
}

function RevaluationPage() {
  const { t, pick, locale } = useI18n();
  const { can } = useSession();
  const { fmt } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [date, setDate] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10); // last day of last month
  });
  const { data: preview, error, isLoading } = useApi<Preview>('/fx/revaluations/preview', { date }, { retry: false });
  const { data: history } = useApi<{ id: number; date: string; entry_id: number; entry_number: string; reversal_number: string; details: Preview }[]>('/fx/revaluations');
  const post = useApiMutation(() => api.post<{ net: number }>('/fx/revaluations', { date }));
  const rows = [
    ...(preview?.open ?? []).map((g) => ({ key: g.side + g.currency, label: t(`fx.side.${g.side}`), ...g })),
    ...(preview?.cash ?? []).map((a) => ({ key: 'c' + a.id, label: `${a.code} · ${pick(a.name_en, a.name_ar)}`, ...a })),
  ];
  return (
    <div className="page">
      <PageHeader title={t('fx.revaluation')} subtitle={t('fx.revaluationSub')} />
      <Card pad>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label={t('fx.revaluationDate')}>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <span className="spacer" />
          {preview && (
            <div className="stack" style={{ gap: 2, textAlign: 'end' }}>
              <span className="faint" style={{ fontSize: 12 }}>{preview.net >= 0 ? t('fx.netGain') : t('fx.netLoss')}</span>
              <strong className={preview.net >= 0 ? 'success-text' : 'danger-text'} style={{ fontSize: 20 }}>
                {fmt(Math.abs(preview.net))}
              </strong>
            </div>
          )}
          {can('fx.revaluations.post') && (
            <Button
              variant="primary"
              icon={<Scale />}
              loading={post.isPending}
              disabled={!rows.length}
              onClick={() => post.mutate(undefined, { onSuccess: () => toast.success(t('fx.posted')), onError: (e) => toast.error(errText(e)) })}
            >
              {t('fx.post')}
            </Button>
          )}
        </div>
        <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>{t('fx.revaluationHint')}</p>
      </Card>
      <Card>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <div className="card-body danger-text">{errText(error)}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Scale size={22} />} title={t('fx.nothing')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>{t('fx.currency')}</th>
                  <th className="end">{t('fx.foreignAmount')}</th>
                  <th className="end">{t('fx.booked')}</th>
                  <th className="end">{t('fx.rate')}</th>
                  <th className="end">{t('fx.revalued')}</th>
                  <th className="end">{t('fx.difference')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="num">{r.currency}</td>
                    <td className="end">
                      <Money v={r.fx} />
                    </td>
                    <td className="end">
                      <Money v={r.carrying} />
                    </td>
                    <td className="end num">{showRate(r.rate)}</td>
                    <td className="end">
                      <Money v={r.revalued} />
                    </td>
                    <td className="end">
                      <Money v={r.difference} tone />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!!history?.length && (
        <Card>
          <CardHeader title={t('fx.history')} />
          <table className="table table-compact">
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{formatDate(h.date, locale)}</td>
                  <td className="faint">
                    {h.entry_number} → {h.reversal_number}
                  </td>
                  <td className="end">
                    <Money v={h.details.net} tone />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export const fxModule: WebModule = {
  id: 'fx',
  nav: [
    { to: '/currencies', label: 'nav.currencies', icon: Coins, section: 'treasury', order: 50, app: 'fx' },
    { to: '/fx/revaluation', label: 'fx.revaluation', icon: Scale, section: 'treasury', order: 60, perm: 'fx.revaluations.read', app: 'fx' },
  ],
  routes: [
    { path: '/currencies', element: <CurrenciesPage /> },
    { path: '/fx/revaluation', element: <RevaluationPage /> },
  ],
  commands: [
    { id: 'go-currencies', label: 'nav.currencies', icon: Coins, group: 'navigate', to: '/currencies', app: 'fx', keywords: 'currency exchange rate dollar عملة سعر صرف دولار' },
    { id: 'go-reval', label: 'fx.revaluation', icon: Scale, group: 'navigate', to: '/fx/revaluation', perm: 'fx.revaluations.read', app: 'fx', keywords: 'revaluation فروق عملة إعادة تقييم' },
  ],
};
