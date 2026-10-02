import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { ApiError, api } from '../../core/api';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { QTY_SCALE, addDaysIso, todayIso } from '../../core/format';
import type { Item } from '../../core/types';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { ItemPicker, PartyPicker, useItems } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';

interface Line {
  key: number;
  itemId: number | null;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  discountBp: number | null;
  requestedDate: string;
}

let k = 0;

/** A sales order: the customer, the date, and one line per item with its quantity, price and the day the customer wants it. */
export function SoEditor() {
  const { id } = useParams();
  const editing = id != null;
  const { t, pick } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { can } = useSession();
  const { data: items } = useItems();
  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const { data: existing, isLoading } = useApi<any>(editing ? `/sales/orders/${id}` : null);

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [priority, setPriority] = useState('5');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState('');
  const [creditHit, setCreditHit] = useState(false);
  const [override, setOverride] = useState(false);

  const blank = (item?: Item, quantity: number | null = null): Line => ({
    key: ++k,
    itemId: item?.id ?? null,
    description: item ? pick(item.name_en, item.name_ar) : '',
    quantity,
    unitPrice: item?.sale_price ?? null,
    discountBp: null,
    requestedDate: addDaysIso(todayIso(), 14),
  });

  useEffect(() => {
    if (editing || !items || lines.length) return;
    setLines([blank()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => {
    if (!existing) return;
    setCustomerId(existing.customer_id);
    setDate(existing.order_date);
    setReference(existing.customer_reference ?? '');
    setShipTo(existing.ship_to ?? '');
    setPriority(String(existing.priority ?? 5));
    setNotes(existing.notes ?? '');
    setLines(existing.lines.map((l: any) => ({ key: ++k, itemId: l.item_id, description: l.description ?? '', quantity: l.quantity, unitPrice: l.unit_price, discountBp: l.discount_bp || null, requestedDate: l.requested_date ?? '' })));
  }, [existing]);

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  /** Net of the line in the order's own money: quantity (x1000) times the unit price, less the discount. */
  const net = (l: Line) => Math.round(((l.quantity ?? 0) * (l.unitPrice ?? 0) * (10000 - (l.discountBp ?? 0))) / (1000 * 10000));
  const total = lines.reduce((s, l) => s + net(l), 0);

  const save = useApiMutation((confirm: boolean) => {
    const body = {
      customerId,
      orderDate: date,
      customerReference: reference || null,
      shipTo: shipTo || null,
      priority: Number(priority),
      notes: notes || null,
      confirm,
      override: confirm && override,
      lines: lines.filter((l) => l.itemId && l.quantity).map((l) => ({ itemId: l.itemId, description: l.description || null, quantity: l.quantity, unitPrice: l.unitPrice ?? 0, discountBp: l.discountBp ?? 0, requestedDate: l.requestedDate || null })),
    };
    return editing ? api.put<{ id: number }>(`/sales/orders/${id}`, body) : api.post<{ id: number }>('/sales/orders', body);
  });
  const submit = (confirm: boolean) => {
    setErr('');
    save.mutate(confirm, {
      onSuccess: (r) => {
        toast.success(t('common.saved'));
        navigate(`/sales/orders/${r.id}`);
      },
      onError: (e) => {
        setErr(errText(e));
        setCreditHit(e instanceof ApiError && e.code === 'sales.credit_limit');
      },
    });
  };

  if (editing && isLoading) return <Loading />;
  const ready = !!customerId && lines.some((l) => l.itemId && l.quantity);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/sales/orders', label: t('sd.orders') }]}
        title={editing ? `${t('common.edit')} · ${existing?.number ?? ''}` : t('sd.newOrder')}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!ready}>{t('common.saveDraft')}</Button>
            {can('sales.orders.approve') && <Button variant="primary" onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!ready || total <= 0}>{t('sd.saveAndConfirm')}</Button>}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'start' }}>
            <Field label={t('docs.customer')} className="span-2"><PartyPicker kind="customer" value={customerId} onChange={setCustomerId} autoFocus={!customerId} /></Field>
            <Field label={t('common.date')}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={t('sd.priority')}>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <Field label={t('sd.customerReference')}><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            <Field label={t('sd.shipTo')} className="span-2"><Input value={shipTo} onChange={(e) => setShipTo(e.target.value)} /></Field>
          </div>
        </Card>
        <Card className="lines-grid">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: 280 }}>{t('docs.item')}</th>
                  <th className="end" style={{ width: 110 }}>{t('docs.qty')}</th>
                  <th className="end" style={{ width: 130 }}>{t('docs.price')}</th>
                  <th className="end" style={{ width: 90 }}>{t('docs.discount')}</th>
                  <th style={{ width: 160 }}>{t('sd.requested')}</th>
                  <th className="end" style={{ width: 130 }}>{t('docs.lineTotal')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key}>
                    <td className="line-no">{i + 1}</td>
                    <td><ItemPicker value={l.itemId} onChange={(_, it) => it && update(l.key, { ...blank(it, l.quantity), key: l.key, requestedDate: l.requestedDate })} /></td>
                    <td><DecimalInput trim scale={QTY_SCALE} value={l.quantity} onChange={(v) => update(l.key, { quantity: v })} /></td>
                    <td><DecimalInput scale={scale} value={l.unitPrice} onChange={(v) => update(l.key, { unitPrice: v })} /></td>
                    <td><DecimalInput trim scale={2} value={l.discountBp} onChange={(v) => update(l.key, { discountBp: v == null ? null : Math.min(v, 10000) })} /></td>
                    <td><Input type="date" value={l.requestedDate} min={date} onChange={(e) => update(l.key, { requestedDate: e.target.value })} /></td>
                    <td className="line-total">{fmt(net(l))}</td>
                    <td><Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="balance-bar">
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, blank()])}>{t('common.addLine')}</Button>
            <span className="spacer" />
            <span className="muted">{t('common.total')} <span className="amount">{fmt(total)}</span></span>
          </div>
        </Card>
        <Field label={t('common.notes')}><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {err && (
          <div className="notice danger">
            <AlertTriangle />
            <div>
              {err}
              {creditHit && can('sales.orders.override') && <div style={{ marginTop: 8 }}><Checkbox checked={override} onChange={setOverride} label={t('sd.approveAnyway')} /></div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
