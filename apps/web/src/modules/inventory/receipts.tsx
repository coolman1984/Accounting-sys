import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, Ban, BookOpen, FilePlus, PackageCheck, Pencil, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { QTY_SCALE, todayIso } from '../../core/format';
import { isStockItem, type Item, type LotEntry, type Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { ItemPicker, PartyPicker, useItems } from '../../ui/Pickers';
import { LotChip, LotsDialog } from '../../ui/LotsDialog';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { Qty, WarehouseSelect, useWarehouses } from '../../ui/Stock';
import { unitLabel } from '../../core/units';

interface Line {
  key: number;
  itemId: number | null;
  unitId: number | null;
  quantity: number | null;
  unitCost: number | null;
  poLineId: number | null;
  lots: LotEntry[] | null;
}

let k = 0;
const blank = (item?: Item): Line => ({ key: ++k, itemId: item?.id ?? null, unitId: null, quantity: null, unitCost: item?.purchase_price ?? null, poLineId: null, lots: null });
const factorOf = (item: Item | undefined, unitId: number | null) => (item && unitId ? item.units.find((u) => u.id === unitId)?.factor ?? 1000 : 1000);
const stockOnly = (i: Item) => isStockItem(i) && !!i.is_active;
const lineValue = (q: number, c: number) => Math.round((q * c) / 1000);

export function ReceiptEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const editing = id != null;
  const poParam = params.get('po');
  const { t, pick } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { can } = useSession();
  const { data: items } = useItems();
  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const { data: existing, isLoading } = useApi<any>(editing ? `/inventory/receipts/${id}` : null);
  const { data: po } = useApi<any>(!editing && poParam ? `/purchase-orders/${poParam}` : null);

  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [poId, setPoId] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [wh, setWh] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  // A foreign-currency order is received in its currency; the server values it at the receipt date's rate.
  const [currency, setCurrency] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [lotsFor, setLotsFor] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const { data: warehouses } = useWarehouses();
  // New receipts go to the default warehouse unless the order names one.
  useEffect(() => {
    if (editing || wh != null || !warehouses || (poParam && !po)) return;
    const w = warehouses.find((x) => x.is_default && x.is_active) ?? warehouses.find((x) => x.is_active);
    if (w) setWh(w.id);
  }, [warehouses, po]);

  useEffect(() => {
    if (!existing) return;
    setSupplierId(existing.supplier_id);
    setPoId(existing.po_id);
    setDate(existing.date);
    setWh(existing.warehouse_id);
    setReference(existing.reference ?? '');
    setCurrency(existing.currency ?? null);
    setNotes(existing.notes ?? '');
    setLines(
      existing.lines.map((l: any) => ({ key: ++k, itemId: l.item_id, unitId: l.unit_id, quantity: l.quantity, unitCost: l.unit_cost, poLineId: l.po_line_id, lots: l.lots })),
    );
  }, [existing]);

  // Receive what is still outstanding on the purchase order.
  useEffect(() => {
    if (!po) return;
    setSupplierId(po.supplier_id);
    setPoId(po.id);
    if (po.warehouse_id) setWh(po.warehouse_id);
    setReference(po.number ?? '');
    setCurrency(po.currency ?? null);
    const open = po.lines.filter((l: any) => l.item_id && l.to_receive > 0);
    setLines(
      open.length
        ? open.map((l: any) => {
            const whole = l.unit_id && (l.to_receive * 1000) % l.unit_factor === 0;
            const quantity = whole ? (l.to_receive * 1000) / l.unit_factor : l.to_receive;
            const per = whole ? l.quantity : l.base_quantity;
            return { key: ++k, itemId: l.item_id, unitId: whole ? l.unit_id : null, quantity, unitCost: Math.round((l.net * 1000) / per), poLineId: l.id, lots: null };
          })
        : [blank()],
    );
  }, [po]);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + lineValue(l.quantity ?? 0, l.unitCost ?? 0), 0);
  const lotsLine = lines.find((l) => l.key === lotsFor);
  const lotsItem = lotsLine?.itemId ? itemById.get(lotsLine.itemId) : undefined;
  const missingLots = lines.some((l) => {
    const it = l.itemId ? itemById.get(l.itemId) : undefined;
    return it && it.tracking !== 'none' && l.quantity && !l.lots?.length;
  });

  const save = useApiMutation((post: boolean) => {
    const body = {
      supplierId,
      poId,
      date,
      warehouseId: wh,
      reference: reference || null,
      currency,
      notes: notes || null,
      post,
      lines: lines
        .filter((l) => l.itemId && l.quantity)
        .map((l) => ({ itemId: l.itemId, unitId: l.unitId, quantity: l.quantity, unitCost: l.unitCost ?? 0, poLineId: l.poLineId, lots: l.lots })),
    };
    return editing ? api.put<{ id: number }>(`/inventory/receipts/${id}`, body) : api.post<{ id: number }>('/inventory/receipts', body);
  });
  const submit = (post: boolean) => {
    setErr('');
    save.mutate(post, {
      onSuccess: (r) => {
        toast.success(post ? t('common.posted') : t('common.saved'));
        navigate(`/inventory/receipts/${r.id}`);
      },
      onError: (e) => setErr(errText(e)),
    });
  };

  if (editing && isLoading) return <Loading />;
  const ready = !!supplierId && !!wh && lines.some((l) => l.itemId && l.quantity);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory/receipts', label: t('adv.receipts') }]}
        title={editing ? `${t('common.edit')} · ${t('adv.receipt')}` : t('adv.newReceipt')}
        subtitle={po?.number ? `${t('adv.purchaseOrder')} ${po.number}` : undefined}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!ready}>
              {t('common.saveDraft')}
            </Button>
            {can('inventory.receipts.post') && (
              <Button variant="primary" icon={<Send />} onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!ready || missingLots}>
                {t('common.saveAndPost')}
              </Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'start' }}>
            <Field label={t('docs.supplier')} className="span-2">
              <PartyPicker kind="supplier" value={supplierId} onChange={setSupplierId} autoFocus={!supplierId} />
            </Field>
            <Field label={t('common.date')}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={t('inventory.warehouse')}>
              <WarehouseSelect value={wh} onChange={setWh} />
            </Field>
            <Field label={t('adv.deliveryNote')}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card className="lines-grid">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th>{t('docs.item')}</th>
                  <th className="end" style={{ width: 110 }}>
                    {t('docs.qty')}
                  </th>
                  <th style={{ width: 150 }}>{t('adv.unit')}</th>
                  <th className="end" style={{ width: 140 }}>
                    {t('adv.unitCost')}
                  </th>
                  <th className="end" style={{ width: 140 }}>
                    {t('inventory.value')}
                  </th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const item = l.itemId ? itemById.get(l.itemId) : undefined;
                  const units = (item?.units ?? []).filter((u) => u.is_active || u.id === l.unitId);
                  const tracked = !!item && item.tracking !== 'none';
                  return (
                    <tr key={l.key}>
                      <td className="line-no">{i + 1}</td>
                      <td>
                        <ItemPicker value={l.itemId} filter={stockOnly} onChange={(_, it) => it && update(l.key, { ...blank(it), key: l.key, quantity: l.quantity })} />
                        {tracked && <LotChip lots={l.lots} required direction="in" onClick={() => setLotsFor(l.key)} />}
                      </td>
                      <td>
                        <DecimalInput trim scale={QTY_SCALE} value={l.quantity} onChange={(v) => update(l.key, { quantity: v })} />
                      </td>
                      <td>
                        {units.length && item?.tracking !== 'serial' ? (
                          <Select
                            value={l.unitId ?? ''}
                            onChange={(e) => {
                              const unitId = e.target.value ? Number(e.target.value) : null;
                              const u = units.find((x) => x.id === unitId);
                              update(l.key, { unitId, lots: null, unitCost: u ? u.purchase_price ?? Math.round(((item?.purchase_price ?? 0) * u.factor) / 1000) : item?.purchase_price ?? null });
                            }}
                          >
                            <option value="">{item?.unit || t('adv.baseUnit')}</option>
                            {units.map((u) => (
                              <option key={u.id} value={u.id}>
                                {unitLabel(u, pick)}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="faint" style={{ display: 'block', paddingTop: 8 }}>
                            {item?.unit ?? ''}
                          </span>
                        )}
                      </td>
                      <td>
                        <DecimalInput scale={scale} value={l.unitCost} onChange={(v) => update(l.key, { unitCost: v })} />
                      </td>
                      <td className="line-total">{fmt(lineValue(l.quantity ?? 0, l.unitCost ?? 0))}</td>
                      <td>
                        <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="balance-bar">
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, blank()])}>
              {t('common.addLine')}
            </Button>
            <span className="spacer" />
            <span className="muted">
              {currency && <span className="faint" style={{ marginInlineEnd: 12 }}>{t('pur.valuedIn', { currency })}</span>}
              {t('common.total')} <span className="amount">{fmt(total)}</span>{currency ? ' ' + currency : ''}
            </span>
          </div>
        </Card>
        <Field label={t('common.notes')}>
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {lotsLine && lotsItem && (
          <LotsDialog
            open
            onClose={() => setLotsFor(null)}
            item={lotsItem}
            direction="in"
            warehouseId={wh}
            factor={factorOf(lotsItem, lotsLine.unitId)}
            qty={lotsLine.quantity ?? 0}
            value={lotsLine.lots}
            onChange={(lots) => update(lotsLine.key, { lots })}
          />
        )}
        {err && (
          <div className="notice danger">
            <AlertTriangle />
            <div>{err}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ReceiptsList() {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Paged<any>>('/inventory/receipts', { limit: 20000 });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number ?? <span className="faint">{t('status.draft')}</span>}</span> },
      { id: 'supplier', header: t('docs.supplier'), type: 'enum', value: (r) => r.supplier_name },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      { id: 'warehouse', header: t('inventory.warehouse'), type: 'enum', value: (r) => r.warehouse_code },
      { id: 'reference', header: t('adv.deliveryNote'), value: (r) => r.reference },
      { id: 'value', header: t('inventory.value'), type: 'money', total: true, value: (r) => (r.status === 'void' ? 0 : r.value), render: (r) => <Money v={r.value} /> },
      {
        id: 'unbilled',
        header: t('adv.unbilled'),
        type: 'money',
        total: true,
        value: (r) => (r.status === 'posted' ? r.unbilled_value : 0),
        render: (r) => (r.status === 'posted' && r.unbilled_value ? <Money v={r.unbilled_value} /> : <span className="faint">—</span>),
      },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('status.' + v), render: (r) => <SimpleStatus status={r.status} /> },
    ],
    [t],
  );
  const presets = useMemo<Preset<any>[]>(
    () => [
      { id: 'draft', label: t('status.draft'), test: (r) => r.status === 'draft' },
      { id: 'unbilled', label: t('adv.unbilledOnly'), test: (r) => r.status === 'posted' && r.unbilled_value > 0 },
      { id: 'void', label: t('status.void'), test: (r) => r.status === 'void' },
    ],
    [t],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('adv.receipts')}
        subtitle={t('adv.receiptsSubtitle')}
        actions={
          can('inventory.receipts.write') && (
            <Link to="/inventory/receipts/new" className="btn btn-primary">
              <Plus /> {t('adv.newReceipt')}
            </Link>
          )
        }
      />
      <DataGrid
        id="goods-receipts"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/inventory/receipts/${r.id}`)}
        exportName={t('adv.receipts')}
        empty={<EmptyState icon={<PackageCheck size={22} />} title={t('common.noResults')} text={t('adv.receiptsSubtitle')} />}
      />
    </div>
  );
}

export function ReceiptView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: r, isLoading, error } = useApi<any>(`/inventory/receipts/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !r) return <ErrorBlock message={errText(error)} />;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  const total = r.lines.reduce((s: number, l: any) => s + l.value, 0);
  const unbilled = r.status === 'posted' && r.lines.some((l: any) => l.remaining_base > 0);
  const anyBilled = r.lines.some((l: any) => l.billed_base > 0);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory/receipts', label: t('adv.receipts') }]}
        title={r.number ?? `${t('adv.receipt')} · ${t('status.draft')}`}
        badge={<SimpleStatus status={r.status} />}
        subtitle={`${r.supplier.name} · ${r.warehouse.code} · ${date(r.date, 'long')}`}
        actions={
          <>
            <Button icon={<Printer />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
            {r.status === 'draft' && can('inventory.receipts.write') && (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(() => api.del(`/inventory/receipts/${r.id}`), t('common.deleted'), () => navigate('/inventory/receipts'));
                  }}
                >
                  {t('common.delete')}
                </Button>
                <Link to={`/inventory/receipts/${r.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {r.status === 'draft' && can('inventory.receipts.post') && (
              <Button variant="primary" icon={<Send />} loading={act.isPending} onClick={() => run(() => api.post(`/inventory/receipts/${r.id}/post`), t('common.posted'))}>
                {t('common.post')}
              </Button>
            )}
            {r.status === 'posted' && !anyBilled && can('inventory.receipts.post') && (
              <Button
                variant="danger"
                icon={<Ban />}
                onClick={async () => {
                  if ((await confirm({ title: t('common.void'), body: t('adv.receiptVoidText'), danger: true, confirmLabel: t('common.void') })).ok)
                    run(() => api.post(`/inventory/receipts/${r.id}/void`, {}), t('common.saved'));
                }}
              >
                {t('common.void')}
              </Button>
            )}
            {unbilled && can('ap.bills.write') && (
              <Link to={`/purchases/bills/new?fromReceipt=${r.id}`} className="btn btn-primary">
                <FilePlus /> {t('adv.createBill')}
              </Link>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {(r.journal_number || r.po_id) && (
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            {r.po_id && (
              <Link to={`/purchasing/orders/${r.po_id}`} className="row muted" style={{ gap: 6 }}>
                <FilePlus size={15} /> {t('adv.purchaseOrder')}
              </Link>
            )}
            {r.journal_entry_id && (
              <Link to={`/journal/${r.journal_entry_id}`} className="row muted" style={{ gap: 6 }}>
                <BookOpen size={15} /> {r.journal_number}
              </Link>
            )}
            {r.void_entry_id && (
              <Link to={`/journal/${r.void_entry_id}`} className="row muted" style={{ gap: 6 }}>
                <Ban size={15} /> {r.void_journal_number}
              </Link>
            )}
          </div>
        )}
        <Card className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink">#</th>
                  <th>{t('docs.item')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('adv.unitCost')}</th>
                  <th className="end">{t('adv.billed')}</th>
                  <th className="end">{t('inventory.value')}</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>
                      <Link to={`/inventory/items/${l.item_id}`} style={{ fontWeight: 550 }}>
                        {pick(l.name_en, l.name_ar)}
                      </Link>
                      <span className="faint" style={{ fontSize: 12, marginInline: 8 }}>
                        {l.sku}
                      </span>
                      {l.lots?.length > 0 && (
                        <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                          {l.lots.map((x: LotEntry) => `${x.lotNo}${x.expiry ? ' (' + date(x.expiry) + ')' : ''}`).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="end nowrap">
                      <Qty v={l.quantity} unit={l.unit_id ? pick(l.unit_name_en, l.unit_name_ar) : l.base_unit} />
                    </td>
                    <td className="end">
                      <Money v={l.unit_cost} />
                    </td>
                    <td className={`end ${l.remaining_base <= 0 ? 'success-text' : ''}`}>
                      <Qty v={l.billed_base} unit={l.base_unit} />
                    </td>
                    <td className="end">
                      <Money v={l.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={total} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
        {r.notes && (
          <Card pad>
            <div className="label">{t('common.notes')}</div>
            <p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.notes}</p>
          </Card>
        )}
      </div>
    </div>
  );
}
