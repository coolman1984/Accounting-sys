import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, ListPlus, Plus, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { api } from '../../core/api';
import { QTY_SCALE, todayIso } from '../../core/format';
import { isStockItem, type Item } from '../../core/types';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { DecimalInput, Field, Input } from '../../ui/Field';
import { AccountPicker, ItemPicker, useItems } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';
import { Qty, useWarehouses, WarehouseSelect } from './common';
import { LotChip, LotsDialog } from '../../ui/LotsDialog';
import { Select } from '../../ui/Field';
import type { LotEntry } from '../../core/types';

export type OpKind = 'adjustment' | 'opening' | 'count' | 'transfer';
const KINDS: OpKind[] = ['adjustment', 'transfer', 'count', 'opening'];

interface Line {
  key: number;
  itemId: number | null;
  qty: number | null;
  unitCost: number | null;
  note: string;
  unitId: number | null;
  lots: LotEntry[] | null;
}

interface OpDetail {
  kind: OpKind;
  date: string;
  warehouse_id: number;
  to_warehouse_id: number | null;
  counter_account_id: number | null;
  reference: string | null;
  memo: string | null;
  lines: { item_id: number; qty: number; unit_cost: number | null; note: string | null; unit_id: number | null; lots: LotEntry[] | null }[];
}

let k = 0;
const blank = (itemId: number | null = null): Line => ({ key: ++k, itemId, qty: null, unitCost: null, note: '', unitId: null, lots: null });
const factorOf = (item: Item | undefined, unitId: number | null) => (item && unitId ? item.units.find((u) => u.id === unitId)?.factor ?? 1000 : 1000);
const stockOnly = (i: Item) => isStockItem(i) && !!i.is_active;

