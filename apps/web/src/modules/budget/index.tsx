import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BarChart3, CheckCircle2, ClipboardList, Copy, Plus, RotateCcw, Save, Trash2, Wand2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate, todayIso } from '../../core/format';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { DecimalInput, Field, Input, Select } from '../../ui/Field';
import { AccountPicker, ItemPicker } from '../../ui/Pickers';
import { CostCenterSelect, useCostCenters } from '../../ui/CostCenter';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';

const MONTHS = 12;

interface BudgetRow {
  id: number;
  name: string;
  start_date: string;
  status: 'draft' | 'approved';
  notes: string | null;
  lines: number;
  sales_lines: number;
  approved_at: string | null;
}
interface BudgetFull extends Omit<BudgetRow, 'lines' | 'sales_lines'> {
  months: string[];
  lines: {
    account_id: number;
    cost_center_id: number | null;
    amounts: number[];
    code: string;
    name_en: string;
    name_ar: string;
    type: string;
  }[];
  sales: {
    item_id: number;
    quantities: number[];
    unit_price: number;
    unit_cost: number;
    sku: string;
    name_en: string;
    name_ar: string;
  }[];
}

/** Evenly over the months, remainder in the last one (same rule as the server). */
function spread(total: number): number[] {
  const each = Math.trunc(total / MONTHS);
  const out = Array(MONTHS).fill(each);
  out[MONTHS - 1] += total - each * MONTHS;
  return out;
}
const sum = (a: number[]) => a.reduce((s, v) => s + (v ?? 0), 0);

function useMonthLabels(months: string[]) {
  const { locale } = useI18n();
  return months.map((m) => new Date(m + '-01T00:00:00').toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { month: 'short' }));
}

// ------------------------------------------------------------------ list

