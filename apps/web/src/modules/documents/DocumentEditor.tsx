import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { api } from '../../core/api';
import { addDaysIso, formatQty, QTY_SCALE, todayIso } from '../../core/format';
import { isStockItem, type DocKind, type DocumentFull, type DocumentRow, type Paged, type Party, type Warehouse } from '../../core/types';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { AccountPicker, ItemPicker, PartyPicker, TaxSelect, useItems, useTaxes } from '../../ui/Pickers';
import { Kbd, modKey } from '../../ui/Brand';
import { useToast } from '../../ui/Toast';
import { computeLine, KIND_UI } from './kinds';

interface Line {
  key: number;
  itemId: number | null;
  description: string;
  accountId: number | null;
  quantity: number | null;
  unitPrice: number | null;
  discountBp: number | null;
  taxId: number | null;
  warehouseId: number | null;
}

let k = 0;

export function DocumentEditor({ kind }: { kind: DocKind }) {
  const { id } = useParams();
  const [params] = useSearchParams();
  const editing = id != null;
  const ui = KIND_UI[kind];
  const { t, pick, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt, scale } = useMoney();
  const { data: taxes } = useTaxes();
  const { data: existing, isLoading } = useApi<DocumentFull>(editing ? `/documents/${id}` : null);
  const defaultTax = useMemo(() => (taxes ?? []).find((x) => x.is_active && x.code === 'VAT')?.id ?? null, [taxes]);

  const blank = useCallback(
    (): Line => ({ key: ++k, itemId: null, description: '', accountId: null, quantity: 1000, unitPrice: null, discountBp: null, taxId: defaultTax, warehouseId: null }),
    [defaultTax],
  );

  const [partyId, setPartyId] = useState<number | null>(params.get('party') ? Number(params.get('party')) : null);
  const [terms, setTerms] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(todayIso());
  const [dueTouched, setDueTouched] = useState(false);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [against, setAgainst] = useState<number | null>(params.get('against') ? Number(params.get('against')) : null);
  const [lines, setLines] = useState<Line[]>([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [showWarehouses, setShowWarehouses] = useState(false);
  const [err, setErr] = useState('');

  // Inventory is optional: without it (or without permission) the warehouse controls simply don't show.
  const { data: warehouses } = useApi<Warehouse[]>('/inventory/warehouses', undefined, { retry: false, staleTime: 60_000 });
  const activeWarehouses = (warehouses ?? []).filter((w) => w.is_active || w.id === warehouseId);
  useEffect(() => {
    if (!editing && warehouseId == null && warehouses?.length) setWarehouseId(warehouses.find((w) => w.is_default)?.id ?? warehouses[0].id);
  }, [warehouses, editing, warehouseId]);
  const { data: items } = useItems();
  const itemById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items]);
  const outgoing = kind === 'sales_invoice' || kind === 'purchase_credit';
  const { data: levelsHere } = useApi<Record<number, number>>(warehouses && outgoing && warehouseId ? '/inventory/levels' : null, { warehouseId: warehouseId ?? undefined }, { retry: false });

  // Start with one blank line once taxes are known (so VAT is pre-selected).
  useEffect(() => {
    if (!editing && lines.length === 0 && taxes) setLines([blank()]);
  }, [editing, lines.length, taxes, blank]);

  useEffect(() => {
    if (!existing) return;
    setPartyId(existing.party_id);
    setDate(existing.date);
    setDueDate(existing.due_date);
    setDueTouched(true);
    setReference(existing.reference ?? '');
    setNotes(existing.notes ?? '');
    setInclusive(!!existing.tax_inclusive);
    setAgainst(existing.against_document_id);
    setLines(
      existing.lines.map((l) => ({
        key: ++k,
        itemId: l.item_id,
        description: l.description,
        accountId: l.account_id,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        discountBp: l.discount_bp || null,
        taxId: l.tax_id,
        warehouseId: l.warehouse_id,
      })),
    );
    setWarehouseId(existing.warehouse_id);
    if (existing.lines.some((l) => l.warehouse_id)) setShowWarehouses(true);
  }, [existing]);

  useEffect(() => {
    if (!dueTouched) setDueDate(addDaysIso(date, terms));
  }, [date, terms, dueTouched]);

  const { data: originals } = useApi<Paged<DocumentRow>>(
    ui.creditOf && partyId ? '/documents' : null,
    { kind: ui.creditOf, partyId: partyId ?? undefined, status: 'posted', limit: 200 },
  );

  const rate = (taxId: number | null) => (taxId ? taxes?.find((x) => x.id === taxId)?.rate_bp ?? 0 : 0);
  const computed = lines.map((l) => computeLine(l.quantity ?? 0, l.unitPrice ?? 0, l.discountBp ?? 0, rate(l.taxId), inclusive));
  const totals = computed.reduce(
    (s, c) => ({ net: s.net + c.net, discount: s.discount + c.discount, tax: s.tax + c.tax, total: s.total + c.total }),
    { net: 0, discount: 0, tax: 0, total: 0 },
  );

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /** Live stock hint under the quantity for goods leaving a warehouse. */
  const availability = (l: Line) => {
    const item = l.itemId ? itemById.get(l.itemId) : null;
    if (!outgoing || !item || !isStockItem(item) || !levelsHere) return null;
    const wh = (showWarehouses && l.warehouseId) || warehouseId;
    if (wh !== warehouseId) return null;
    const avail = levelsHere[item.id] ?? 0;
    // Everything this document takes of the same item from the same warehouse.
    const want = lines
      .filter((x) => x.itemId === item.id && ((showWarehouses && x.warehouseId) || warehouseId) === wh)
      .reduce((s, x) => s + (x.quantity ?? 0), 0);
    const short = want > avail;
    return (
      <div className={short ? 'danger-text' : 'faint'} style={{ fontSize: 11.5, textAlign: 'end', padding: '2px 4px 0', whiteSpace: 'nowrap' }}>
        {short ? t('inventory.notEnough', { qty: formatQty(avail, locale) }) : t('inventory.available', { qty: formatQty(avail, locale) })}
      </div>
    );
  };

  const save = useApiMutation((post: boolean) => {
    const body = {
      kind,
      partyId,
      date,
      dueDate,
      reference: reference || null,
      notes: notes || null,
      taxInclusive: inclusive,
      againstDocumentId: against,
      warehouseId: warehouses ? warehouseId : null,
      post,
      lines: lines
        .filter((l) => l.itemId || l.description.trim() || l.unitPrice)
        .map((l) => ({
          itemId: l.itemId,
          description: l.description || null,
          quantity: l.quantity ?? 0,
          unitPrice: l.unitPrice ?? 0,
          discountBp: l.discountBp ?? 0,
          accountId: l.accountId,
          taxId: l.taxId,
          warehouseId: showWarehouses ? l.warehouseId : null,
        })),
    };
    return editing ? api.put<{ id: number }>(`/documents/${id}`, body) : api.post<{ id: number }>('/documents', body);
  });

  const submit = useCallback(
    (post: boolean) => {
      setErr('');
      save.mutate(post, {
        onSuccess: (r) => {
          toast.success(post ? t('common.posted') : t('common.saved'));
          navigate(`${ui.base}/${r.id}`);
        },
        onError: (e) => setErr(errText(e)),
      });
    },
    [save, toast, t, navigate, ui.base, errText],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') {
        e.preventDefault();
        submit(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submit(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  if (editing && isLoading) return <Loading />;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: ui.base, label: t(`docs.${kind}.title`) }]}
        title={editing ? `${t('common.edit')} · ${t(`docs.${kind}.one`)}` : t(`docs.${kind}.new`)}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!partyId}>
              {t('common.saveDraft')}
            </Button>
            <Button variant="primary" onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!partyId || totals.total <= 0}>
              {t('common.saveAndPost')}
            </Button>
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'start' }}>
            <Field label={t(`docs.${ui.partyKind}`)} className="span-2">
              <PartyPicker
                kind={ui.partyKind}
                value={partyId}
                autoFocus={!editing && !partyId}
                onChange={(pid, p?: Party) => {
                  setPartyId(pid);
                  setTerms(p?.payment_terms_days ?? 0);
                  setAgainst(null);
                }}
              />
            </Field>
            <Field label={t('common.date')}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label={t('common.dueDate')}>
              <Input
                type="date"
                value={dueDate}
                min={date}
                onChange={(e) => {
                  setDueTouched(true);
                  setDueDate(e.target.value);
                }}
              />
            </Field>
            <Field label={ui.side === 'purchases' ? t('docs.supplierRef') : t('docs.customerRef')}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            {ui.creditOf && (
              <Field label={t('docs.against')}>
                <Select value={against ?? ''} onChange={(e) => setAgainst(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{t('docs.againstNone')}</option>
                  {(originals?.rows ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.number} · {fmt(d.total - d.amount_settled)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {warehouses && (
              <Field label={t('inventory.warehouse')}>
                <Select value={warehouseId ?? ''} onChange={(e) => setWarehouseId(Number(e.target.value))}>
                  {activeWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {pick(w.name_en, w.name_ar)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="field" style={{ justifyContent: 'flex-end', paddingTop: 26 }}>
              <Checkbox label={t('docs.taxInclusive')} checked={inclusive} onChange={setInclusive} />
            </div>
          </div>
        </Card>

        <Card className="lines-grid">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: 170 }}>{t('docs.item')}</th>
                  <th>{t('common.description')}</th>
                  {showAccounts && <th style={{ width: 200 }}>{t('common.account')}</th>}
                  {showWarehouses && <th style={{ width: 150 }}>{t('inventory.warehouse')}</th>}
                  <th className="end" style={{ width: 90 }}>
                    {t('docs.qty')}
                  </th>
                  <th className="end" style={{ width: 120 }}>
                    {t('docs.price')}
                  </th>
                  <th className="end" style={{ width: 80 }}>
                    {t('docs.discount')}
                  </th>
                  <th style={{ width: 150 }}>{t('docs.tax')}</th>
                  <th className="end" style={{ width: 120 }}>
                    {t('docs.lineTotal')}
                  </th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key}>
                    <td className="line-no">{i + 1}</td>
                    <td>
                      <ItemPicker
                        value={l.itemId}
                        onChange={(itemId, item) => {
                          if (!item) return update(l.key, { itemId });
                          const sales = ui.side === 'sales';
                          update(l.key, {
                            itemId,
                            description: pick(item.name_en, item.name_ar),
                            unitPrice: sales ? item.sale_price : item.purchase_price,
                            taxId: (sales ? item.sales_tax_id : item.purchase_tax_id) ?? l.taxId,
                            accountId: (sales ? item.income_account_id : item.expense_account_id) ?? null,
                          });
                        }}
                      />
                    </td>
                    <td>
                      <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
                    </td>
                    {showAccounts && (
                      <td>
                        <AccountPicker
                          value={l.accountId}
                          placeholder={t('items.useDefault')}
                          filter={(a) => a.subtype !== 'receivable' && a.subtype !== 'payable'}
                          onChange={(accountId) => update(l.key, { accountId })}
                        />
                      </td>
                    )}
                    {showWarehouses && (
                      <td>
                        <Select value={l.warehouseId ?? ''} onChange={(e) => update(l.key, { warehouseId: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">{t('items.useDefault')}</option>
                          {activeWarehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.code}
                            </option>
                          ))}
                        </Select>
                      </td>
                    )}
                    <td>
                      <DecimalInput trim scale={QTY_SCALE} value={l.quantity} onChange={(v) => update(l.key, { quantity: v })} aria-label={t('docs.qty')} />
                      {availability(l)}
                    </td>
                    <td>
                      <DecimalInput scale={scale} value={l.unitPrice} onChange={(v) => update(l.key, { unitPrice: v })} aria-label={t('docs.price')} />
                    </td>
                    <td>
                      <DecimalInput trim scale={2} value={l.discountBp} onChange={(v) => update(l.key, { discountBp: v == null ? null : Math.min(v, 10000) })} aria-label={t('docs.discount')} />
                    </td>
                    <td>
                      <TaxSelect side={ui.side} value={l.taxId} onChange={(taxId) => update(l.key, { taxId })} />
                    </td>
                    <td className="line-total">{fmt(inclusive ? computed[i].total : computed[i].net)}</td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Trash2 />}
                        disabled={lines.length <= 1}
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        aria-label={t('common.remove')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ padding: '10px 14px' }}>
            <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setLines((ls) => [...ls, blank()])}>
              {t('common.addLine')}
            </Button>
            <span className="spacer" />
            {warehouses && (
              <Checkbox label={t('inventory.byWarehouse')} checked={showWarehouses} onChange={setShowWarehouses} />
            )}
            <span style={{ width: 14 }} />
            <Checkbox label={t('common.account')} checked={showAccounts} onChange={setShowAccounts} />
          </div>
        </Card>

        <div className="doc-bottom">
          <Field label={t('common.notes')}>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
          </Field>
          <Card pad>
            <div className="totals">
              <span className="t-label">{t('common.subtotal')}</span>
              <span className="t-value">{fmt(totals.net)}</span>
              {totals.discount > 0 && (
                <>
                  <span className="t-label">{t('docs.discountTotal')}</span>
                  <span className="t-value">{fmt(-totals.discount)}</span>
                </>
              )}
              <span className="t-label">{t('docs.taxTotal')}</span>
              <span className="t-value">{fmt(totals.tax)}</span>
              <span className="t-label t-grand">{t('common.total')}</span>
              <span className="t-value t-grand">{fmt(totals.total)}</span>
            </div>
          </Card>
        </div>

        {err && (
          <div className="notice danger">
            <AlertTriangle />
            <div>{err}</div>
          </div>
        )}
        <p className="faint row" style={{ fontSize: 12.5, gap: 6 }}>
          <Kbd>{modKey}</Kbd>
          <Kbd>S</Kbd> {t('common.saveDraft')} · <Kbd>{modKey}</Kbd>
          <Kbd>↵</Kbd> {t('common.saveAndPost')}
        </p>
      </div>
    </div>
  );
}
