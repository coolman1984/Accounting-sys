import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AlertTriangle, Ban, BookOpen, Pencil, Plus, Search, Send, Ship, Trash2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { todayIso } from '../../core/format';
import type { Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { DecimalInput, Field, Input, Textarea } from '../../ui/Field';
import { AccountPicker } from '../../ui/Pickers';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { Qty } from './common';

interface Candidate {
  source_type: 'purchase_bill' | 'goods_receipt';
  source_id: number;
  number: string;
  date: string;
  supplier_name: string;
  value: number;
}
const keyOf = (c: { source_type: string; source_id: number }) => `${c.source_type}:${c.source_id}`;
const sourceLink = (type: string, id: number) => (type === 'goods_receipt' ? `/inventory/receipts/${id}` : `/purchases/bills/${id}`);

export function LandedEditor() {
  const { id } = useParams();
  const editing = id != null;
  const { t } = useI18n();
  const date = useDate();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const { can } = useSession();
  const { fmt, scale } = useMoney();
  const { data: existing, isLoading } = useApi<any>(editing ? `/inventory/landed-costs/${id}` : null);
  const { data: candidates } = useApi<Candidate[]>('/inventory/landed-costs/candidates');

  const [day, setDay] = useState(todayIso());
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<'value' | 'qty'>('value');
  const [counter, setCounter] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!existing) return;
    setDay(existing.date);
    setAmount(existing.amount);
    setMethod(existing.method);
    setCounter(existing.counter_account_id);
    setReference(existing.reference ?? '');
    setMemo(existing.memo ?? '');
    setPicked(new Set(existing.targets.map(keyOf)));
  }, [existing]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (candidates ?? []).filter((c) => picked.has(keyOf(c)) || !s || `${c.number} ${c.supplier_name}`.toLowerCase().includes(s));
  }, [candidates, q, picked]);
  const chosen = (candidates ?? []).filter((c) => picked.has(keyOf(c)));
  const base = chosen.reduce((s, c) => s + c.value, 0);
  const toggle = (c: Candidate) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(keyOf(c))) n.delete(keyOf(c));
      else n.add(keyOf(c));
      return n;
    });

  const save = useApiMutation((post: boolean) => {
    const body = {
      date: day,
      amount,
      method,
      counterAccountId: counter,
      reference: reference || null,
      memo: memo || null,
      post,
      targets: chosen.map((c) => ({ sourceType: c.source_type, sourceId: c.source_id })),
    };
    return editing ? api.put<{ id: number }>(`/inventory/landed-costs/${id}`, body) : api.post<{ id: number }>('/inventory/landed-costs', body);
  });
  const submit = (post: boolean) => {
    setErr('');
    save.mutate(post, {
      onSuccess: (r) => {
        toast.success(post ? t('common.posted') : t('common.saved'));
        navigate(`/inventory/landed-costs/${r.id}`);
      },
      onError: (e) => setErr(errText(e)),
    });
  };

  if (editing && isLoading) return <Loading />;
  const ready = !!amount && amount > 0 && !!counter && chosen.length > 0;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory/landed-costs', label: t('adv.landedCosts') }]}
        title={editing ? `${t('common.edit')} · ${t('adv.landedCost')}` : t('adv.newLanded')}
        subtitle={t('adv.landedSubtitle')}
        actions={
          <>
            <Button onClick={() => submit(false)} loading={save.isPending && !save.variables} disabled={!ready}>
              {t('common.saveDraft')}
            </Button>
            {can('inventory.post') && (
              <Button variant="primary" icon={<Send />} onClick={() => submit(true)} loading={save.isPending && !!save.variables} disabled={!ready}>
                {t('common.saveAndPost')}
              </Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <Card pad>
          <div className="grid-4" style={{ alignItems: 'start' }}>
            <Field label={t('common.amount')}>
              <DecimalInput scale={scale} value={amount} onChange={setAmount} autoFocus />
            </Field>
            <Field label={t('common.date')}>
              <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label={t('adv.method')}>
              <div className="segmented" style={{ width: '100%' }}>
                {(['value', 'qty'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1 }}>
                    {t('adv.methods.' + m)}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t('common.reference')}>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Field label={t('adv.counterAccount')} hint={t('adv.counterHint')} className="span-2">
              <AccountPicker value={counter} onChange={setCounter} filter={(a) => !['inventory', 'receivable', 'payable'].includes(a.subtype)} />
            </Field>
            <Field label={t('common.memo')} className="span-2">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card>
          <CardHeader
            title={t('adv.pickPurchases')}
            icon={<Ship size={18} className="muted" />}
            actions={
              <div className="input-group" style={{ maxWidth: 240 }}>
                <Search />
                <input className="input" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            }
          />
          <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink" />
                  <th>{t('common.number')}</th>
                  <th>{t('docs.supplier')}</th>
                  <th>{t('common.date')}</th>
                  <th className="end">{t('adv.receivedValue')}</th>
                  {method === 'value' && <th className="end">{t('adv.allocation')}</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const on = picked.has(keyOf(c));
                  return (
                    <tr key={keyOf(c)} className="clickable" onClick={() => toggle(c)}>
                      <td>
                        <input type="checkbox" checked={on} readOnly />
                      </td>
                      <td style={{ fontWeight: 550 }}>
                        {c.number} <Badge tone={c.source_type === 'goods_receipt' ? 'cyan' : 'blue'}>{c.source_type === 'goods_receipt' ? t('adv.receipt') : t('journal.sources.purchase_bill')}</Badge>
                      </td>
                      <td>{c.supplier_name}</td>
                      <td className="nowrap muted">{date(c.date)}</td>
                      <td className="end">
                        <Money v={c.value} />
                      </td>
                      {method === 'value' && <td className="end">{on && amount && base ? fmt(Math.round((amount * c.value) / base)) : ''}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="balance-bar">
            <span className="muted">
              {chosen.length} · {t('adv.receivedValue')} <span className="amount">{fmt(base)}</span>
            </span>
            <span className="spacer" />
            {amount && base ? (
              <span className="muted">
                + <span className="amount">{((amount / base) * 100).toFixed(1)}%</span>
              </span>
            ) : null}
          </div>
        </Card>
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

export function LandedList() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Paged<any>>('/inventory/landed-costs', { limit: 20000 });
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, nowrap: true, value: (r) => r.number, render: (r) => <span style={{ fontWeight: 550 }}>{r.number ?? <span className="faint">{t('status.draft')}</span>}</span> },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      { id: 'memo', header: t('common.memo'), value: (r) => r.memo ?? r.reference },
      { id: 'counter', header: t('adv.counterAccount'), type: 'enum', value: (r) => `${r.counter_code} · ${pick(r.counter_name_en, r.counter_name_ar)}` },
      { id: 'method', header: t('adv.method'), type: 'enum', value: (r) => r.method, format: (v) => t('adv.methods.' + v) },
      { id: 'targets', header: t('adv.purchases'), type: 'number', value: (r) => r.targets },
      { id: 'amount', header: t('common.amount'), type: 'money', total: true, value: (r) => (r.status === 'void' ? 0 : r.amount), render: (r) => <Money v={r.amount} /> },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('status.' + v), render: (r) => <SimpleStatus status={r.status} /> },
    ],
    [t, pick],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('adv.landedCosts')}
        subtitle={t('adv.landedSubtitle')}
        actions={
          can('inventory.write') && (
            <Link to="/inventory/landed-costs/new" className="btn btn-primary">
              <Plus /> {t('adv.newLanded')}
            </Link>
          )
        }
      />
      <DataGrid
        id="landed-costs"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/inventory/landed-costs/${r.id}`)}
        exportName={t('adv.landedCosts')}
        empty={<EmptyState icon={<Ship size={22} />} title={t('common.noResults')} text={t('adv.landedSubtitle')} />}
      />
    </div>
  );
}

export function LandedView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: lc, isLoading, error } = useApi<any>(`/inventory/landed-costs/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !lc) return <ErrorBlock message={errText(error)} />;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  const posted = lc.status !== 'draft';
  const sum = (k: string) => lc.allocations.reduce((s: number, a: any) => s + (a[k] ?? 0), 0);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory/landed-costs', label: t('adv.landedCosts') }]}
        title={lc.number ?? `${t('adv.landedCost')} · ${t('status.draft')}`}
        badge={<SimpleStatus status={lc.status} />}
        subtitle={`${date(lc.date, 'long')} · ${t('adv.methods.' + lc.method)}`}
        actions={
          <>
            {lc.status === 'draft' && can('inventory.write') && (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(() => api.del(`/inventory/landed-costs/${lc.id}`), t('common.deleted'), () => navigate('/inventory/landed-costs'));
                  }}
                >
                  {t('common.delete')}
                </Button>
                <Link to={`/inventory/landed-costs/${lc.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {lc.status === 'draft' && can('inventory.post') && (
              <Button variant="primary" icon={<Send />} loading={act.isPending} onClick={() => run(() => api.post(`/inventory/landed-costs/${lc.id}/post`), t('common.posted'))}>
                {t('common.post')}
              </Button>
            )}
            {lc.status === 'posted' && can('inventory.post') && (
              <Button
                variant="danger"
                icon={<Ban />}
                onClick={async () => {
                  if ((await confirm({ title: t('common.void'), danger: true, confirmLabel: t('common.void') })).ok)
                    run(() => api.post(`/inventory/landed-costs/${lc.id}/void`, {}), t('common.saved'));
                }}
              >
                {t('common.void')}
              </Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <div className="grid-4">
          <Card pad>
            <div className="label">{t('common.amount')}</div>
            <div className="amount" style={{ fontSize: 22, marginTop: 4 }}>
              <Money v={lc.amount} />
            </div>
          </Card>
          <Card pad className="span-2">
            <div className="label">{t('adv.counterAccount')}</div>
            <div style={{ marginTop: 6, fontWeight: 550 }}>
              {lc.counter_account.code} · {pick(lc.counter_account.name_en, lc.counter_account.name_ar)}
            </div>
          </Card>
          <Card pad>
            <div className="label">{t('nav.journal')}</div>
            <div style={{ marginTop: 6 }} className="stack">
              {lc.journal_entry_id ? (
                <Link to={`/journal/${lc.journal_entry_id}`} className="row" style={{ gap: 6 }}>
                  <BookOpen size={15} /> {lc.journal_number}
                </Link>
              ) : (
                <span className="faint">—</span>
              )}
              {lc.void_entry_id && (
                <Link to={`/journal/${lc.void_entry_id}`} className="row" style={{ gap: 6 }}>
                  <Ban size={15} /> {lc.void_journal_number}
                </Link>
              )}
            </div>
          </Card>
        </div>
        <Card>
          <CardHeader title={t('adv.purchases')} />
          <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
            {lc.targets.map((x: any) => (
              <Link key={keyOf(x)} to={sourceLink(x.source_type, x.source_id)} className="row">
                <span style={{ fontWeight: 550 }}>{x.number}</span>
                <span className="muted">{x.supplier_name}</span>
                <span className="spacer" />
                <span className="muted">{date(x.date)}</span>
              </Link>
            ))}
          </div>
        </Card>
        <Card className="table-card">
          <CardHeader title={t('adv.allocation')} />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('docs.item')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('adv.receivedValue')}</th>
                  {posted && (
                    <>
                      <th className="end">{t('adv.toInventory')}</th>
                      <th className="end">{t('adv.toCogs')}</th>
                      <th className="end">{t('common.amount')}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {lc.allocations.map((a: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <Link to={`/inventory/items/${a.item_id}`} style={{ fontWeight: 550 }}>
                        {pick(a.name_en, a.name_ar)}
                      </Link>
                      <span className="faint" style={{ fontSize: 12, marginInline: 8 }}>
                        {a.sku}
                      </span>
                    </td>
                    <td className="end">
                      <Qty v={a.received_qty} />
                    </td>
                    <td className="end">
                      <Money v={a.received_value} />
                    </td>
                    {posted && (
                      <>
                        <td className="end">
                          <Money v={a.to_inventory} />
                        </td>
                        <td className="end">
                          <Money v={a.to_cogs} />
                        </td>
                        <td className="end">
                          <Money v={a.amount} />
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {posted && (
                <tfoot>
                  <tr>
                    <td colSpan={3}>{t('common.total')}</td>
                    <td className="end">
                      <Money v={sum('to_inventory')} />
                    </td>
                    <td className="end">
                      <Money v={sum('to_cogs')} />
                    </td>
                    <td className="end">
                      <Money v={sum('amount')} />
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
