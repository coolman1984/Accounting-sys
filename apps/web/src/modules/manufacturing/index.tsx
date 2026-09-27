import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BookOpen, CheckCircle2, Factory, Gauge, Plus, RefreshCw, Save, Settings2, Trash2, Undo2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate, todayIso } from '../../core/format';
import type { Account } from '../../core/types';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker, ItemPicker } from '../../ui/Pickers';
import { WarehouseSelect, useWarehouses } from '../../ui/Stock';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { PeriodControls, usePeriod } from '../../ui/Report';

interface CostSplit {
  materials: number;
  labour: number;
  varOverhead: number;
  fixedOverhead: number;
  total: number;
}
interface BomRow {
  id: number;
  item_id: number;
  name: string;
  sku: string;
  name_en: string;
  name_ar: string;
  output_qty: number;
  lines: number;
  unit_cost: number;
  is_active: number;
}
interface BomFull {
  id: number;
  item_id: number;
  name: string;
  output_qty: number;
  labour_hours: number;
  labour_rate: number;
  var_overhead_rate: number;
  fixed_overhead_rate: number;
  is_active: number;
  notes: string | null;
  lines: { item_id: number; qty: number; scrap_bp: number; std_cost: number; current_cost: number; sku: string; name_en: string; name_ar: string }[];
  standard: { batch: CostSplit; unit: CostSplit };
  current: { batch: CostSplit; unit: CostSplit };
}
interface OrderRow {
  id: number;
  number: string;
  date: string;
  status: 'draft' | 'done' | 'void';
  planned_qty: number;
  output_qty: number;
  total_cost: number;
  sku: string;
  name_en: string;
  name_ar: string;
  bom_name: string;
}
interface Variances {
  materials: { itemId: number; standardQty: number; actualQty: number; standardPrice: number; actualCost: number; standardCost: number; price: number; usage: number; unplanned: boolean }[];
  labour: { standardHours: number; actualHours: number; standardCost: number; actualCost: number; rate: number; efficiency: number };
  overhead: { appliedVariable: number; appliedFixed: number; standardVariable: number; standardFixed: number; varEfficiency: number };
  totals: { standard: number; actual: number; materialPrice: number; materialUsage: number; labourRate: number; labourEfficiency: number; varOverheadEfficiency: number; fixedOverheadEfficiency: number; total: number };
}
interface OrderFull {
  id: number;
  number: string;
  bom_id: number;
  bom_name: string | null;
  item_id: number;
  sku: string;
  name_en: string;
  name_ar: string;
  tracking: 'none' | 'batch' | 'serial';
  planned_qty: number;
  output_qty: number;
  date: string;
  warehouse_id: number;
  output_warehouse_id: number;
  status: 'draft' | 'done' | 'void';
  labour_hours: number;
  labour_cost: number | null;
  materials_cost: number;
  labour_applied: number;
  overhead_applied: number;
  total_cost: number;
  journal_entry_id: number | null;
  void_entry_id: number | null;
  notes: string | null;
  output_lots: { lotNo: string; expiry?: string | null; qty: number }[] | null;
  standard: { labourRate: number; varOverheadRate: number; fixedOverheadRate: number };
  standardCost: { batch: CostSplit; unit: CostSplit };
  lines: { item_id: number; std_qty: number; qty: number; actual_cost: number; sku: string; name_en: string; name_ar: string }[];
  variances: Variances | null;
}

const qty = (v: number) => (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
const statusTone = (s: string) => (s === 'done' ? 'green' : s === 'void' ? 'red' : 'amber');

/** A favourable (+) or unfavourable (−) variance, with the word, never colour alone. */
function Var({ v }: { v: number | null | undefined }) {
  const { t } = useI18n();
  if (v == null || v === 0) return <span className="faint">—</span>;
  return (
    <span className={v > 0 ? 'success-text' : 'danger-text'}>
      <Money v={Math.abs(v)} /> <small>{v > 0 ? t('budget.fav') : t('budget.unfav')}</small>
    </span>
  );
}

// ---------------------------------------------------------------- recipes

function BomsPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { fmt } = useMoney();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<BomRow[]>('/mfg/boms');
  const columns = useMemo<Column<BomRow>[]>(
    () => [
      { id: 'sku', header: t('mfg.product'), pinned: true, value: (b) => b.sku, render: (b) => <span><span className="num faint" style={{ marginInlineEnd: 8 }}>{b.sku}</span>{pick(b.name_en, b.name_ar)}</span> },
      { id: 'name', header: t('mfg.recipe'), value: (b) => b.name, render: (b) => <strong>{b.name}</strong> },
      { id: 'batch', header: t('mfg.batch'), type: 'number', value: (b) => b.output_qty / 1000 },
      { id: 'lines', header: t('mfg.components'), type: 'number', value: (b) => b.lines },
      { id: 'cost', header: t('mfg.stdUnitCost'), type: 'number', value: (b) => b.unit_cost, render: (b) => <span className="num">{fmt(b.unit_cost)}</span> },
      { id: 'active', header: t('common.status'), type: 'enum', value: (b) => (b.is_active ? 'active' : 'inactive'), format: (v) => t('common.' + v), render: (b) => <Badge tone={b.is_active ? 'green' : 'neutral'}>{t(b.is_active ? 'common.active' : 'common.inactive')}</Badge> },
    ],
    [t, pick, fmt],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('mfg.recipes')}
        subtitle={t('mfg.recipesSub')}
        actions={
          can('mfg.boms.write') && (
            <Link to="/mfg/boms/new" className="btn btn-primary">
              <Plus /> {t('mfg.newRecipe')}
            </Link>
          )
        }
      />
      <DataGrid id="mfg-boms" rows={data} loading={isLoading} columns={columns} rowKey={(b) => b.id} onRowClick={(b) => navigate(`/mfg/boms/${b.id}`)} exportName={t('mfg.recipes')} empty={<EmptyState icon={<BookOpen size={22} />} title={t('mfg.noRecipes')} text={t('mfg.noRecipesText')} />} />
    </div>
  );
}