export function OperationEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const editing = id != null;
  const { t, pick } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { data: existing, isLoading } = useApi<OpDetail>(editing ? `/inventory/operations/${id}` : null);
  const { data: warehouses } = useWarehouses();
  const { data: items } = useItems();
  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);

  const [kind, setKind] = useState<OpKind>((params.get('kind') as OpKind) ?? 'adjustment');
  const [date, setDate] = useState(todayIso());
  const [wh, setWh] = useState<number | null>(null);
  const [toWh, setToWh] = useState<number | null>(null);
  const [counter, setCounter] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [blank(params.get('item') ? Number(params.get('item')) : null)]);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!editing && wh == null && warehouses?.length) setWh(warehouses.find((w) => w.is_default)?.id ?? warehouses[0].id);
  }, [warehouses, editing, wh]);

  useEffect(() => {
    if (!existing) return;
    setKind(existing.kind);
    setDate(existing.date);
    setWh(existing.warehouse_id);
    setToWh(existing.to_warehouse_id);
    setCounter(existing.counter_account_id);
    setReference(existing.reference ?? '');
    setMemo(existing.memo ?? '');
    setLines(existing.lines.map((l) => ({ key: ++k, itemId: l.item_id, qty: l.qty, unitCost: l.unit_cost, note: l.note ?? '', unitId: l.unit_id, lots: l.lots })));
  }, [existing]);

  const { data: levels } = useApi<Record<number, number>>(wh ? '/inventory/levels' : null, { warehouseId: wh ?? undefined });
  const book = (itemId: number | null) => (itemId ? levels?.[itemId] ?? 0 : 0);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /** Physical count: start from every item that has stock in this warehouse, counted = book. */
  const { data: whLots } = useApi<{ item_id: number; lot_no: string; expiry_date: string | null; qty: number }[]>(wh ? '/inventory/lots' : null, { warehouseId: wh ?? undefined });
  const loadAll = () => {
    const inStock = (items ?? []).filter((i) => stockOnly(i) && book(i.id) > 0);
    setLines(
      inStock.map((i) => ({
        ...blank(i.id),
        qty: book(i.id),
        // Tracked items are counted per lot: start from the book lots.
        lots: i.tracking === 'none' ? null : (whLots ?? []).filter((x) => x.item_id === i.id).map((x) => ({ lotNo: x.lot_no, expiry: x.expiry_date, qty: x.qty })),
      })),
    );
  };
  const [lotsFor, setLotsFor] = useState<number | null>(null);
  const lotsLine = lines.find((l) => l.key === lotsFor);
  const lotsItem = lotsLine?.itemId ? itemById.get(lotsLine.itemId) : undefined;
  const lotDirection = (l: Line): 'in' | 'out' => (kind === 'transfer' || (kind === 'adjustment' && (l.qty ?? 0) < 0) ? 'out' : 'in');
  const hasUnits = lines.some((l) => (itemById.get(l.itemId ?? 0)?.units ?? []).some((u) => u.is_active));

  const save = useApiMutation((post: boolean) => {
    const body = {
      kind,
      date,
      warehouseId: wh,
      toWarehouseId: kind === 'transfer' ? toWh : null,
      counterAccountId: kind === 'transfer' ? null : counter,
      reference: reference || null,
      memo: memo || null,
      post,
      lines: lines
        .filter((l) => l.itemId && l.qty != null)
        .map((l) => ({
          itemId: l.itemId,
          qty: l.qty,
          unitId: l.unitId,
          lots: l.lots?.length ? l.lots : null,
          unitCost: kind === 'adjustment' || kind === 'opening' || kind === 'count' ? l.unitCost : null,
          note: l.note || null,
        })),
    };
    return editing ? api.put<{ id: number }>(`/inventory/operations/${id}`, body) : api.post<{ id: number }>('/inventory/operations', body);
  });

  const submit = useCallback(
    (post: boolean) => {
      setErr('');
      save.mutate(post, {
        onSuccess: (r) => {
          toast.success(post ? t('common.posted') : t('common.saved'));
          navigate(`/inventory/operations/${r.id}`);
        },
        onError: (e) => setErr(errText(e)),
      });
    },
    [save, toast, t, navigate, errText],
  );

  if (editing && isLoading) return <Loading />;

  const showCost = kind === 'adjustment' || kind === 'opening' || kind === 'count';
  const ready = !!wh && (kind !== 'transfer' || (!!toWh && toWh !== wh)) && lines.some((l) => l.itemId && l.qty != null);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory/operations', label: t('inventory.operations') }]}
        title={editing ? `${t('common.edit')} · ${t('inventory.kinds.' + kind)}` : t('inventory.kinds.' + kind)}
        subtitle={t('inventory.kindHints.' + kind)}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!ready}>
              {t('common.saveDraft')}
            </Button>
            <Button variant="primary" onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!ready}>
              {t('common.saveAndPost')}
            </Button>
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {!editing && (
          <div className="segmented" style={{ alignSelf: 'flex-start' }}>
            {KINDS.map((x) => (
              <button key={x} aria-pressed={kind === x} onClick={() => setKind(x)}>
                {t('inventory.kinds.' + x)}
              </button>
            ))}
          </div>
        )}
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'start' }}>
            <Field label={t('common.date')}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={kind === 'transfer' ? t('inventory.fromWarehouse') : t('inventory.warehouse')}>
              <WarehouseSelect value={wh} onChange={setWh} />
            </Field>
            {kind === 'transfer' ? (
              <Field label={t('inventory.toWarehouse')}>
                <WarehouseSelect value={toWh} onChange={setToWh} exclude={wh} />
              </Field>
            ) : (
              <Field label={t('inventory.counterAccount')} hint={t('inventory.counterHint')}>
                <AccountPicker
                  value={counter}
                  onChange={setCounter}
                  placeholder={t('items.useDefault')}
                  filter={(a) => !['inventory', 'receivable', 'payable'].includes(a.subtype)}
                />
              </Field>
            )}
            <Field label={t('common.reference')}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Field label={t('common.memo')} className="span-2">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card className="lines-grid">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: '32%' }}>{t('docs.item')}</th>
                  <th className="end">{kind === 'count' ? t('inventory.system') : t('inventory.onHand')}</th>
                  <th className="end" style={{ width: 130 }}>
                    {kind === 'count' ? t('inventory.counted') : kind === 'adjustment' ? t('inventory.qtyChange') : t('docs.qty')}
                  </th>
                  {hasUnits && <th style={{ width: 110 }}>{t('adv.unit')}</th>}
                  {kind === 'count' && <th className="end">{t('inventory.difference')}</th>}
                  {showCost && (
                    <th className="end" style={{ width: 140 }}>
                      {t('inventory.unitCost')}
                    </th>
                  )}
                  <th>{t('common.notes')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const item = l.itemId ? itemById.get(l.itemId) : undefined;
                  const onHand = book(l.itemId);
                  const baseQty = Math.round(((l.qty ?? 0) * factorOf(item, l.unitId)) / 1000);
                  const diff = kind === 'count' && l.qty != null ? baseQty - onHand : null;
                  const short = (kind === 'transfer' && baseQty > onHand) || (kind === 'adjustment' && baseQty < 0 && -baseQty > onHand);
                  const tracked = !!item && item.tracking !== 'none';
                  return (
                    <tr key={l.key}>
                      <td className="line-no">{i + 1}</td>
                      <td>
                        <ItemPicker value={l.itemId} filter={stockOnly} onChange={(itemId) => update(l.key, { itemId, unitId: null, lots: null })} />
                        {tracked && (
                          <LotChip
                            lots={l.lots}
                            required={lotDirection(l) === 'in'}
                            direction={lotDirection(l)}
                            onClick={() => setLotsFor(l.key)}
                          />
                        )}
                      </td>
                      <td className="line-total muted">{l.itemId ? <Qty v={onHand} unit={item?.unit} /> : ''}</td>
                      <td>
                        <DecimalInput
                          trim
                          scale={QTY_SCALE}
                          allowNegative={kind === 'adjustment'}
                          value={l.qty}
                          onChange={(v) => update(l.key, { qty: v })}
                          className={short ? 'danger-text' : ''}
                        />
                      </td>
                      {hasUnits && (
                        <td>
                          {item && item.units.some((u) => u.is_active) ? (
                            <Select value={l.unitId ?? ''} onChange={(e) => update(l.key, { unitId: e.target.value ? Number(e.target.value) : null, lots: null })}>
                              <option value="">{item.unit || t('adv.baseUnit')}</option>
                              {item.units
                                .filter((u) => u.is_active || u.id === l.unitId)
                                .map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {pick(u.name_en, u.name_ar)} ({u.factor / 1000})
                                  </option>
                                ))}
                            </Select>
                          ) : (
                            <span className="faint" style={{ display: 'block', paddingTop: 8 }}>
                              {item?.unit ?? ''}
                            </span>
                          )}
                        </td>
                      )}
                      {kind === 'count' && (
                        <td className="line-total">{diff != null && diff !== 0 ? <Qty v={diff} signed tone /> : <span className="faint">—</span>}</td>
                      )}
                      {showCost && (
                        <td>
                          <DecimalInput
                            scale={scale}
                            value={l.unitCost}
                            onChange={(v) => update(l.key, { unitCost: v })}
                            placeholder={kind === 'opening' && item ? fmt(item.purchase_price) : t('inventory.unitCostHint')}
                          />
                        </td>
                      )}
                      <td>
                        <Input value={l.note} onChange={(e) => update(l.key, { note: e.target.value })} />
                      </td>
                      <td>
                        <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ padding: '10px 14px' }}>
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, blank()])}>
              {t('common.addLine')}
            </Button>
            {kind === 'count' && (
              <Button size="sm" variant="ghost" icon={<ListPlus />} onClick={loadAll} disabled={!wh}>
                {t('inventory.loadItems')}
              </Button>
            )}
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 13 }}>
              {t('inventory.lines')}: {lines.filter((l) => l.itemId).length} · {pick(warehouses?.find((w) => w.id === wh)?.name_en, warehouses?.find((w) => w.id === wh)?.name_ar)}
            </span>
          </div>
        </Card>

        {lotsLine && lotsItem && (
          <LotsDialog
            open
            onClose={() => setLotsFor(null)}
            item={lotsItem}
            direction={lotDirection(lotsLine)}
            warehouseId={wh}
            factor={factorOf(lotsItem, lotsLine.unitId)}
            qty={Math.abs(lotsLine.qty ?? 0)}
            value={lotsLine.lots}
            freeTotal={kind === 'count'}
            onChange={(lots) =>
              update(lotsLine.key, kind === 'count' ? { lots, qty: (lots ?? []).reduce((s, x) => s + x.qty, 0) } : { lots })
            }
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
