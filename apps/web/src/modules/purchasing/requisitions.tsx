import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ban, FilePlus, Plus, ClipboardCheck } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { QTY_SCALE, todayIso } from '../../core/format';
import { PageHeader, EmptyState } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Badge, type Tone } from '../../ui/Badge';
import { Dialog } from '../../ui/Dialog';
import { DecimalInput, Field, Input, Textarea } from '../../ui/Field';
import { ItemPicker, PartyPicker } from '../../ui/Pickers';
import { WarehouseSelect, useStockOn, Qty } from '../../ui/Stock';
import { useToast } from '../../ui/Toast';

const TONE: Record<string, Tone> = { open: 'blue', converted: 'green', closed: 'neutral', cancelled: 'red' };

interface Row {
  id: number;
  number: string;
  source: 'manual' | 'mrp';
  item_id: number;
  sku: string;
  name_en: string;
  name_ar: string;
  quantity: number;
  need_date: string;
  order_by_date: string | null;
  warehouse_code: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  status: string;
  pegging: string | null;
  global_code: string | null;
  po_id: number | null;
  po_number: string | null;
  lead_time_days: number;
}

function NewRequisition({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const stockOn = useStockOn();
  const [itemId, setItemId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [needDate, setNeedDate] = useState('');
  const [wh, setWh] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const save = useApiMutation((body: object) => api.post('/purchase-requisitions', body));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pur.newRequisition')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!itemId || !quantity || !needDate}
            onClick={() =>
              save.mutate(
                { itemId, quantity, needDate, warehouseId: stockOn ? wh : null, supplierId, notes: notes || null },
                { onSuccess: () => (toast.success(t('common.saved')), setItemId(null), setQuantity(null), setNotes(''), onClose()), onError: (e) => setErr(errText(e)) },
              )
            }
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
        <Field label={t('docs.item')}>
          <ItemPicker value={itemId} onChange={(id) => setItemId(id)} />
        </Field>
        <div className="grid-2">
          <Field label={t('docs.qty')}>
            <DecimalInput trim scale={QTY_SCALE} value={quantity} onChange={setQuantity} />
          </Field>
          <Field label={t('pur.needDate')}>
            <Input type="date" value={needDate} min={todayIso()} onChange={(e) => setNeedDate(e.target.value)} />
          </Field>
        </div>
        {stockOn && (
          <Field label={t('inventory.warehouse')}>
            <WarehouseSelect value={wh} onChange={setWh} />
          </Field>
        )}
        <Field label={t('docs.supplier')} hint={t('pur.supplierHint')}>
          <PartyPicker kind="supplier" value={supplierId} onChange={setSupplierId} />
        </Field>
        <Field label={t('common.notes')}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

export function RequisitionsPage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { data, isLoading, refetch } = useApi<Row[]>('/purchase-requisitions');
  const [dialog, setDialog] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [convertOpen, setConvertOpen] = useState(false);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [lotSizing, setLotSizing] = useState(true);
  const [err, setErr] = useState('');
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const convert = useApiMutation((body: object) => api.post<{ id: number }>('/purchase-requisitions/convert', body));

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        id: 'pick',
        header: '',
        pinned: true,
        width: 34,
        value: (r) => (sel.has(r.id) ? 1 : 0),
        render: (r) =>
          r.status === 'open' ? (
            <input
              type="checkbox"
              aria-label={r.number}
              checked={sel.has(r.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSel((s) => new Set(e.target.checked ? [...s, r.id] : [...s].filter((x) => x !== r.id)))}
            />
          ) : null,
      },
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number}</span> },
      { id: 'source', header: t('pur.source'), type: 'enum', value: (r) => r.source, format: (v) => t('pur.sources.' + v), render: (r) => <Badge tone={r.source === 'mrp' ? 'cyan' : 'neutral'}>{t('pur.sources.' + r.source)}</Badge> },
      { id: 'item', header: t('docs.item'), value: (r) => `${r.sku} ${pick(r.name_en, r.name_ar)}`, render: (r) => <span>{pick(r.name_en, r.name_ar)} <span className="faint" style={{ fontSize: 12 }}>{r.sku}</span></span> },
      { id: 'qty', header: t('docs.qty'), type: 'qty', value: (r) => r.quantity, render: (r) => <Qty v={r.quantity} /> },
      { id: 'need', header: t('pur.needDate'), type: 'date', nowrap: true, value: (r) => r.need_date },
      { id: 'orderBy', header: t('pur.orderBy'), type: 'date', nowrap: true, value: (r) => r.order_by_date, render: (r) => <span className={r.status === 'open' && r.order_by_date && r.order_by_date < todayIso() ? 'danger-text' : undefined}>{r.order_by_date ? date(r.order_by_date) : '—'}</span> },
      { id: 'warehouse', header: t('inventory.warehouse'), type: 'enum', value: (r) => r.warehouse_code },
      { id: 'supplier', header: t('docs.supplier'), type: 'enum', value: (r) => r.supplier_name },
      { id: 'peg', header: t('pur.pegging'), hidden: true, value: (r) => r.pegging },
      { id: 'po', header: t('adv.purchaseOrder'), value: (r) => r.po_number, render: (r) => (r.po_id ? <Link to={`/purchasing/orders/${r.po_id}`}>{r.po_number ?? t('status.draft')}</Link> : <span className="faint">—</span>) },
      {
        id: 'cancel',
        header: '',
        width: 40,
        value: () => null,
        render: (r) =>
          r.status === 'open' && can('purchasing.requisitions.write') ? (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Ban />}
              title={t('common.cancel')}
              onClick={() => act.mutate(() => api.post(`/purchase-requisitions/${r.id}/cancel`), { onSuccess: () => (toast.success(t('common.saved')), refetch()), onError: (e) => toast.error(errText(e)) })}
            />
          ) : null,
      },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('pur.reqStatus.' + v), render: (r) => <Badge tone={TONE[r.status] ?? 'neutral'}>{t('pur.reqStatus.' + r.status)}</Badge> },
    ],
    [t, pick, date, sel, can, act, refetch, toast, errText],
  );
  const presets = useMemo<Preset<Row>[]>(
    () => ['open', 'converted', 'closed', 'cancelled'].map((k) => ({ id: k, label: t('pur.reqStatus.' + k), test: (r: Row) => r.status === k })),
    [t],
  );

  const open = (data ?? []).filter((r) => r.status === 'open' && sel.has(r.id));
  const suppliers = new Set(open.map((r) => r.supplier_id).filter((x) => x != null));
  const startConvert = () => {
    setErr('');
    setSupplierId(suppliers.size === 1 ? ([...suppliers][0] as number) : null);
    setConvertOpen(true);
  };

  return (
    <div className="page">
      <PageHeader
        title={t('pur.requisitions')}
        subtitle={t('pur.requisitionsSubtitle')}
        actions={
          <>
            {can('purchasing.orders.write') && (
              <Button variant="primary" icon={<FilePlus />} disabled={!open.length} onClick={startConvert}>
                {t('pur.convert')} {open.length ? `(${open.length})` : ''}
              </Button>
            )}
            {can('purchasing.requisitions.write') && (
              <Button icon={<Plus />} onClick={() => setDialog(true)}>
                {t('pur.newRequisition')}
              </Button>
            )}
          </>
        }
      />
      <DataGrid
        id="purchase-requisitions"
        rows={data}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        exportName={t('pur.requisitions')}
        empty={<EmptyState icon={<ClipboardCheck size={22} />} title={t('common.noResults')} text={t('pur.requisitionsSubtitle')} />}
      />
      <NewRequisition open={dialog} onClose={() => (setDialog(false), refetch())} />
      <Dialog
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        title={t('pur.convertTitle', { n: open.length })}
        footer={
          <>
            <Button onClick={() => setConvertOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={convert.isPending}
              disabled={!supplierId}
              onClick={() =>
                convert.mutate(
                  { ids: open.map((r) => r.id), supplierId, applyLotSizing: lotSizing },
                  { onSuccess: (r) => (toast.success(t('pur.converted')), setSel(new Set()), navigate(`/purchasing/orders/${r.id}/edit`)), onError: (e) => setErr(errText(e)) },
                )
              }
            >
              {t('pur.createDraftOrder')}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
          <p className="muted">{t('pur.convertHint')}</p>
          <Field label={t('docs.supplier')}>
            <PartyPicker kind="supplier" value={supplierId} onChange={setSupplierId} />
          </Field>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={lotSizing} onChange={(e) => setLotSizing(e.target.checked)} />
            {t('pur.applyLotSizing')}
          </label>
          {err && <p className="danger-text">{err}</p>}
        </div>
      </Dialog>
    </div>
  );
}
