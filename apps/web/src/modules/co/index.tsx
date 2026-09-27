import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Plus, PieChart, Target } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, Field, Input, Select } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { PeriodControls, ReportFrame, usePeriod } from '../../ui/Report';
import type { CostCenter } from '../../ui/CostCenter';

type Row = CostCenter & { lines: number };

function CostCenterDialog({ open, row, all, onClose }: { open: boolean; row: Row | null; all: Row[]; onClose(): void }) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState({ code: '', nameEn: '', nameAr: '', parentId: null as number | null, isActive: true });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(row ? { code: row.code, nameEn: row.name_en, nameAr: row.name_ar, parentId: row.parent_id, isActive: !!row.is_active } : { code: '', nameEn: '', nameAr: '', parentId: null, isActive: true });
  }, [open, row]);
  const save = useApiMutation(() => (row ? api.put(`/cost-centers/${row.id}`, f) : api.post('/cost-centers', f)));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row ? t('co.edit') : t('co.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.code.trim() || !f.nameEn.trim()}
            onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('common.code')}>
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} dir="ltr" autoFocus />
        </Field>
        <div className="grid-2">
          <Field label={t('common.nameEn')}>
            <Input value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value, nameAr: f.nameAr || '' })} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} dir="rtl" />
          </Field>
        </div>
        <Field label={t('co.parent')}>
          <Select value={f.parentId ?? ''} onChange={(e) => setF({ ...f, parentId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">—</option>
            {all
              .filter((c) => c.id !== row?.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {pick(c.name_en, c.name_ar)}
                </option>
              ))}
          </Select>
        </Field>
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function CostCentersPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { data, isLoading } = useApi<Row[]>('/cost-centers');
  const [dialog, setDialog] = useState<{ row: Row | null } | null>(null);
  const byId = useMemo(() => new Map((data ?? []).map((c) => [c.id, c])), [data]);
  const columns = useMemo<Column<Row>[]>(
    () => [
      { id: 'code', header: t('common.code'), pinned: true, width: 110, value: (c) => c.code, render: (c) => <span className="num" style={{ fontWeight: 600 }}>{c.code}</span> },
      { id: 'name', header: t('common.name'), value: (c) => pick(c.name_en, c.name_ar) },
      { id: 'parent', header: t('co.parent'), type: 'enum', value: (c) => (c.parent_id ? byId.get(c.parent_id)?.code ?? null : null) },
      { id: 'lines', header: t('co.postings'), type: 'number', value: (c) => c.lines },
      { id: 'status', header: t('common.status'), type: 'enum', value: (c) => (c.is_active ? 'active' : 'inactive'), format: (v) => t('common.' + v), render: (c) => (c.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>) },
    ],
    [t, pick, byId],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('co.title')}
        subtitle={t('co.subtitle')}
        actions={
          <>
            <Link to="/reports/cost-centers" className="btn">
              <PieChart /> {t('co.report')}
            </Link>
            {can('co.costcenters.write') && (
              <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ row: null })}>
                {t('co.new')}
              </Button>
            )}
          </>
        }
      />
      <DataGrid
        id="cost-centers"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(c) => c.id}
        onRowClick={(c) => can('co.costcenters.write') && setDialog({ row: c })}
        empty={<EmptyState icon={<Target size={22} />} title={t('co.empty')} text={t('co.subtitle')} />}
      />
      <CostCenterDialog open={!!dialog} row={dialog?.row ?? null} all={data ?? []} onClose={() => setDialog(null)} />
    </div>
  );
}

interface Report {
  from: string;
  to: string;
  rows: { account_id: number; code: string; name_en: string; name_ar: string; type: 'income' | 'expense'; cost_center_id: number | null; amount: number }[];
  centers: CostCenter[];
  profit: { cost_center_id: number | null; profit: number }[];
}

/** Profit & loss by cost center: accounts down, cost centers across. */
function CostCenterReport() {
  const { t, pick } = useI18n();
  const { from, to, set } = usePeriod();
  const { data, isLoading } = useApi<Report>('/reports/cost-centers', { from, to });
  const used = data ? [...data.centers.filter((c) => data.rows.some((r) => r.cost_center_id === c.id)), ...(data.rows.some((r) => r.cost_center_id == null) ? [null] : [])] : [];
  const accounts = data ? [...new Map(data.rows.map((r) => [r.account_id, r])).values()] : [];
  const cell = (acc: number, cc: number | null) => data?.rows.find((r) => r.account_id === acc && r.cost_center_id === cc)?.amount ?? 0;
  return (
    <ReportFrame title={t('co.report')} subtitle={t('reports.periodLabel', { from, to })} controls={<PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />}>
      <Card className="table-card">
        {isLoading || !data ? (
          <Loading />
        ) : !accounts.length ? (
          <EmptyState icon={<PieChart size={22} />} title={t('common.noResults')} text={t('co.reportEmpty')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.account')}</th>
                  {used.map((c) => (
                    <th key={c?.id ?? 'none'} className="end">
                      {c ? c.code : t('co.unassigned')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['income', 'expense'] as const).map((type) => (
                  <Fragment key={type}>
                    <tr className="group-row">
                      <td colSpan={used.length + 1}>{t(type === 'income' ? 'reports.revenue' : 'reports.expenses')}</td>
                    </tr>
                    {accounts
                      .filter((a) => a.type === type)
                      .map((a) => (
                        <tr key={a.account_id}>
                          <td>
                            <span className="num faint" style={{ marginInlineEnd: 8 }}>
                              {a.code}
                            </span>
                            {pick(a.name_en, a.name_ar)}
                          </td>
                          {used.map((c) => (
                            <td key={c?.id ?? 'none'} className="end">
                              <Money v={cell(a.account_id, c?.id ?? null)} dashZero />
                            </td>
                          ))}
                        </tr>
                      ))}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('co.profit')}</td>
                  {used.map((c) => {
                    const p = data.profit.find((x) => x.cost_center_id === (c?.id ?? null))?.profit ?? 0;
                    return (
                      <td key={c?.id ?? 'none'} className={`end ${p < 0 ? 'danger-text' : ''}`}>
                        <Money v={p} />
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </ReportFrame>
  );
}

/** Controlling (like SAP CO, kept small): cost centers on ledger lines and a P&L per center. */
export const coModule: WebModule = {
  id: 'co',
  nav: [
    { to: '/cost-centers', label: 'nav.costCenters', icon: Target, section: 'co', order: 10, perm: 'co.costcenters.read', app: 'co' },
    { to: '/reports/cost-centers', label: 'co.report', icon: PieChart, section: 'co', order: 20, perm: 'co.reports.read', app: 'co' },
  ],
  routes: [
    { path: '/cost-centers', element: <CostCentersPage /> },
    { path: '/reports/cost-centers', element: <CostCenterReport /> },
  ],
  commands: [
    { id: 'go-cost-centers', label: 'nav.costCenters', icon: Target, group: 'navigate', to: '/cost-centers', perm: 'co.costcenters.read', app: 'co', keywords: 'cost center مراكز تكلفة' },
    { id: 'go-co-report', label: 'co.report', icon: PieChart, group: 'navigate', to: '/reports/cost-centers', perm: 'co.reports.read', app: 'co', keywords: 'profit cost center ربحية مراكز' },
  ],
  reports: [
    { to: '/reports/cost-centers', group: 'reports.groups.statements', title: 'co.report', desc: 'co.reportDesc', icon: PieChart, color: 'var(--line-teal)', perm: 'co.reports.read', app: 'co' },
  ],
};
