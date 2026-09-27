import { useEffect, useState } from 'react';
import { FileSpreadsheet, Pencil, Percent, Plus } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatBp } from '../../core/format';
import type { Tax } from '../../core/types';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input, Select } from '../../ui/Field';
import { AccountPicker, useTaxes } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';
import { PeriodControls, ReportFrame, usePeriod } from '../../ui/Report';

/**
 * Tax (VAT): tax codes and the VAT summary for the return. Without this app
 * documents carry no tax and the tax columns disappear.
 */
function TaxDialog({ open, onClose, tax }: { open: boolean; onClose(): void; tax: Tax | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const blank = {
    code: '',
    nameEn: '',
    nameAr: '',
    rateBp: 1400 as number | null,
    scope: 'both' as Tax['scope'],
    salesAccountId: null as number | null,
    purchaseAccountId: null as number | null,
    isActive: true,
  };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      tax
        ? {
            code: tax.code,
            nameEn: tax.name_en,
            nameAr: tax.name_ar,
            rateBp: tax.rate_bp,
            scope: tax.scope,
            salesAccountId: tax.sales_account_id,
            purchaseAccountId: tax.purchase_account_id,
            isActive: !!tax.is_active,
          }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tax]);
  const save = useApiMutation((body: object) => (tax ? api.put(`/taxes/${tax.id}`, body) : api.post('/taxes', body)));
  const submit = () =>
    save.mutate({ ...f, rateBp: f.rateBp ?? 0 }, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={tax ? t('taxes.edit') : t('taxes.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.code || !f.nameEn || !f.nameAr} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.code')}>
            <Input value={f.code} onChange={(e) => set('code', e.target.value)} />
          </Field>
          <Field label={t('taxes.rate')}>
            <DecimalInput trim scale={2} value={f.rateBp} onChange={(v) => set('rateBp', v == null ? null : Math.min(v, 10000))} />
          </Field>
          <Field label={t('common.nameEn')}>
            <Input dir="ltr" value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} />
          </Field>
        </div>
        <Field label={t('taxes.scope')}>
          <Select value={f.scope} onChange={(e) => set('scope', e.target.value as Tax['scope'])}>
            {(['both', 'sales', 'purchases'] as const).map((s) => (
              <option key={s} value={s}>
                {t('taxes.scopes.' + s)}
              </option>
            ))}
          </Select>
        </Field>
        {f.scope !== 'purchases' && (
          <Field label={t('taxes.salesAccount')}>
            <AccountPicker value={f.salesAccountId} onChange={(v) => set('salesAccountId', v)} filter={(a) => a.type === 'liability' || a.type === 'asset'} />
          </Field>
        )}
        {f.scope !== 'sales' && (
          <Field label={t('taxes.purchaseAccount')}>
            <AccountPicker value={f.purchaseAccountId} onChange={(v) => set('purchaseAccountId', v)} filter={(a) => a.type === 'asset' || a.type === 'liability'} />
          </Field>
        )}
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => set('isActive', v)} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function TaxesPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const [dialog, setDialog] = useState<{ tax: Tax | null } | null>(null);
  const { data, isLoading } = useTaxes();
  return (
    <div className="page">
      <PageHeader
        title={t('taxes.title')}
        subtitle={t('taxes.subtitle')}
        actions={
          can('tax.codes.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ tax: null })}>
              {t('taxes.new')}
            </Button>
          )
        }
      />
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <EmptyState icon={<Percent size={22} />} title={t('common.noResults')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.code')}</th>
                <th>{t('common.name')}</th>
                <th className="end">{t('taxes.rate')}</th>
                <th>{t('taxes.scope')}</th>
                <th>{t('common.status')}</th>
                <th className="shrink" />
              </tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.id}>
                  <td style={{ fontWeight: 600 }}>{x.code}</td>
                  <td>{pick(x.name_en, x.name_ar)}</td>
                  <td className="end num">{formatBp(x.rate_bp)}</td>
                  <td className="muted">{t('taxes.scopes.' + x.scope)}</td>
                  <td>{x.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                  <td>{can('tax.codes.write') && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setDialog({ tax: x })} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <TaxDialog open={!!dialog} onClose={() => setDialog(null)} tax={dialog?.tax ?? null} />
    </div>
  );
}


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

export const taxModule: WebModule = {
  id: 'tax',
  nav: [
    { to: '/taxes', label: 'nav.taxes', icon: Percent, section: 'tax', order: 10, perm: 'tax.codes.read', app: 'tax' },
    { to: '/reports/tax', label: 'reports.taxSummary', icon: FileSpreadsheet, section: 'tax', order: 20, perm: 'tax.reports.read', app: 'tax' },
  ],
  routes: [
    { path: '/taxes', element: <TaxesPage /> },
    { path: '/reports/tax', element: <TaxSummaryPage /> },
  ],
  commands: [
    { id: 'go-taxes', label: 'nav.taxes', icon: Percent, group: 'navigate', to: '/taxes', perm: 'tax.codes.read', app: 'tax', keywords: 'vat ضريبة' },
    { id: 'go-tax', label: 'reports.taxSummary', icon: FileSpreadsheet, group: 'navigate', to: '/reports/tax', perm: 'tax.reports.read', app: 'tax', keywords: 'vat return إقرار ضريبة' },
  ],
  reports: [
    { to: '/reports/tax', group: 'reports.groups.tax', title: 'reports.taxSummary', desc: 'reports.taxSummaryDesc', icon: Percent, color: 'var(--line-purple)', perm: 'tax.reports.read', app: 'tax' },
  ],
};
