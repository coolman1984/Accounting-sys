import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { api } from '../../core/api';
import { QTY_SCALE, todayIso } from '../../core/format';
import type { Item } from '../../core/types';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { ItemPicker, PartyPicker, TaxSelect, useItems, useTaxes } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';
import { computeLine } from '../../engines/documents/kinds';
import { useStockOn, WarehouseSelect } from '../../ui/Stock';
import { CurrencyRateFields, RATE_ONE } from '../../ui/Currency';
import { useSession } from '../../core/session';
import { unitLabel } from '../../core/units';

interface Line {
  key: number;
  itemId: number | null;
  description: string;
  unitId: number | null;
  quantity: number | null;
  unitPrice: number | null;
  discountBp: number | null;
  taxId: number | null;
  expectedDate: string;
  requisitionId: number | null;
}

let k = 0;
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

export interface PoPrefill {
  supplierId?: number | null;
  lines: { itemId: number; quantity: number }[];
}

export function PoEditor() {
  const { id } = useParams();
  const editing = id != null;
  const location = useLocation();
  const prefill = (location.state as PoPrefill | null) ?? null;
  const { t, pick } = useI18n();
  const stockOn = useStockOn();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { company } = useSession();
  const { data: items } = useItems();
  const { data: taxes } = useTaxes();
  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const { data: existing, isLoading } = useApi<any>(editing ? `/purchase-orders/${id}` : null);

  const [supplierId, setSupplierId] = useState<number | null>(prefill?.supplierId ?? null);
  const [date, setDate] = useState(todayIso());
  const [expected, setExpected] = useState('');
  const [wh, setWh] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [cur, setCur] = useState({ currency: company?.baseCurrency ?? '', rate: RATE_ONE });
  const [incoterm, setIncoterm] = useState('');
  const [portLoading, setPortLoading] = useState('');
  const [portDischarge, setPortDischarge] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState('');

  const blank = (item?: Item, quantity = 1000): Line => ({
    key: ++k,
    itemId: item?.id ?? null,
    description: item ? pick(item.name_en, item.name_ar) : '',
    unitId: null,
    quantity,
    unitPrice: item?.purchase_price ?? null,
    discountBp: null,
    taxId: item?.purchase_tax_id ?? null,
    expectedDate: '',
    requisitionId: null,
  });

  useEffect(() => {
    if (editing || !items || lines.length) return;
    if (prefill?.lines.length) setLines(prefill.lines.map((l) => blank(itemById.get(l.itemId), l.quantity)));
    else setLines([blank()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => {
    if (!existing) return;
    setSupplierId(existing.supplier_id);
    setDate(existing.date);
    setExpected(existing.expected_date ?? '');
    setWh(existing.warehouse_id);
    setReference(existing.reference ?? '');
    setCur({ currency: existing.currency ?? company?.baseCurrency ?? '', rate: existing.exchange_rate ?? RATE_ONE });
    setIncoterm(existing.incoterm ?? '');
    setPortLoading(existing.port_of_loading ?? '');
    setPortDischarge(existing.port_of_discharge ?? '');
    setNotes(existing.notes ?? '');
    setLines(
      existing.lines.map((l: any) => ({
        key: ++k,
        itemId: l.item_id,
        description: l.description,
        unitId: l.unit_id,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        discountBp: l.discount_bp || null,
        taxId: l.tax_id,
        expectedDate: l.expected_date ?? '',
        requisitionId: l.requisition_id ?? null,
      })),
    );
  }, [existing]);

  const rate = (taxId: number | null) => (taxId ? taxes?.find((x) => x.id === taxId)?.rate_bp ?? 0 : 0);
  const computed = lines.map((l) => computeLine(l.quantity ?? 0, l.unitPrice ?? 0, l.discountBp ?? 0, rate(l.taxId), false));
  const total = computed.reduce((s, c) => s + c.total, 0);
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const save = useApiMutation((approve: boolean) => {
    const body = {
      supplierId,
      date,
      expectedDate: expected || null,
      warehouseId: stockOn ? wh : null,
      reference: reference || null,
      currency: cur.currency && cur.currency !== company?.baseCurrency ? cur.currency : null,
      exchangeRate: cur.currency && cur.currency !== company?.baseCurrency ? cur.rate : null,
      incoterm: incoterm || null,
      portOfLoading: portLoading || null,
      portOfDischarge: portDischarge || null,
      notes: notes || null,
      approve,
      lines: lines
        .filter((l) => (l.itemId || l.description.trim()) && l.quantity)
        .map((l) => ({ itemId: l.itemId, description: l.description || null, unitId: l.unitId, quantity: l.quantity, unitPrice: l.unitPrice ?? 0, discountBp: l.discountBp ?? 0, taxId: l.taxId, expectedDate: l.expectedDate || null, requisitionId: l.requisitionId })),
    };
    return editing ? api.put<{ id: number }>(`/purchase-orders/${id}`, body) : api.post<{ id: number }>('/purchase-orders', body);
  });

  const submit = useCallback(
    (approve: boolean) => {
      setErr('');
      save.mutate(approve, {
        onSuccess: (r) => {
          toast.success(t('common.saved'));
          navigate(`/purchasing/orders/${r.id}`);
        },
        onError: (e) => setErr(errText(e)),
      });
    },
    [save, toast, t, navigate, errText],
  );

  if (editing && isLoading) return <Loading />;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/purchasing/orders', label: t('adv.purchaseOrders') }]}
        title={editing ? `${t('common.edit')} · ${t('adv.purchaseOrder')}` : t('adv.newPo')}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!supplierId}>
              {t('common.saveDraft')}
            </Button>
            <Button variant="primary" onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!supplierId || total <= 0}>
              {t('adv.saveAndApprove')}
            </Button>
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
            <Field label={t('adv.expectedDate')}>
              <Input type="date" value={expected} min={date} onChange={(e) => setExpected(e.target.value)} />
            </Field>
            {stockOn && (
              <Field label={t('inventory.warehouse')}>
                <WarehouseSelect value={wh} onChange={setWh} />
              </Field>
            )}
            <Field label={t('common.reference')}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <CurrencyRateFields currency={cur.currency} rate={cur.rate} date={date} onChange={setCur} />
            <Field label={t('pur.incoterm')}>
              <Select value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
                <option value="">—</option>
                {INCOTERMS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('pur.portOfLoading')}>
              <Input value={portLoading} onChange={(e) => setPortLoading(e.target.value)} placeholder="Shenzhen" />
            </Field>
            <Field label={t('pur.portOfDischarge')}>
              <Input value={portDischarge} onChange={(e) => setPortDischarge(e.target.value)} placeholder="Sokhna" />
            </Field>
          </div>
        </Card>
        <Card className="lines-grid">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: 260 }}>{t('docs.item')}</th>
                  <th>{t('common.description')}</th>
                  <th className="end" style={{ width: 90 }}>
                    {t('docs.qty')}
                  </th>
                  <th style={{ width: 150 }}>{t('adv.unit')}</th>
                  <th className="end" style={{ width: 120 }}>
                    {t('docs.price')}
                  </th>
                  <th className="end" style={{ width: 80 }}>
                    {t('docs.discount')}
                  </th>
                  <th style={{ width: 140 }}>{t('docs.tax')}</th>
                  <th style={{ width: 150 }}>{t('pur.lineExpected')}</th>
                  <th className="end" style={{ width: 120 }}>
                    {t('docs.lineTotal')}
                  </th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const item = l.itemId ? itemById.get(l.itemId) : undefined;
                  const units = (item?.units ?? []).filter((u) => u.is_active || u.id === l.unitId);
                  return (
                    <tr key={l.key}>
                      <td className="line-no">{i + 1}</td>
                      <td>
                        <ItemPicker value={l.itemId} onChange={(_, it) => it && update(l.key, { ...blank(it, l.quantity ?? 1000), key: l.key })} />
                      </td>
                      <td>
                        <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
                      </td>
                      <td>
                        <DecimalInput trim scale={QTY_SCALE} value={l.quantity} onChange={(v) => update(l.key, { quantity: v })} />
                      </td>
                      <td>
                        {units.length ? (
                          <Select
                            value={l.unitId ?? ''}
                            onChange={(e) => {
                              const unitId = e.target.value ? Number(e.target.value) : null;
                              const u = units.find((x) => x.id === unitId);
                              update(l.key, { unitId, unitPrice: u ? u.purchase_price ?? Math.round(((item?.purchase_price ?? 0) * u.factor) / 1000) : item?.purchase_price ?? null });
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
                        <DecimalInput scale={scale} value={l.unitPrice} onChange={(v) => update(l.key, { unitPrice: v })} />
                      </td>
                      <td>
                        <DecimalInput trim scale={2} value={l.discountBp} onChange={(v) => update(l.key, { discountBp: v == null ? null : Math.min(v, 10000) })} />
                      </td>
                      <td>
                        <TaxSelect side="purchases" value={l.taxId} onChange={(taxId) => update(l.key, { taxId })} />
                      </td>
                      <td>
                        <Input type="date" value={l.expectedDate} min={date} onChange={(e) => update(l.key, { expectedDate: e.target.value })} />
                      </td>
                      <td className="line-total">{fmt(computed[i].total)}</td>
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
              {t('common.total')} <span className="amount">{fmt(total)}</span>
            </span>
          </div>
        </Card>
        <Field label={t('common.notes')}>
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
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