function NewBudgetDialog({ open, onClose, budgets }: { open: boolean; onClose(): void; budgets: BudgetRow[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const errText = useErrorText();
  const year = new Date().getFullYear();
  // Default source: the last 12 complete months (months are matched by calendar month on the server).
  const back = new Date(year, new Date().getMonth() - 12, 1);
  const lastYear = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}`;
  const [f, setF] = useState({
    name: '',
    start: `${year + 1}-01`,
    source: 'actuals' as 'empty' | 'actuals' | 'copy',
    from: lastYear,
    uplift: 0 as number | null,
    pattern: 'seasonal' as 'seasonal' | 'even',
    copyOf: null as number | null,
  });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) setErr('');
  }, [open]);
  const save = useApiMutation(() =>
    api.post<{ id: number }>('/budgets', {
      name: f.name || t('budget.defaultName', { year: f.start.slice(0, 4) }),
      startDate: `${f.start}-01`,
      seed:
        f.source === 'actuals'
          ? {
              from: `${f.from}-01`,
              upliftBp: f.uplift ?? 0,
              pattern: f.pattern,
            }
          : null,
      copyOf: f.source === 'copy' ? f.copyOf : null,
    }),
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('budget.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={f.source === 'copy' && !f.copyOf}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (r) => (onClose(), navigate(`/budgets/${r.id}`)),
                onError: (e) => setErr(errText(e)),
              })
            }
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.name')}>
            <Input
              value={f.name}
              placeholder={t('budget.defaultName', {
                year: f.start.slice(0, 4),
              })}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </Field>
          <Field label={t('budget.firstMonth')}>
            <Input type="month" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
        </div>
        <Field label={t('budget.startFrom')}>
          <Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as typeof f.source })}>
            <option value="actuals">{t('budget.fromActuals')}</option>
            <option value="copy">{t('budget.fromBudget')}</option>
            <option value="empty">{t('budget.empty')}</option>
          </Select>
        </Field>
        {f.source === 'actuals' && (
          <div className="grid-3">
            <Field label={t('budget.actualsFrom')} hint={t('budget.actualsFromHint')}>
              <Input type="month" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            </Field>
            <Field label={t('budget.uplift')}>
              <DecimalInput scale={2} trim allowNegative value={f.uplift} onChange={(v) => setF({ ...f, uplift: v })} />
            </Field>
            <Field label={t('budget.pattern')}>
              <Select value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value as 'seasonal' | 'even' })}>
                <option value="seasonal">{t('budget.seasonal')}</option>
                <option value="even">{t('budget.even')}</option>
              </Select>
            </Field>
          </div>
        )}
        {f.source === 'copy' && (
          <Field label={t('budget.copyOf')}>
            <Select
              value={f.copyOf ?? ''}
              onChange={(e) =>
                setF({
                  ...f,
                  copyOf: e.target.value ? Number(e.target.value) : null,
                })
              }
            >
              <option value="">{t('common.select')}</option>
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function BudgetsPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<BudgetRow[]>('/budgets');
  const [creating, setCreating] = useState(false);
  const columns = useMemo<Column<BudgetRow>[]>(
    () => [
      {
        id: 'name',
        header: t('common.name'),
        pinned: true,
        value: (b) => b.name,
        render: (b) => <strong>{b.name}</strong>,
      },
      {
        id: 'start',
        header: t('budget.firstMonth'),
        type: 'date',
        value: (b) => b.start_date,
        render: (b) => formatDate(b.start_date, locale),
      },
      {
        id: 'lines',
        header: t('budget.lines'),
        type: 'number',
        value: (b) => b.lines + b.sales_lines,
      },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (b) => b.status,
        format: (v) => t('budget.status.' + v),
        render: (b) => <Badge tone={b.status === 'approved' ? 'green' : 'amber'}>{t('budget.status.' + b.status)}</Badge>,
      },
      {
        id: 'report',
        header: '',
        value: () => null,
        render: (b) => (
          <Link to={`/budgets/${b.id}/variance`} className="btn btn-sm" onClick={(e) => e.stopPropagation()}>
            <BarChart3 /> {t('budget.variance')}
          </Link>
        ),
      },
    ],
    [t, locale],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('budget.title')}
        subtitle={t('budget.subtitle')}
        actions={
          can('budget.budgets.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t('budget.new')}
            </Button>
          )
        }
      />
      <DataGrid
        id="budgets"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(b) => b.id}
        onRowClick={(b) => navigate(`/budgets/${b.id}`)}
        exportName={t('budget.title')}
        empty={<EmptyState icon={<ClipboardList size={22} />} title={t('budget.none')} text={t('budget.noneText')} />}
      />
      <NewBudgetDialog open={creating} onClose={() => setCreating(false)} budgets={data ?? []} />
    </div>
  );
}

// ---------------------------------------------------------------- editor

type Line = {
  key: number;
  accountId: number | null;
  costCenterId: number | null;
  amounts: number[];
};
type SalesLine = {
  key: number;
  itemId: number | null;
  unitPrice: number | null;
  unitCost: number | null;
  quantities: number[];
};
let k = 0;

function BudgetEditor() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const { can } = useSession();
  // Item-level sales budgets need products & services (they come with sales, purchasing or inventory).
  const items = can('catalog.items.read');
  const { fmt, scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const cc = useCostCenters();
  const [params, setParams] = useSearchParams();
  const tab = items && params.get('tab') === 'sales' ? 'sales' : 'accounts';
  const { data: b, isLoading } = useApi<BudgetFull>(`/budgets/${id}`);
  const [lines, setLines] = useState<Line[]>([]);
  const [sales, setSales] = useState<SalesLine[]>([]);
  const [types, setTypes] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    if (!b) return;
    setTypes(new Map(b.lines.map((l) => [l.account_id, l.type])));
    setLines(
      b.lines.map((l) => ({
        key: ++k,
        accountId: l.account_id,
        costCenterId: l.cost_center_id,
        amounts: l.amounts,
      })),
    );
    setSales(
      b.sales.map((s) => ({
        key: ++k,
        itemId: s.item_id,
        unitPrice: s.unit_price,
        unitCost: s.unit_cost,
        quantities: s.quantities,
      })),
    );
  }, [b]);
  const labels = useMonthLabels(b?.months ?? []);
  const draft = b?.status === 'draft' && can('budget.budgets.write');
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, {
      onSuccess: () => (toast.success(msg), after?.()),
      onError: (e) => toast.error(errText(e)),
    });
  const saveAll = () => run(saveAllPromise, t('common.saved'));
  const upd = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const updS = (key: number, patch: Partial<SalesLine>) => setSales((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const type = (l: Line) => (l.accountId ? types.get(l.accountId) : undefined);
  const revenue = sum(lines.filter((l) => type(l) === 'income').map((l) => sum(l.amounts)));
  const costs = sum(lines.filter((l) => type(l) === 'expense').map((l) => sum(l.amounts)));

  if (isLoading || !b) return <Loading />;
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/budgets', label: t('budget.title') }]}
        title={b.name}
        badge={<Badge tone={b.status === 'approved' ? 'green' : 'amber'}>{t('budget.status.' + b.status)}</Badge>}
        subtitle={t('budget.from', {
          month: labels[0] + ' ' + b.months[0].slice(0, 4),
        })}
        actions={
          <>
            <Link to={`/budgets/${b.id}/variance`} className="btn">
              <BarChart3 /> {t('budget.variance')}
            </Link>
            {draft && (
              <>
                <Button
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if (
                      (
                        await confirm({
                          title: t('budget.delete'),
                          danger: true,
                          confirmLabel: t('common.delete'),
                        })
                      ).ok
                    )
                      run(
                        () => api.del(`/budgets/${b.id}`),
                        t('common.deleted'),
                        () => navigate('/budgets'),
                      );
                  }}
                />
                <Button icon={<Save />} loading={act.isPending} onClick={saveAll}>
                  {t('common.save')}
                </Button>
              </>
            )}
            {b.status === 'draft' && can('budget.budgets.approve') && (
              <Button variant="primary" icon={<CheckCircle2 />} onClick={() => run(async () => (draft && (await saveAllPromise()), api.post(`/budgets/${b.id}/approve`)), t('budget.approvedDone'))}>
                {t('budget.approve')}
              </Button>
            )}
            {b.status === 'approved' && can('budget.budgets.approve') && (
              <Button icon={<RotateCcw />} onClick={() => run(() => api.post(`/budgets/${b.id}/reopen`), t('common.saved'))}>
                {t('budget.reopen')}
              </Button>
            )}
            {can('budget.budgets.write') && (
              <Button
                icon={<Copy />}
                onClick={() =>
                  run(
                    () =>
                      api
                        .post<{
                          id: number;
                        }>('/budgets', {
                          name: `${b.name} ${t('access.copySuffix')}`,
                          startDate: b.start_date,
                          copyOf: b.id,
                        })
                        .then((r) => navigate(`/budgets/${r.id}`)),
                    t('common.saved'),
                  )
                }
              >
                {t('access.copy')}
              </Button>
            )}
          </>
        }
      />
      <div className="kpi-strip">
        <div>
          <span>{t('budget.revenue')}</span>
          <strong>{fmt(revenue)}</strong>
        </div>
        <div>
          <span>{t('budget.costs')}</span>
          <strong>{fmt(costs)}</strong>
        </div>
        <div>
          <span>{t('budget.profit')}</span>
          <strong className={revenue - costs >= 0 ? 'success-text' : 'danger-text'}>{fmt(revenue - costs)}</strong>
        </div>
      </div>
      {items && (
        <div className="tabs" role="tablist" style={{ marginBottom: 12 }}>
          <button className="tab" role="tab" aria-selected={tab === 'accounts'} onClick={() => setParams({})}>
            {t('budget.byAccount')}
          </button>
          <button className="tab" role="tab" aria-selected={tab === 'sales'} onClick={() => setParams({ tab: 'sales' })}>
            {t('budget.byItem')}
          </button>
        </div>
      )}
      {tab === 'accounts' ? (
        <Card className="lines-grid">
          <div className="table-wrap budget-grid">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th style={{ minWidth: 230 }}>{t('common.account')}</th>
                  {cc.on && <th style={{ minWidth: 140 }}>{t('co.costCenter')}</th>}
                  {labels.map((m, i) => (
                    <th key={i} className="end">
                      {m}
                    </th>
                  ))}
                  <th className="end">{t('common.total')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      {draft ? (
                        <AccountPicker
                          sm
                          value={l.accountId}
                          filter={(a) => a.type === 'income' || a.type === 'expense'}
                          onChange={(v, a) => {
                            if (a) setTypes((m) => new Map(m).set(a.id, a.type));
                            upd(l.key, { accountId: v });
                          }}
                        />
                      ) : (
                        <span>
                          {b.lines.find((x) => x.account_id === l.accountId)?.code} · {pick(b.lines.find((x) => x.account_id === l.accountId)?.name_en ?? '', b.lines.find((x) => x.account_id === l.accountId)?.name_ar ?? '')}
                        </span>
                      )}
                    </td>
                    {cc.on && <td>{draft ? <CostCenterSelect sm value={l.costCenterId} onChange={(v) => upd(l.key, { costCenterId: v })} list={cc.list} /> : null}</td>}
                    {l.amounts.map((v, i) => (
                      <td key={i}>
                        {draft ? (
                          <DecimalInput
                            sm
                            scale={scale}
                            value={v}
                            onChange={(x) =>
                              upd(l.key, {
                                amounts: l.amounts.map((y, j) => (j === i ? (x ?? 0) : y)),
                              })
                            }
                          />
                        ) : (
                          <Money v={v} />
                        )}
                      </td>
                    ))}
                    <td className="end num" style={{ fontWeight: 600 }}>
                      {fmt(sum(l.amounts))}
                    </td>
                    <td className="shrink nowrap">
                      {draft && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon={<Wand2 />}
                            title={t('budget.spreadHint')}
                            onClick={() => {
                              const total = window.prompt(t('budget.spreadPrompt'), (sum(l.amounts) / 10 ** scale).toFixed(scale));
                              const n = total == null ? NaN : Math.round(Number(total.replace(/,/g, '')) * 10 ** scale);
                              if (Number.isFinite(n)) upd(l.key, { amounts: spread(n) });
                            }}
                          />
                          <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft && (
            <div style={{ padding: '10px 14px' }}>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus />}
                onClick={() =>
                  setLines((ls) => [
                    ...ls,
                    {
                      key: ++k,
                      accountId: null,
                      costCenterId: null,
                      amounts: Array(MONTHS).fill(0),
                    },
                  ])
                }
              >
                {t('common.addLine')}
              </Button>
            </div>
          )}
          {lines.length === 0 && <EmptyState icon={<ClipboardList size={22} />} title={t('budget.noLines')} />}
        </Card>
      ) : (
        <Card className="lines-grid">
          <p className="faint" style={{ fontSize: 12.5, padding: '10px 14px 0', margin: 0 }}>
            {t('budget.byItemHint')}
          </p>
          <div className="table-wrap budget-grid">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>{t('docs.item')}</th>
                  <th className="end" style={{ minWidth: 110 }}>
                    {t('budget.unitPrice')}
                  </th>
                  <th className="end" style={{ minWidth: 110 }}>
                    {t('budget.unitCost')}
                  </th>
                  {labels.map((m, i) => (
                    <th key={i} className="end">
                      {m}
                    </th>
                  ))}
                  <th className="end">{t('budget.qty')}</th>
                  <th className="end">{t('budget.revenue')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.key}>
                    <td>
                      {draft ? (
                        <ItemPicker
                          value={s.itemId}
                          onChange={(v, item) =>
                            updS(s.key, {
                              itemId: v,
                              unitPrice: s.unitPrice ?? item?.sale_price ?? null,
                              unitCost: s.unitCost ?? item?.purchase_price ?? null,
                            })
                          }
                        />
                      ) : (
                        b.sales.find((x) => x.item_id === s.itemId)?.sku
                      )}
                    </td>
                    <td>{draft ? <DecimalInput sm scale={scale} value={s.unitPrice} onChange={(v) => updS(s.key, { unitPrice: v })} /> : <Money v={s.unitPrice} />}</td>
                    <td>{draft ? <DecimalInput sm scale={scale} value={s.unitCost} onChange={(v) => updS(s.key, { unitCost: v })} /> : <Money v={s.unitCost} />}</td>
                    {s.quantities.map((q, i) => (
                      <td key={i}>
                        {draft ? (
                          <DecimalInput
                            sm
                            trim
                            scale={3}
                            value={q}
                            onChange={(x) =>
                              updS(s.key, {
                                quantities: s.quantities.map((y, j) => (j === i ? (x ?? 0) : y)),
                              })
                            }
                          />
                        ) : (
                          <span className="num">{q / 1000}</span>
                        )}
                      </td>
                    ))}
                    <td className="end num">{sum(s.quantities) / 1000}</td>
                    <td className="end num" style={{ fontWeight: 600 }}>
                      {fmt(Math.round((sum(s.quantities) * (s.unitPrice ?? 0)) / 1000))}
                    </td>
                    <td className="shrink">{draft && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setSales((ls) => ls.filter((x) => x.key !== s.key))} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft && (
            <div style={{ padding: '10px 14px' }}>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus />}
                onClick={() =>
                  setSales((ls) => [
                    ...ls,
                    {
                      key: ++k,
                      itemId: null,
                      unitPrice: null,
                      unitCost: null,
                      quantities: Array(MONTHS).fill(0),
                    },
                  ])
                }
              >
                {t('common.addLine')}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );

  async function saveAllPromise() {
    await api.put(`/budgets/${id}/lines`, {
      lines: lines
        .filter((l) => l.accountId)
        .map((l) => ({
          accountId: l.accountId,
          costCenterId: l.costCenterId,
          amounts: l.amounts.map((v) => v ?? 0),
        })),
    });
    if (items)
      await api.put(`/budgets/${id}/sales`, {
        rows: sales
          .filter((s) => s.itemId)
          .map((s) => ({
            itemId: s.itemId,
            unitPrice: s.unitPrice ?? 0,
            unitCost: s.unitCost ?? 0,
            quantities: s.quantities.map((v) => v ?? 0),
          })),
      });
  }
}

// -------------------------------------------------------------- variance

function Fu({ v }: { v: number }) {
  const { t } = useI18n();
  if (v === 0) return <span className="faint">—</span>;
  return (
    <span className={v > 0 ? 'success-text' : 'danger-text'}>
      <Money v={Math.abs(v)} /> <small>{v > 0 ? t('budget.fav') : t('budget.unfav')}</small>
    </span>
  );
}

function VariancePage() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const { fmt } = useMoney();
  const cc = useCostCenters();
  const [range, setRange] = useState({ from: 1, to: null as number | null, cc: null as number | null });
  const { data: b } = useApi<BudgetFull>(`/budgets/${id}`);
  // Default: from the first month up to the current one (the budget may start in any month).
  const thisMonth = todayIso().slice(0, 7);
  const to = range.to ?? (b ? Math.min(Math.max(b.months.filter((m) => m <= thisMonth).length, 1), MONTHS) : null);
  const q = to == null ? null : { fromMonth: range.from, toMonth: Math.max(to, range.from) };
  const { data: v } = useApi<any>(q && `/budgets/${id}/variance`, q ? { ...q, costCenterId: range.cc ?? undefined } : undefined);
  const { data: s } = useApi<any>(q && `/budgets/${id}/sales-variance`, q ?? undefined);
  const labels = useMonthLabels(b?.months ?? []);
  if (!b || !v) return <Loading />;
  const income = v.rows.filter((r: any) => r.type === 'income');
  const expense = v.rows.filter((r: any) => r.type === 'expense');
  const RowsFor = ({ rows, title }: { rows: any[]; title: string }) => (
    <>
      <tr className="group-row">
        <td colSpan={6}>{title}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.accountId}>
          <td>
            <span className="num faint" style={{ marginInlineEnd: 8 }}>
              {r.code}
            </span>
            {pick(r.name_en, r.name_ar)}
            {r.unbudgeted && (
              <Badge plain tone="amber">
                {t('budget.unbudgeted')}
              </Badge>
            )}
          </td>
          <td className="end num">{fmt(r.budget)}</td>
          <td className="end num">{fmt(r.flexible)}</td>
          <td className="end num">{fmt(r.actual)}</td>
          <td className="end">
            <Fu v={r.activityVariance} />
          </td>
          <td className="end">
            <Fu v={r.flexibleVariance} />
          </td>
        </tr>
      ))}
    </>
  );
  return (
    <div className="page">
      <PageHeader
        crumbs={[
          { to: '/budgets', label: t('budget.title') },
          { to: `/budgets/${b.id}`, label: b.name },
        ]}
        title={t('budget.variance')}
        subtitle={t('budget.varianceSub')}
      />
      <div className="row" style={{ gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <Select
          value={range.from}
          onChange={(e) =>
            setRange({
              ...range,
              from: Number(e.target.value),
              to: Math.max(to ?? 1, Number(e.target.value)),
            })
          }
          style={{ width: 'auto' }}
        >
          {labels.map((m, i) => (
            <option key={i} value={i + 1}>
              {m} {b.months[i].slice(0, 4)}
            </option>
          ))}
        </Select>
        <span className="faint">→</span>
        <Select value={Math.max(to ?? 1, range.from)} onChange={(e) => setRange({ ...range, to: Number(e.target.value) })} style={{ width: 'auto' }}>
          {labels.map((m, i) =>
            i + 1 >= range.from ? (
              <option key={i} value={i + 1}>
                {m} {b.months[i].slice(0, 4)}
              </option>
            ) : null,
          )}
        </Select>
        {cc.on && (
          <div style={{ minWidth: 200 }}>
            <CostCenterSelect value={range.cc} onChange={(x) => setRange({ ...range, cc: x })} list={cc.list} />
          </div>
        )}
      </div>

      <div className="kpi-strip">
        <div>
          <span>{t('budget.staticProfit')}</span>
          <strong>{fmt(v.totals.staticProfit)}</strong>
        </div>
        <div>
          <span>{t('budget.flexibleProfit')}</span>
          <strong>{fmt(v.totals.flexibleProfit)}</strong>
          {v.activityIndex != null && (
            <small className="faint">
              {t('budget.activity', {
                pct: (v.activityIndex * 100).toFixed(1),
              })}
            </small>
          )}
        </div>
        <div>
          <span>{t('budget.actualProfit')}</span>
          <strong>{fmt(v.totals.actualProfit)}</strong>
        </div>
        <div>
          <span>{t('budget.activityVariance')}</span>
          <strong>
            <Fu v={v.totals.activityVariance} />
          </strong>
        </div>
        <div>
          <span>{t('budget.flexibleVariance')}</span>
          <strong>
            <Fu v={v.totals.flexibleVariance} />
          </strong>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 12.5, marginTop: -6 }}>
        {t('budget.threeColumnHint')}
      </p>

      {v.worst.length > 0 && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          <BarChart3 />
          <div>
            <strong>{t('budget.worstTitle')}</strong>
            <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
              {v.worst.map((r: any) => (
                <li key={r.accountId}>
                  {pick(r.name_en, r.name_ar)}: {fmt(-r.flexibleVariance)} {t('budget.overFlexible')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <Card>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.account')}</th>
                <th className="end">{t('budget.static')}</th>
                <th className="end">{t('budget.flexible')}</th>
                <th className="end">{t('budget.actual')}</th>
                <th className="end">{t('budget.activityVariance')}</th>
                <th className="end">{t('budget.flexibleVariance')}</th>
              </tr>
            </thead>
            <tbody>
              <RowsFor rows={income} title={t('reports.revenue')} />
              <RowsFor rows={expense} title={t('budget.costs')} />
              <tr className="grand-row">
                <td>{t('budget.profit')}</td>
                <td className="end num">{fmt(v.totals.staticProfit)}</td>
                <td className="end num">{fmt(v.totals.flexibleProfit)}</td>
                <td className="end num">{fmt(v.totals.actualProfit)}</td>
                <td className="end">
                  <Fu v={v.totals.activityVariance} />
                </td>
                <td className="end">
                  <Fu v={v.totals.flexibleVariance} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {s && s.rows.length > 0 && (
        <Card>
          <CardHeader title={t('budget.salesVariance')} sub={t('budget.salesVarianceSub')} />
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th className="end">{t('budget.budgetQty')}</th>
                  <th className="end">{t('budget.actualQty')}</th>
                  <th className="end">{t('budget.priceVar')}</th>
                  <th className="end">{t('budget.mixVar')}</th>
                  <th className="end">{t('budget.quantityVar')}</th>
                  <th className="end">{t('budget.volumeVar')}</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r: any) => (
                  <tr key={r.itemId}>
                    <td>
                      <span className="num faint" style={{ marginInlineEnd: 8 }}>
                        {r.sku}
                      </span>
                      {pick(r.name_en ?? '', r.name_ar ?? '')}
                      {r.unbudgeted && (
                        <Badge plain tone="amber">
                          {t('budget.unbudgeted')}
                        </Badge>
                      )}
                    </td>
                    <td className="end num">{r.budgetQty / 1000}</td>
                    <td className="end num">{r.actualQty / 1000}</td>
                    <td className="end">
                      <Fu v={r.priceVariance} />
                    </td>
                    <td className="end">{r.mixVariance == null ? '—' : <Fu v={r.mixVariance} />}</td>
                    <td className="end">{r.quantityVariance == null ? '—' : <Fu v={r.quantityVariance} />}</td>
                    <td className="end">
                      <Fu v={r.volumeVariance} />
                    </td>
                  </tr>
                ))}
                <tr className="grand-row">
                  <td>{t('common.total')}</td>
                  <td className="end num">{s.totals.budgetQty}</td>
                  <td className="end num">{s.totals.actualQty}</td>
                  <td className="end">
                    <Fu v={s.totals.priceVariance} />
                  </td>
                  <td className="end">{s.totals.mixVariance == null ? '—' : <Fu v={s.totals.mixVariance} />}</td>
                  <td className="end">{s.totals.quantityVariance == null ? '—' : <Fu v={s.totals.quantityVariance} />}</td>
                  <td className="end">
                    <Fu v={s.totals.volumeVariance} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12.5, padding: '0 14px 12px' }}>
            {t('budget.salesVarianceHint')}
          </p>
        </Card>
      )}
      <p className="faint" style={{ fontSize: 12 }}>
        {t('budget.asOf', { date: todayIso() })}
      </p>
    </div>
  );
}

export const budgetModule: WebModule = {
  id: 'budget',
  nav: [
    {
      to: '/budgets',
      label: 'budget.title',
      icon: ClipboardList,
      section: 'co',
      order: 40,
      perm: 'budget.budgets.read',
      app: 'budget',
    },
  ],
  routes: [
    { path: '/budgets', element: <BudgetsPage /> },
    { path: '/budgets/:id', element: <BudgetEditor /> },
    {
      path: '/budgets/:id/variance',
      element: <VariancePage />,
      perm: 'budget.reports.read',
      app: 'budget',
    },
  ],
  commands: [
    {
      id: 'go-budgets',
      label: 'budget.title',
      icon: ClipboardList,
      group: 'navigate',
      to: '/budgets',
      perm: 'budget.budgets.read',
      app: 'budget',
      keywords: 'budget plan variance موازنة تقديرية انحرافات',
    },
  ],
  reports: [
    {
      to: '/budgets',
      group: 'reports.groups.analysis',
      title: 'budget.variance',
      desc: 'budget.varianceSub',
      icon: BarChart3,
      color: 'var(--line-amber)',
      perm: 'budget.reports.read',
      app: 'budget',
    },
  ],
};
