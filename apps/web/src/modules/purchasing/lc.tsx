import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, Banknote, FileCheck2, Landmark, Plus, ReceiptText, Undo2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { todayIso } from '../../core/format';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { AccountPicker, PartyPicker } from '../../ui/Pickers';
import { CurrencyRateFields, RATE_ONE } from '../../ui/Currency';
import { DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { useToast } from '../../ui/Toast';

const TONE: Record<string, Tone> = { opened: 'blue', documents_received: 'amber', settled: 'green', cancelled: 'red' };
const cents = (v: number | null | undefined, currency: string) => `${((v ?? 0) / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

export function LcStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={TONE[status] ?? 'neutral'}>{t('pur.lcStatus.' + status)}</Badge>;
}

function NewLc({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const { company } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { data: pos } = useApi<{ rows: any[] }>(open ? '/purchase-orders' : null, { status: 'open', limit: 500 });
  const [poId, setPoId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [lcNumber, setLcNumber] = useState('');
  const [bank, setBank] = useState<number | null>(null);
  const [cur, setCur] = useState({ currency: company?.baseCurrency ?? '', rate: RATE_ONE });
  const [amount, setAmount] = useState<number | null>(null);
  const [margin, setMargin] = useState<number | null>(0);
  const [charges, setCharges] = useState<number | null>(0);
  const [opening, setOpening] = useState(todayIso());
  const [expiry, setExpiry] = useState('');
  const [shipment, setShipment] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const po = pos?.rows.find((p) => p.id === poId);
  const currency = po ? po.currency ?? company?.baseCurrency ?? '' : cur.currency;
  const save = useApiMutation((body: object) => api.post<{ id: number }>('/letters-of-credit', body));
  const pickPo = (id: number | null) => {
    setPoId(id);
    const p = pos?.rows.find((x) => x.id === id);
    if (p) {
      setSupplierId(p.supplier_id);
      setAmount(p.total);
      setCur({ currency: p.currency ?? company?.baseCurrency ?? '', rate: p.exchange_rate ?? RATE_ONE });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('pur.newLc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!lcNumber || !supplierId || !bank || !amount || !expiry}
            onClick={() =>
              save.mutate(
                {
                  lcNumber, supplierId, poId, bankAccountId: bank, currency: currency !== company?.baseCurrency ? currency : null, amount, marginBp: margin ?? 0,
                  exchangeRate: currency !== company?.baseCurrency && !po ? cur.rate : null, openingDate: opening, expiryDate: expiry, latestShipmentDate: shipment || null,
                  openingCharges: charges ?? 0, notes: notes || null,
                },
                { onSuccess: (r) => (toast.success(t('common.saved')), onClose(), navigate(`/purchasing/lc/${r.id}`)), onError: (e) => setErr(errText(e)) },
              )
            }
          >
            {t('pur.openLc')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
        <div className="grid-2">
          <Field label={t('adv.purchaseOrder')} hint={t('pur.lcOrderHint')}>
            <Select value={poId ?? ''} onChange={(e) => pickPo(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {(pos?.rows ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} · {p.supplier_name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('docs.supplier')}>
            <PartyPicker kind="supplier" value={supplierId} onChange={setSupplierId} />
          </Field>
          <Field label={t('pur.lcNumber')}>
            <Input value={lcNumber} onChange={(e) => setLcNumber(e.target.value)} />
          </Field>
          <Field label={t('pur.bankAccount')}>
            <AccountPicker value={bank} onChange={setBank} filter={(a) => a.subtype === 'bank'} />
          </Field>
          {!po && <CurrencyRateFields currency={cur.currency} rate={cur.rate} date={opening} onChange={setCur} />}
          <Field label={`${t('common.amount')} (${currency})`}>
            <DecimalInput scale={2} value={amount} onChange={setAmount} />
          </Field>
          <Field label={t('pur.marginPct')} hint={t('pur.marginHint')}>
            <DecimalInput trim scale={2} value={margin} onChange={(v) => setMargin(v == null ? null : Math.min(v, 10000))} />
          </Field>
          <Field label={t('pur.openingCharges')}>
            <DecimalInput scale={2} value={charges} onChange={setCharges} />
          </Field>
          <Field label={t('pur.openingDate')}>
            <Input type="date" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </Field>
          <Field label={t('pur.expiryDate')}>
            <Input type="date" value={expiry} min={opening} onChange={(e) => setExpiry(e.target.value)} />
          </Field>
          <Field label={t('pur.latestShipment')}>
            <Input type="date" value={shipment} min={opening} max={expiry || undefined} onChange={(e) => setShipment(e.target.value)} />
          </Field>
        </div>
        <Field label={t('common.notes')}>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

export function LcListPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<any[]>('/letters-of-credit');
  const [dialog, setDialog] = useState(false);
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number}</span> },
      { id: 'lc', header: t('pur.lcNumber'), value: (r) => r.lc_number },
      { id: 'supplier', header: t('docs.supplier'), type: 'enum', value: (r) => r.supplier_name },
      { id: 'po', header: t('adv.purchaseOrder'), value: (r) => r.po_number },
      { id: 'amount', header: t('common.amount'), type: 'number', value: (r) => r.amount, render: (r) => cents(r.amount, r.currency) },
      { id: 'margin', header: t('pur.marginPct'), type: 'number', value: (r) => r.margin_bp / 100, format: (v) => `${v}%` },
      { id: 'opening', header: t('pur.openingDate'), type: 'date', nowrap: true, value: (r) => r.opening_date },
      { id: 'expiry', header: t('pur.expiryDate'), type: 'date', nowrap: true, value: (r) => r.expiry_date },
      { id: 'shipment', header: t('pur.latestShipment'), type: 'date', hidden: true, nowrap: true, value: (r) => r.latest_shipment_date },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('pur.lcStatus.' + v), render: (r) => <LcStatus status={r.status} /> },
    ],
    [t],
  );
  const presets = useMemo<Preset<any>[]>(() => ['opened', 'documents_received', 'settled', 'cancelled'].map((k) => ({ id: k, label: t('pur.lcStatus.' + k), test: (r: any) => r.status === k })), [t]);
  return (
    <div className="page">
      <PageHeader
        title={t('pur.lettersOfCredit')}
        subtitle={t('pur.lcSubtitle')}
        actions={
          can('purchasing.lc.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog(true)}>
              {t('pur.newLc')}
            </Button>
          )
        }
      />
      <DataGrid
        id="letters-of-credit"
        rows={data}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/purchasing/lc/${r.id}`)}
        exportName={t('pur.lettersOfCredit')}
        empty={<EmptyState icon={<Landmark size={22} />} title={t('common.noResults')} text={t('pur.lcSubtitle')} />}
      />
      <NewLc open={dialog} onClose={() => setDialog(false)} />
    </div>
  );
}