type BomLineForm = { key: number; itemId: number | null; qty: number | null; scrapBp: number | null; stdCost: number | null; label?: string };
let lk = 0;

function CostTable({ standard, current }: { standard: { unit: CostSplit; batch: CostSplit }; current?: { unit: CostSplit } }) {
  const { t } = useI18n();
  const { fmt } = useMoney();
  const rows: (keyof CostSplit)[] = ['materials', 'labour', 'varOverhead', 'fixedOverhead', 'total'];
  return (
    <table className="table table-compact">
      <thead>
        <tr>
          <th />
          <th className="end">{t('mfg.perBatch')}</th>
          <th className="end">{t('mfg.perUnit')}</th>
          {current && <th className="end">{t('mfg.atTodayCost')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => (
          <tr key={k} className={k === 'total' ? 'grand-row' : undefined}>
            <td>{t('mfg.elements.' + k)}</td>
            <td className="end num">{fmt(standard.batch[k])}</td>
            <td className="end num">{fmt(standard.unit[k])}</td>
            {current && <td className="end num faint">{fmt(current.unit[k])}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BomEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { scale, fmt } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: b, isLoading } = useApi<BomFull>(isNew ? null : `/mfg/boms/${id}`);
  const writable = can('mfg.boms.write');
  const [f, setF] = useState({ itemId: null as number | null, name: '', outputQty: 1000 as number | null, labourHours: 0 as number | null, labourRate: 0 as number | null, varOverheadRate: 0 as number | null, fixedOverheadRate: 0 as number | null, isActive: true, notes: '' });
  const [lines, setLines] = useState<BomLineForm[]>([{ key: ++lk, itemId: null, qty: null, scrapBp: 0, stdCost: null }]);
  useEffect(() => {
    if (!b) return;
    setF({ itemId: b.item_id, name: b.name, outputQty: b.output_qty, labourHours: b.labour_hours, labourRate: b.labour_rate, varOverheadRate: b.var_overhead_rate, fixedOverheadRate: b.fixed_overhead_rate, isActive: !!b.is_active, notes: b.notes ?? '' });
    setLines(b.lines.map((l) => ({ key: ++lk, itemId: l.item_id, qty: l.qty, scrapBp: l.scrap_bp, stdCost: l.std_cost })));
  }, [b]);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const body = () => ({
    ...f,
    outputQty: f.outputQty ?? 0,
    labourHours: f.labourHours ?? 0,
    labourRate: f.labourRate ?? 0,
    varOverheadRate: f.varOverheadRate ?? 0,
    fixedOverheadRate: f.fixedOverheadRate ?? 0,
    notes: f.notes || null,
    lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: l.qty ?? 0, scrapBp: l.scrapBp ?? 0, stdCost: l.stdCost })),
  });
  const save = () =>
    act.mutate(() => (isNew ? api.post<{ id: number }>('/mfg/boms', body()) : api.put<{ id: number }>(`/mfg/boms/${id}`, body())), {
      onSuccess: (r: any) => (toast.success(t('common.saved')), isNew && navigate(`/mfg/boms/${r.id}`, { replace: true })),
      onError: (e) => toast.error(errText(e)),
    });
  const upd = (key: number, patch: Partial<BomLineForm>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  if (!isNew && (isLoading || !b)) return <Loading />;
  const perBatchHours = (f.labourHours ?? 0) / 1000;
  const liveMaterials = lines.reduce((a, l) => a + (((l.qty ?? 0) * (10000 + (l.scrapBp ?? 0))) / 10000 / 1000) * (l.stdCost ?? 0), 0);
  const liveBatch = liveMaterials + perBatchHours * ((f.labourRate ?? 0) + (f.varOverheadRate ?? 0) + (f.fixedOverheadRate ?? 0));
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/mfg/boms', label: t('mfg.recipes') }]}
        title={isNew ? t('mfg.newRecipe') : b!.name}
        actions={
          writable && (
            <>
              {!isNew && (
                <>
                  <Button
                    variant="ghost"
                    icon={<Trash2 />}
                    onClick={async () => {
                      if ((await confirm({ title: t('mfg.deleteRecipe'), danger: true, confirmLabel: t('common.delete') })).ok)
                        act.mutate(() => api.del(`/mfg/boms/${id}`), { onSuccess: () => navigate('/mfg/boms'), onError: (e) => toast.error(errText(e)) });
                    }}
                  />
                  <Button icon={<RefreshCw />} onClick={() => act.mutate(() => api.post(`/mfg/boms/${id}/update-standards`), { onSuccess: () => toast.success(t('mfg.standardsUpdated')), onError: (e) => toast.error(errText(e)) })}>
                    {t('mfg.updateStandards')}
                  </Button>
                </>
              )}
              <Button variant="primary" icon={<Save />} loading={act.isPending} onClick={save}>
                {t('common.save')}
              </Button>
            </>
          )
        }
      />
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Card pad>
          <div className="stack">
            <div className="grid-2">
              <Field label={t('mfg.product')}>
                <ItemPicker value={f.itemId} filter={(i) => i.kind === 'product' && !!i.track_stock} onChange={(v, item) => setF({ ...f, itemId: v, name: f.name || (item ? `${pick(item.name_en, item.name_ar)}` : '') })} />
              </Field>
              <Field label={t('mfg.recipe')}>
                <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label={t('mfg.batch')} hint={t('mfg.batchHint')}>
                <DecimalInput scale={3} trim value={f.outputQty} onChange={(v) => setF({ ...f, outputQty: v })} />
              </Field>
              <Field label={t('mfg.labourHours')} hint={t('mfg.perBatchHint')}>
                <DecimalInput scale={3} trim value={f.labourHours} onChange={(v) => setF({ ...f, labourHours: v })} />
              </Field>
            </div>
            <div className="grid-3">
              <Field label={t('mfg.labourRate')}>
                <DecimalInput scale={scale} value={f.labourRate} onChange={(v) => setF({ ...f, labourRate: v })} />
              </Field>
              <Field label={t('mfg.varOverheadRate')}>
                <DecimalInput scale={scale} value={f.varOverheadRate} onChange={(v) => setF({ ...f, varOverheadRate: v })} />
              </Field>
              <Field label={t('mfg.fixedOverheadRate')}>
                <DecimalInput scale={scale} value={f.fixedOverheadRate} onChange={(v) => setF({ ...f, fixedOverheadRate: v })} />
              </Field>
            </div>
            <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>{t('mfg.ratesHint')}</p>
            <Field label={t('common.notes')}>
              <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </Field>
            <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
          </div>
        </Card>
        <Card>
          <CardHeader title={t('mfg.standardCost')} sub={t('mfg.standardCostSub')} />
          {b && !isNew ? <CostTable standard={b.standard} current={b.current} /> : <p className="faint" style={{ padding: '0 16px 12px' }}>{t('mfg.saveToSee')}</p>}
          <p className="faint" style={{ fontSize: 12.5, padding: '0 16px 12px', margin: 0 }}>
            {t('mfg.liveBatch', { amount: fmt(Math.round(liveBatch)) })}
          </p>
        </Card>
      </div>
      <Card className="lines-grid">
        <CardHeader title={t('mfg.components')} sub={t('mfg.componentsSub')} />
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th style={{ minWidth: 240 }}>{t('docs.item')}</th>
                <th className="end">{t('mfg.qtyPerBatch')}</th>
                <th className="end">{t('mfg.scrap')}</th>
                <th className="end">{t('mfg.stdCost')}</th>
                {b && <th className="end">{t('mfg.currentCost')}</th>}
                <th className="end">{t('mfg.perBatch')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const cur = b?.lines.find((x) => x.item_id === l.itemId);
                return (
                  <tr key={l.key}>
                    <td>{writable ? <ItemPicker sm value={l.itemId} filter={(i) => i.kind === 'product' && !!i.track_stock && i.id !== f.itemId} onChange={(v) => upd(l.key, { itemId: v })} /> : cur && `${cur.sku} · ${pick(cur.name_en, cur.name_ar)}`}</td>
                    <td style={{ width: 120 }}>{writable ? <DecimalInput sm scale={3} trim value={l.qty} onChange={(v) => upd(l.key, { qty: v })} /> : qty(l.qty ?? 0)}</td>
                    <td style={{ width: 90 }}>{writable ? <DecimalInput sm scale={2} trim value={l.scrapBp} onChange={(v) => upd(l.key, { scrapBp: v })} /> : `${(l.scrapBp ?? 0) / 100}%`}</td>
                    <td style={{ width: 130 }}>{writable ? <DecimalInput sm scale={scale} value={l.stdCost} placeholder={t('mfg.averageCost')} onChange={(v) => upd(l.key, { stdCost: v })} /> : <Money v={l.stdCost ?? 0} />}</td>
                    {b && <td className="end num faint">{cur ? fmt(cur.current_cost) : ''}</td>}
                    <td className="end num">{fmt(Math.round((((l.qty ?? 0) * (10000 + (l.scrapBp ?? 0))) / 10000 / 1000) * (l.stdCost ?? cur?.current_cost ?? 0)))}</td>
                    <td className="shrink">{writable && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {writable && (
          <div style={{ padding: '10px 14px' }}>
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, { key: ++lk, itemId: null, qty: null, scrapBp: 0, stdCost: null }])}>
              {t('common.addLine')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- orders

function NewOrderDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t, pick } = useI18n();
  const navigate = useNavigate();
  const errText = useErrorText();
  const { data: boms } = useApi<BomRow[]>(open ? '/mfg/boms' : null);
  const { data: whs } = useWarehouses();
  const [f, setF] = useState({ bomId: null as number | null, plannedQty: null as number | null, date: todayIso(), warehouseId: null as number | null });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setErr('');
      setF((x) => ({ ...x, warehouseId: x.warehouseId ?? whs?.find((w) => w.is_default)?.id ?? whs?.[0]?.id ?? null }));
    }
  }, [open, whs]);
  const bom = boms?.find((b) => b.id === f.bomId);
  const save = useApiMutation(() => api.post<{ id: number }>('/mfg/orders', { ...f, plannedQty: f.plannedQty ?? 0 }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('mfg.newOrder')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.bomId || !f.plannedQty || !f.warehouseId} onClick={() => save.mutate(undefined, { onSuccess: (r) => (onClose(), navigate(`/mfg/orders/${r.id}`)), onError: (e) => setErr(errText(e)) })}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('mfg.recipe')}>
          <Select value={f.bomId ?? ''} onChange={(e) => setF({ ...f, bomId: e.target.value ? Number(e.target.value) : null, plannedQty: f.plannedQty ?? (boms?.find((b) => b.id === Number(e.target.value))?.output_qty ?? null) })}>
            <option value="">{t('common.select')}</option>
            {(boms ?? [])
              .filter((b) => b.is_active)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.sku} · {pick(b.name_en, b.name_ar)} — {b.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid-3">
          <Field label={t('mfg.qtyToMake')} hint={bom ? t('mfg.batchOf', { n: qty(bom.output_qty) }) : undefined}>
            <DecimalInput scale={3} trim value={f.plannedQty} onChange={(v) => setF({ ...f, plannedQty: v })} />
          </Field>
          <Field label={t('common.date')}>
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={t('inventory.warehouse')}>
            <WarehouseSelect value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} />
          </Field>
        </div>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function OrdersPage() {
  const { t, pick, locale } = useI18n();
  const { can } = useSession();
  const { fmt } = useMoney();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<OrderRow[]>('/mfg/orders');
  const [creating, setCreating] = useState(false);
  const columns = useMemo<Column<OrderRow>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, value: (o) => o.number, render: (o) => <strong className="num">{o.number}</strong> },
      { id: 'date', header: t('common.date'), type: 'date', value: (o) => o.date, render: (o) => formatDate(o.date, locale) },
      { id: 'product', header: t('mfg.product'), value: (o) => `${o.sku} ${o.name_en}`, render: (o) => <span><span className="num faint" style={{ marginInlineEnd: 8 }}>{o.sku}</span>{pick(o.name_en, o.name_ar)}</span> },
      { id: 'qty', header: t('mfg.quantity'), type: 'number', value: (o) => o.output_qty / 1000 },
      { id: 'cost', header: t('mfg.totalCost'), type: 'number', value: (o) => o.total_cost, render: (o) => (o.status === 'done' ? <span className="num">{fmt(o.total_cost)}</span> : <span className="faint">—</span>) },
      { id: 'unit', header: t('mfg.unitCost'), type: 'number', value: (o) => (o.output_qty ? Math.round((o.total_cost * 1000) / o.output_qty) : 0), render: (o) => (o.status === 'done' ? <span className="num">{fmt(Math.round((o.total_cost * 1000) / o.output_qty))}</span> : <span className="faint">—</span>) },
      { id: 'status', header: t('common.status'), type: 'enum', value: (o) => o.status, format: (v) => t('mfg.status.' + v), render: (o) => <Badge tone={statusTone(o.status)}>{t('mfg.status.' + o.status)}</Badge> },
    ],
    [t, pick, fmt, locale],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('mfg.orders')}
        subtitle={t('mfg.ordersSub')}
        actions={
          can('mfg.orders.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t('mfg.newOrder')}
            </Button>
          )
        }
      />
      <DataGrid id="mfg-orders" rows={data} loading={isLoading} columns={columns} rowKey={(o) => o.id} onRowClick={(o) => navigate(`/mfg/orders/${o.id}`)} exportName={t('mfg.orders')} empty={<EmptyState icon={<Factory size={22} />} title={t('mfg.noOrders')} text={t('mfg.noOrdersText')} />} />
      <NewOrderDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function VarianceBreakdown({ o }: { o: OrderFull }) {
  const { t, pick } = useI18n();
  const { fmt } = useMoney();
  const v = o.variances!;
  const name = (itemId: number) => {
    const l = o.lines.find((x) => x.item_id === itemId);
    return l ? `${l.sku} · ${pick(l.name_en, l.name_ar)}` : String(itemId);
  };
  const parts: [string, number][] = [
    ['materialPrice', v.totals.materialPrice],
    ['materialUsage', v.totals.materialUsage],
    ['labourRate', v.totals.labourRate],
    ['labourEfficiency', v.totals.labourEfficiency],
    ['varOverheadEfficiency', v.totals.varOverheadEfficiency],
    ['fixedOverheadEfficiency', v.totals.fixedOverheadEfficiency],
  ];
  return (
    <>
      <div className="kpi-strip">
        <div>
          <span>{t('mfg.standardForOutput')}</span>
          <strong>{fmt(v.totals.standard)}</strong>
        </div>
        <div>
          <span>{t('mfg.actualCost')}</span>
          <strong>{fmt(v.totals.actual)}</strong>
        </div>
        <div>
          <span>{t('mfg.totalVariance')}</span>
          <strong>
            <Var v={v.totals.total} />
          </strong>
        </div>
        <div>
          <span>{t('mfg.unitCost')}</span>
          <strong>{fmt(Math.round((o.total_cost * 1000) / o.output_qty))}</strong>
          <small className="faint">{t('mfg.stdUnit', { amount: fmt(o.standardCost.unit.total) })}</small>
        </div>
      </div>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Card>
          <CardHeader title={t('mfg.whyDifferent')} sub={t('mfg.whyDifferentSub')} />
          <table className="table table-compact">
            <tbody>
              {parts.map(([k, val]) => (
                <tr key={k}>
                  <td>
                    {t('mfg.variances.' + k)}
                    <div className="faint" style={{ fontSize: 12 }}>
                      {t('mfg.variancesHint.' + k)}
                    </div>
                  </td>
                  <td className="end nowrap">
                    <Var v={val} />
                  </td>
                </tr>
              ))}
              <tr className="grand-row">
                <td>{t('mfg.totalVariance')}</td>
                <td className="end nowrap">
                  <Var v={v.totals.total} />
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
        <Card>
          <CardHeader title={t('mfg.labourAndOverhead')} />
          <table className="table table-compact">
            <thead>
              <tr>
                <th />
                <th className="end">{t('mfg.standard')}</th>
                <th className="end">{t('mfg.actual')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('mfg.labourHours')}</td>
                <td className="end num">{qty(v.labour.standardHours)}</td>
                <td className="end num">{qty(v.labour.actualHours)}</td>
              </tr>
              <tr>
                <td>{t('mfg.elements.labour')}</td>
                <td className="end num">{fmt(v.labour.standardCost)}</td>
                <td className="end num">{fmt(v.labour.actualCost)}</td>
              </tr>
              <tr>
                <td>{t('mfg.elements.varOverhead')}</td>
                <td className="end num">{fmt(v.overhead.standardVariable)}</td>
                <td className="end num">{fmt(v.overhead.appliedVariable)}</td>
              </tr>
              <tr>
                <td>{t('mfg.elements.fixedOverhead')}</td>
                <td className="end num">{fmt(v.overhead.standardFixed)}</td>
                <td className="end num">{fmt(v.overhead.appliedFixed)}</td>
              </tr>
            </tbody>
          </table>
          <p className="faint" style={{ fontSize: 12.5, padding: '0 16px 12px', margin: 0 }}>{t('mfg.appliedHint')}</p>
        </Card>
      </div>
      <Card>
        <CardHeader title={t('mfg.materials')} />
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('docs.item')}</th>
                <th className="end">{t('mfg.stdQty')}</th>
                <th className="end">{t('mfg.actualQty')}</th>
                <th className="end">{t('mfg.stdCost')}</th>
                <th className="end">{t('mfg.actualCost')}</th>
                <th className="end">{t('mfg.variances.materialPrice')}</th>
                <th className="end">{t('mfg.variances.materialUsage')}</th>
              </tr>
            </thead>
            <tbody>
              {v.materials.map((m) => (
                <tr key={m.itemId}>
                  <td>
                    {name(m.itemId)} {m.unplanned && <Badge plain tone="amber">{t('mfg.unplanned')}</Badge>}
                  </td>
                  <td className="end num">{qty(m.standardQty)}</td>
                  <td className="end num">{qty(m.actualQty)}</td>
                  <td className="end num">{fmt(m.standardPrice)}</td>
                  <td className="end num">{fmt(m.actualCost)}</td>
                  <td className="end nowrap">
                    <Var v={m.price} />
                  </td>
                  <td className="end nowrap">
                    <Var v={m.usage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

type OrderLineForm = { key: number; itemId: number | null; qty: number | null; stdQty: number };

function OrderPage() {
  const { id } = useParams();
  const { t, pick, locale } = useI18n();
  const { can } = useSession();
  const { scale, fmt } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: o, isLoading } = useApi<OrderFull>(`/mfg/orders/${id}`);
  const [f, setF] = useState({ date: todayIso(), warehouseId: null as number | null, outputWarehouseId: null as number | null, outputQty: null as number | null, labourHours: null as number | null, labourCost: null as number | null, notes: '', lotNo: '' });
  const [lines, setLines] = useState<OrderLineForm[]>([]);
  useEffect(() => {
    if (!o) return;
    setF({ date: o.date, warehouseId: o.warehouse_id, outputWarehouseId: o.output_warehouse_id, outputQty: o.output_qty, labourHours: o.labour_hours, labourCost: o.labour_cost, notes: o.notes ?? '', lotNo: o.output_lots?.[0]?.lotNo ?? '' });
    setLines(o.lines.map((l) => ({ key: ++lk, itemId: l.item_id, qty: l.qty, stdQty: l.std_qty })));
  }, [o]);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading || !o) return <Loading />;
  const draft = o.status === 'draft' && can('mfg.orders.write');
  const saveBody = () => ({
    date: f.date,
    warehouseId: f.warehouseId,
    outputWarehouseId: f.outputWarehouseId,
    outputQty: f.outputQty ?? 0,
    labourHours: f.labourHours ?? 0,
    labourCost: f.labourCost,
    notes: f.notes || null,
    outputLots: o.tracking !== 'none' && f.lotNo ? [{ lotNo: f.lotNo, qty: f.outputQty ?? 0 }] : null,
    lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: l.qty ?? 0 })),
  });
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) => act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (e) => toast.error(errText(e)) });
  const upd = (key: number, patch: Partial<OrderLineForm>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const autoLabour = Math.round(((f.labourHours ?? 0) * o.standard.labourRate) / 1000);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/mfg/orders', label: t('mfg.orders') }]}
        title={o.number}
        badge={<Badge tone={statusTone(o.status)}>{t('mfg.status.' + o.status)}</Badge>}
        subtitle={`${o.sku} · ${pick(o.name_en, o.name_ar)}${o.bom_name ? ' — ' + o.bom_name : ''}`}
        actions={
          <>
            {o.journal_entry_id && (
              <Link to={`/journal/${o.journal_entry_id}`} className="btn">
                <BookOpen /> {t('common.journalEntry')}
              </Link>
            )}
            {draft && (
              <>
                <Button
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('mfg.deleteOrder'), danger: true, confirmLabel: t('common.delete') })).ok) run(() => api.del(`/mfg/orders/${o.id}`), t('common.deleted'), () => navigate('/mfg/orders'));
                  }}
                />
                <Button icon={<Save />} loading={act.isPending} onClick={() => run(() => api.put(`/mfg/orders/${o.id}`, saveBody()), t('common.saved'))}>
                  {t('common.save')}
                </Button>
              </>
            )}
            {o.status === 'draft' && can('mfg.orders.post') && (
              <Button
                variant="primary"
                icon={<CheckCircle2 />}
                loading={act.isPending}
                onClick={async () => {
                  if ((await confirm({ title: t('mfg.completeTitle'), body: t('mfg.completeText') })).ok)
                    run(async () => (draft && (await api.put(`/mfg/orders/${o.id}`, saveBody())), api.post(`/mfg/orders/${o.id}/complete`)), t('mfg.completed'));
                }}
              >
                {t('mfg.complete')}
              </Button>
            )}
            {o.status === 'done' && can('mfg.orders.post') && (
              <Button
                icon={<Undo2 />}
                onClick={async () => {
                  const r = await confirm({ title: t('mfg.voidTitle'), body: t('mfg.voidText'), danger: true, confirmLabel: t('common.void'), withDate: { label: t('common.date'), value: o.date } });
                  if (r.ok) run(() => api.post(`/mfg/orders/${o.id}/void`, { date: r.date ?? null }), t('common.saved'));
                }}
              >
                {t('common.void')}
              </Button>
            )}
          </>
        }
      />

      {o.status === 'draft' ? (
        <>
          <Card pad>
            <div className="grid-3">
              <Field label={t('common.date')}>
                <Input type="date" value={f.date} disabled={!draft} onChange={(e) => setF({ ...f, date: e.target.value })} />
              </Field>
              <Field label={t('mfg.fromWarehouse')}>
                <WarehouseSelect value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} />
              </Field>
              <Field label={t('mfg.toWarehouse')}>
                <WarehouseSelect value={f.outputWarehouseId} onChange={(v) => setF({ ...f, outputWarehouseId: v })} />
              </Field>
            </div>
            <div className="grid-3" style={{ marginTop: 12 }}>
              <Field label={t('mfg.producedQty')} hint={t('mfg.plannedWas', { n: qty(o.planned_qty) })}>
                <DecimalInput scale={3} trim value={f.outputQty} onChange={(v) => setF({ ...f, outputQty: v })} />
              </Field>
              <Field label={t('mfg.actualHours')}>
                <DecimalInput scale={3} trim value={f.labourHours} onChange={(v) => setF({ ...f, labourHours: v })} />
              </Field>
              <Field label={t('mfg.actualLabourCost')} hint={t('mfg.labourCostHint', { amount: fmt(autoLabour) })}>
                <DecimalInput scale={scale} value={f.labourCost} placeholder={fmt(autoLabour)} onChange={(v) => setF({ ...f, labourCost: v })} />
              </Field>
            </div>
            {o.tracking !== 'none' && (
              <div className="grid-3" style={{ marginTop: 12 }}>
                <Field label={t('mfg.outputLot')}>
                  <Input value={f.lotNo} onChange={(e) => setF({ ...f, lotNo: e.target.value })} />
                </Field>
              </div>
            )}
          </Card>
          <Card className="lines-grid">
            <CardHeader title={t('mfg.materialsUsed')} sub={t('mfg.materialsUsedSub')} />
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th style={{ minWidth: 240 }}>{t('docs.item')}</th>
                    <th className="end">{t('mfg.stdQtyPlanned')}</th>
                    <th className="end">{t('mfg.actualQty')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const info = o.lines.find((x) => x.item_id === l.itemId);
                    return (
                      <tr key={l.key}>
                        <td>{draft && !info ? <ItemPicker sm value={l.itemId} filter={(i) => i.kind === 'product' && !!i.track_stock && i.id !== o.item_id} onChange={(v) => upd(l.key, { itemId: v })} /> : info ? `${info.sku} · ${pick(info.name_en, info.name_ar)}` : ''}</td>
                        <td className="end num faint">{qty(l.stdQty)}</td>
                        <td style={{ width: 150 }}>{draft ? <DecimalInput sm scale={3} trim value={l.qty} onChange={(v) => upd(l.key, { qty: v })} /> : qty(l.qty ?? 0)}</td>
                        <td className="shrink">{draft && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {draft && (
              <div style={{ padding: '10px 14px' }}>
                <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, { key: ++lk, itemId: null, qty: null, stdQty: 0 }])}>
                  {t('mfg.addMaterial')}
                </Button>
              </div>
            )}
          </Card>
        </>
      ) : (
        <>
          <p className="faint" style={{ marginTop: -8 }}>
            {formatDate(o.date, locale)} · {t('mfg.madeQty', { n: qty(o.output_qty), planned: qty(o.planned_qty) })}
          </p>
          {o.variances && <VarianceBreakdown o={o} />}
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- report

function SettingsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t, pick } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const { data: s } = useApi<{ budget_fixed_overhead: number; overhead_accounts: number[] }>(open ? '/mfg/settings' : null);
  const { data: accounts } = useApi<Account[]>(open ? '/accounts' : null);
  const [f, setF] = useState({ budgetFixedOverhead: 0 as number | null, overheadAccounts: [] as number[] });
  const [adding, setAdding] = useState<number | null>(null);
  useEffect(() => {
    if (s) setF({ budgetFixedOverhead: s.budget_fixed_overhead, overheadAccounts: s.overhead_accounts });
  }, [s]);
  const save = useApiMutation(() => api.put('/mfg/settings', { budgetFixedOverhead: f.budgetFixedOverhead ?? 0, overheadAccounts: f.overheadAccounts }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('mfg.settings')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => toast.error(errText(e)) })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('mfg.budgetFixed')} hint={t('mfg.budgetFixedHint')}>
          <DecimalInput scale={scale} value={f.budgetFixedOverhead} onChange={(v) => setF({ ...f, budgetFixedOverhead: v })} />
        </Field>
        <Field label={t('mfg.overheadAccounts')} hint={t('mfg.overheadAccountsHint')}>
          <div className="stack" style={{ gap: 6 }}>
            {f.overheadAccounts.map((id) => {
              const a = accounts?.find((x) => x.id === id);
              return (
                <div key={id} className="row" style={{ gap: 8 }}>
                  <span style={{ flex: 1 }}>
                    <span className="num faint" style={{ marginInlineEnd: 8 }}>{a?.code}</span>
                    {a && pick(a.name_en, a.name_ar)}
                  </span>
                  <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setF({ ...f, overheadAccounts: f.overheadAccounts.filter((x) => x !== id) })} />
                </div>
              );
            })}
            <AccountPicker
              value={adding}
              filter={(a) => a.type === 'expense' && !f.overheadAccounts.includes(a.id)}
              onChange={(v) => {
                if (v) setF({ ...f, overheadAccounts: [...f.overheadAccounts, v] });
                setAdding(null);
              }}
            />
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function VariancesPage() {
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const { from, to, set } = usePeriod('thisYear');
  const [settings, setSettings] = useState(false);
  const { data: r } = useApi<any>('/mfg/variances', { from, to });
  const keys = ['materialPrice', 'materialUsage', 'labourRate', 'labourEfficiency', 'varOverheadEfficiency'] as const;
  return (
    <div className="page">
      <PageHeader
        title={t('mfg.varianceReport')}
        subtitle={t('mfg.varianceReportSub')}
        actions={
          can('mfg.settings.manage') && (
            <Button icon={<Settings2 />} onClick={() => setSettings(true)}>
              {t('mfg.settings')}
            </Button>
          )
        }
      />
      <div style={{ marginBottom: 16 }}>
        <PeriodControls from={from} to={to} onChange={(f, tt) => set({ from: f, to: tt })} />
      </div>
      {!r ? (
        <Loading />
      ) : (
        <>
          <div className="kpi-strip">
            <div>
              <span>{t('mfg.ordersDone')}</span>
              <strong>{r.orders.length}</strong>
            </div>
            <div>
              <span>{t('mfg.standardForOutput')}</span>
              <strong>{fmt(r.totals.standard)}</strong>
            </div>
            <div>
              <span>{t('mfg.actualCost')}</span>
              <strong>{fmt(r.totals.actual)}</strong>
            </div>
            <div>
              <span>{t('mfg.totalVariance')}</span>
              <strong>
                <Var v={r.totals.total} />
              </strong>
            </div>
          </div>
          <div className="grid-2" style={{ alignItems: 'start' }}>
            <Card>
              <CardHeader title={t('mfg.whyDifferent')} />
              <table className="table table-compact">
                <tbody>
                  {keys.map((k) => (
                    <tr key={k}>
                      <td>{t('mfg.variances.' + k)}</td>
                      <td className="end nowrap">
                        <Var v={r.totals[k]} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>{t('mfg.variances.fixedOverheadEfficiency')}</td>
                    <td className="end nowrap">
                      <Var v={r.totals.fixedOverheadEfficiency} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </Card>
            <Card>
              <CardHeader title={t('mfg.overheadTitle')} sub={r.overhead.tracked ? t('mfg.overheadSub') : t('mfg.overheadUntracked')} />
              <table className="table table-compact">
                <tbody>
                  <tr>
                    <td>{t('mfg.appliedOverhead')}</td>
                    <td className="end num">{fmt(r.overhead.appliedVariable + r.overhead.appliedFixed)}</td>
                  </tr>
                  <tr>
                    <td>{t('mfg.actualOverhead')}</td>
                    <td className="end num">{r.overhead.tracked ? fmt(r.overhead.actualVariable + r.overhead.actualFixed) : '—'}</td>
                  </tr>
                  <tr className="grand-row">
                    <td>{r.overhead.absorbed >= 0 ? t('mfg.overAbsorbed') : t('mfg.underAbsorbed')}</td>
                    <td className="end nowrap">{r.overhead.tracked ? <Var v={r.overhead.absorbed} /> : '—'}</td>
                  </tr>
                  {r.overhead.tracked &&
                    (['varSpending', 'varEfficiency', 'fixedSpending', 'fixedVolume'] as const).map((k) => (
                      <tr key={k}>
                        <td>
                          {t('mfg.overheadVar.' + k)}
                          <div className="faint" style={{ fontSize: 12 }}>
                            {t('mfg.overheadVarHint.' + k)}
                          </div>
                        </td>
                        <td className="end nowrap">
                          <Var v={r.overhead[k]} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          </div>
          <Card>
            <CardHeader title={t('mfg.orders')} />
            {r.orders.length === 0 ? (
              <EmptyState icon={<Factory size={22} />} title={t('mfg.noOrdersPeriod')} />
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{t('common.number')}</th>
                      <th>{t('common.date')}</th>
                      <th>{t('mfg.product')}</th>
                      <th className="end">{t('mfg.quantity')}</th>
                      <th className="end">{t('mfg.standard')}</th>
                      <th className="end">{t('mfg.actual')}</th>
                      <th className="end">{t('mfg.variances.materialPrice')}</th>
                      <th className="end">{t('mfg.variances.materialUsage')}</th>
                      <th className="end">{t('mfg.elements.labour')}</th>
                      <th className="end">{t('mfg.totalVariance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.orders.map((o: any) => (
                      <tr key={o.id} className="clickable">
                        <td>
                          <Link to={`/mfg/orders/${o.id}`} className="num">
                            {o.number}
                          </Link>
                        </td>
                        <td className="nowrap">{formatDate(o.date, locale)}</td>
                        <td>{pick(o.name_en, o.name_ar)}</td>
                        <td className="end num">{qty(o.output_qty)}</td>
                        <td className="end num">{fmt(o.standard)}</td>
                        <td className="end num">{fmt(o.actual)}</td>
                        <td className="end nowrap"><Var v={o.materialPrice} /></td>
                        <td className="end nowrap"><Var v={o.materialUsage} /></td>
                        <td className="end nowrap"><Var v={o.labourRate + o.labourEfficiency} /></td>
                        <td className="end nowrap"><Var v={o.total} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

export const manufacturingModule: WebModule = {
  id: 'manufacturing',
  nav: [
    { to: '/mfg/orders', label: 'mfg.orders', icon: Factory, section: 'production', order: 10, perm: 'mfg.orders.read', app: 'mfg' },
    { to: '/mfg/boms', label: 'mfg.recipes', icon: BookOpen, section: 'production', order: 20, perm: 'mfg.boms.read', app: 'mfg' },
    { to: '/mfg/variances', label: 'mfg.varianceReport', icon: Gauge, section: 'production', order: 30, perm: 'mfg.reports.read', app: 'mfg' },
  ],
  routes: [
    { path: '/mfg/orders', element: <OrdersPage /> },
    { path: '/mfg/orders/:id', element: <OrderPage /> },
    { path: '/mfg/boms', element: <BomsPage /> },
    { path: '/mfg/boms/:id', element: <BomEditor />, perm: 'mfg.boms.read', app: 'mfg' },
    { path: '/mfg/variances', element: <VariancesPage /> },
  ],
  commands: [
    { id: 'go-mfg-orders', label: 'mfg.orders', icon: Factory, group: 'navigate', to: '/mfg/orders', perm: 'mfg.orders.read', app: 'mfg', keywords: 'production manufacturing work order إنتاج تصنيع أمر تشغيل' },
    { id: 'go-mfg-boms', label: 'mfg.recipes', icon: BookOpen, group: 'navigate', to: '/mfg/boms', perm: 'mfg.boms.read', app: 'mfg', keywords: 'bom recipe bill of materials قائمة مواد وصفة' },
  ],
  reports: [{ to: '/mfg/variances', group: 'reports.groups.analysis', title: 'mfg.varianceReport', desc: 'mfg.varianceReportSub', icon: Gauge, color: 'var(--line-purple)', perm: 'mfg.reports.read', app: 'mfg' }],
};