type Action = 'charges' | 'settle' | 'repay' | null;

export function LcView() {
  const { id } = useParams();
  const { t } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const { data: l, isLoading, error, refetch } = useApi<any>(`/letters-of-credit/${id}`);
  const [action, setAction] = useState<Action>(null);
  const [when, setWhen] = useState(todayIso());
  const [amount, setAmount] = useState<number | null>(null);
  const [memo, setMemo] = useState('');
  const [billId, setBillId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !l) return <ErrorBlock message={errText(error)} />;
  const active = l.status === 'opened' || l.status === 'documents_received';
  const canWrite = can('purchasing.lc.write');
  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(t('common.saved')), after?.(), refetch()), onError: (e) => toast.error(errText(e)) });
  const open = (a: Action) => (setAction(a), setErr(''), setWhen(todayIso()), setAmount(null), setMemo(''), setBillId(l.open_bills[0]?.id ?? null));
  const financed = l.financed_base - l.repaid_base;
  const submit = () => {
    const done = () => setAction(null);
    const fail = (e: unknown) => setErr(errText(e));
    if (action === 'charges') act.mutate(() => api.post(`/letters-of-credit/${l.id}/charges`, { date: when, amount, memo: memo || null }), { onSuccess: () => (done(), refetch()), onError: fail });
    if (action === 'repay') act.mutate(() => api.post(`/letters-of-credit/${l.id}/repay`, { date: when, amount }), { onSuccess: () => (done(), refetch()), onError: fail });
    if (action === 'settle') act.mutate(() => api.post(`/letters-of-credit/${l.id}/settle`, { documentId: billId, date: when, amount }), { onSuccess: () => (done(), refetch()), onError: fail });
  };
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/purchasing/lc', label: t('pur.lettersOfCredit') }]}
        title={`${l.number} · ${l.lc_number}`}
        badge={<LcStatus status={l.status} />}
        subtitle={`${l.supplier.name} · ${cents(l.amount, l.currency)}`}
        actions={
          canWrite && (
            <>
              {l.status === 'opened' && (
                <Button icon={<FileCheck2 />} onClick={() => run(() => api.post(`/letters-of-credit/${l.id}/documents`, {}))}>
                  {t('pur.documentsReceived')}
                </Button>
              )}
              {active && (
                <Button variant="primary" icon={<ReceiptText />} onClick={() => open('settle')} disabled={!l.open_bills.length}>
                  {t('pur.settle')}
                </Button>
              )}
              {l.status !== 'cancelled' && (
                <Button icon={<Banknote />} onClick={() => open('charges')}>
                  {t('pur.addCharges')}
                </Button>
              )}
              {financed > 0 && (
                <Button icon={<Undo2 />} onClick={() => open('repay')}>
                  {t('pur.repayBank')}
                </Button>
              )}
              {active && (
                <Button variant="danger" icon={<Ban />} onClick={() => run(() => api.post(`/letters-of-credit/${l.id}/close`, {}))}>
                  {l.settled_amount ? t('pur.closeLc') : t('pur.cancelLc')}
                </Button>
              )}
            </>
          )
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <div className="grid-2">
          <Card pad>
            <dl className="kv">
              <dt>{t('adv.purchaseOrder')}</dt>
              <dd>{l.po ? <Link to={`/purchasing/orders/${l.po.id}`}>{l.po.number}</Link> : '—'}</dd>
              <dt>{t('pur.bankAccount')}</dt>
              <dd>{l.bank_account.code} · {l.bank_account.name_en}</dd>
              <dt>{t('pur.openingDate')}</dt>
              <dd>{date(l.opening_date)}</dd>
              <dt>{t('pur.expiryDate')}</dt>
              <dd>{date(l.expiry_date)}</dd>
              <dt>{t('pur.latestShipment')}</dt>
              <dd>{l.latest_shipment_date ? date(l.latest_shipment_date) : '—'}</dd>
            </dl>
          </Card>
          <Card pad>
            <dl className="kv">
              <dt>{t('common.amount')}</dt>
              <dd>{cents(l.amount, l.currency)}</dd>
              <dt>{t('pur.settledAmount')}</dt>
              <dd>{cents(l.settled_amount, l.currency)}</dd>
              <dt>{t('pur.marginPct')}</dt>
              <dd>{l.margin_bp / 100}% · <Money v={l.margin_base} /></dd>
              <dt>{t('pur.marginLeft')}</dt>
              <dd><Money v={l.margin_base - l.margin_used_base} /></dd>
              <dt>{t('pur.bankFinancing')}</dt>
              <dd><Money v={financed} /></dd>
            </dl>
          </Card>
        </div>
        <Card className="table-card">
          <CardHeader title={t('pur.lcHistory')} />
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('common.type')}</th>
                  <th className="end">{t('common.amount')}</th>
                  <th>{t('pur.document')}</th>
                  <th>{t('nav.journal')}</th>
                  <th>{t('common.notes')}</th>
                </tr>
              </thead>
              <tbody>
                {l.events.map((e: any) => (
                  <tr key={e.id}>
                    <td className="nowrap">{date(e.date)}</td>
                    <td>{t('pur.lcEvents.' + e.kind)}</td>
                    <td className="end">{e.kind === 'settlement' ? cents(e.amount, l.currency) : e.base_amount ? <Money v={e.base_amount} /> : ''}</td>
                    <td>{e.document_id ? <Link to={`/purchases/bills/${e.document_id}`}>{e.document_number}</Link> : ''}</td>
                    <td>{e.entry_id ? <Link to={`/journal/${e.entry_id}`}>{e.entry_number}</Link> : ''}</td>
                    <td>{e.memo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Dialog
        open={action != null}
        onClose={() => setAction(null)}
        title={action ? t('pur.action.' + action) : ''}
        footer={
          <>
            <Button onClick={() => setAction(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={act.isPending} disabled={action === 'settle' ? !billId : !amount} onClick={submit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
          <Field label={t('common.date')}>
            <Input type="date" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          {action === 'settle' && (
            <>
              <Field label={t('pur.supplierInvoice')}>
                <Select value={billId ?? ''} onChange={(e) => setBillId(e.target.value ? Number(e.target.value) : null)}>
                  {l.open_bills.map((b: any) => (
                    <option key={b.id} value={b.id}>
                      {b.number} · {cents(b.outstanding, l.currency)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`${t('common.amount')} (${l.currency})`} hint={t('pur.settleHint')}>
                <DecimalInput scale={2} value={amount} onChange={setAmount} />
              </Field>
            </>
          )}
          {action === 'charges' && (
            <>
              <Field label={t('common.amount')}>
                <DecimalInput scale={2} value={amount} onChange={setAmount} />
              </Field>
              <Field label={t('common.notes')}>
                <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
              </Field>
            </>
          )}
          {action === 'repay' && (
            <Field label={t('common.amount')} hint={t('pur.repayHint', { amount: (financed / 100).toLocaleString('en', { minimumFractionDigits: 2 }) })}>
              <DecimalInput scale={2} value={amount} onChange={setAmount} />
            </Field>
          )}
          {err && <p className="danger-text">{err}</p>}
        </div>
      </Dialog>
    </div>
  );
}
