import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CalendarClock, Pause, Play, Plus, Repeat, Save, Trash2, Zap } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import type { DocumentFull } from '../../core/types';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { DOC_BASE } from '../../core/links';
import { formatDate, todayIso } from '../../core/format';
import { EmptyState, Loading, PageHeader } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { DecimalInput, Field, Input, Select } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { AccountPicker, ItemPicker, PartyPicker, TaxSelect } from '../../ui/Pickers';
import { useToast } from '../../ui/Toast';
import { useConfirm } from '../../ui/Dialog';
import { DataGrid, type Column } from '../../ui/DataGrid';

type Kind = 'sales_invoice' | 'purchase_bill' | 'journal';
type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
interface DocLine {
  itemId: number | null;
  description: string | null;
  quantity: number;
  unitPrice: number;
  discountBp: number;
  accountId: number | null;
  taxId: number | null;
}
interface JournalLine {
  accountId: number | null;
  debit: number;
  credit: number;
  description: string | null;
  partyId: number | null;
}
interface Template {
  id: number;
  name: string;
  kind: Kind;
  payload: { partyId?: number; notes?: string | null; reference?: string | null; memo?: string | null; taxInclusive?: boolean; lines: (DocLine | JournalLine)[] };
  frequency: Frequency;
  interval: number;
  first_date: string;
  done_count: number;
  end_date: string | null;
  max_count: number | null;
  auto_post: number;
  is_active: number;
  last_date: string | null;
  next_date: string | null;
  last_status?: string | null;
  last_message?: string | null;
}
interface Run {
  id: number;
  occurrence: number;
  date: string;
  status: 'created' | 'posted' | 'failed';
  document_id: number | null;
  document_number: string | null;
  entry_id: number | null;
  entry_number: string | null;
  message: string | null;
}
type GenResult = { templateId: number; name: string; date: string; ok: boolean; message: string | null };

const RUN_TONE: Record<string, Tone> = { created: 'blue', posted: 'green', failed: 'red' };
const DOC_KIND: Record<Exclude<Kind, 'journal'>, 'sales_invoice' | 'purchase_bill'> = { sales_invoice: 'sales_invoice', purchase_bill: 'purchase_bill' };

function useSchedule() {
  const { t } = useI18n();
  return (f: Frequency, n: number) => (n === 1 ? t('rec.every1.' + f) : t('rec.everyN.' + f, { n }));
}

/** Make everything due up to today, then say what happened. */
function useGenerate() {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const m = useApiMutation((templateId: number | null) => api.post<{ results: GenResult[] }>('/recurring/generate', { upTo: todayIso(), templateId }));
  return {
    pending: m.isPending,
    run: (templateId: number | null) =>
      m.mutate(templateId, {
        onSuccess: (r) => {
          const ok = r.results.filter((x) => x.ok).length;
          const bad = r.results.filter((x) => !x.ok);
          if (!r.results.length) toast.success(t('rec.nothingDue'));
          else if (!bad.length) toast.success(t('rec.made', { n: ok }));
          else toast.error(t('rec.madeFailed', { n: ok, failed: bad.length, message: bad[0].message ?? '' }));
        },
        onError: (e) => toast.error(errText(e)),
      }),
  };
}

// ------------------------------------------------------------------ list

function RecurringPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const schedule = useSchedule();
  const { data, isLoading } = useApi<Template[]>('/recurring');
  const { data: due } = useApi<{ id: number; dates: string[] }[]>('/recurring/due', { upTo: todayIso() });
  const gen = useGenerate();
  const dueCount = (due ?? []).reduce((s, d) => s + d.dates.length, 0);
  const columns = useMemo<Column<Template>[]>(
    () => [
      { id: 'name', header: t('common.name'), pinned: true, value: (x) => x.name, render: (x) => <strong>{x.name}</strong> },
      { id: 'kind', header: t('rec.kind'), type: 'enum', value: (x) => x.kind, format: (v) => t('rec.kinds.' + v) },
      { id: 'schedule', header: t('rec.schedule'), value: (x) => schedule(x.frequency, x.interval) },
      {
        id: 'next',
        header: t('rec.nextDate'),
        type: 'date',
        value: (x) => x.next_date,
        render: (x) => (x.next_date ? <span className={x.next_date <= todayIso() ? 'warning-text' : undefined}>{formatDate(x.next_date, locale)}</span> : <span className="faint">—</span>),
      },
      { id: 'done', header: t('rec.done'), type: 'number', value: (x) => x.done_count, render: (x) => <span className="num">{x.done_count}{x.max_count ? ` / ${x.max_count}` : ''}</span> },
      { id: 'auto', header: t('rec.autoPost'), type: 'enum', value: (x) => (x.auto_post ? 'yes' : 'no'), format: (v) => t('common.' + v) },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (x) => (!x.is_active ? 'paused' : x.last_status === 'failed' ? 'failed' : !x.next_date ? 'finished' : 'active'),
        format: (v) => t('rec.state.' + v),
        render: (x) =>
          !x.is_active ? <Badge>{t('rec.state.paused')}</Badge> : x.last_status === 'failed' ? <Badge tone="red">{t('rec.state.failed')}</Badge> : !x.next_date ? <Badge>{t('rec.state.finished')}</Badge> : <Badge tone="green">{t('rec.state.active')}</Badge>,
      },
    ],
    [t, locale, schedule],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('rec.title')}
        subtitle={t('rec.subtitle')}
        actions={
          can('recurring.templates.write') && (
            <>
              <Button icon={<Zap />} loading={gen.pending} disabled={!dueCount} onClick={() => gen.run(null)}>
                {dueCount ? t('rec.makeDue', { n: dueCount }) : t('rec.noneDue')}
              </Button>
              <Link to="/recurring/new" className="btn btn-primary">
                <Plus /> {t('rec.new')}
              </Link>
            </>
          )
        }
      />
      <DataGrid
        id="recurring"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(x) => x.id}
        onRowClick={(x) => navigate(`/recurring/${x.id}`)}
        exportName={t('rec.title')}
        empty={<EmptyState icon={<Repeat size={22} />} title={t('rec.none')} text={t('rec.noneText')} />}
      />
    </div>
  );
}

// ------------------------------------------------------------------ editor + history

const blankDoc = (): DocLine => ({ itemId: null, description: '', quantity: 1000, unitPrice: 0, discountBp: 0, accountId: null, taxId: null });
const blankJournal = (): JournalLine => ({ accountId: null, debit: 0, credit: 0, description: '', partyId: null });

function RecurringEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [params] = useSearchParams();
  const from = params.get('from');
  const { t, locale } = useI18n();
  const { fmt, scale } = useMoney();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const schedule = useSchedule();
  const gen = useGenerate();
  const { data: cur, isLoading } = useApi<Template & { runs: Run[] }>(isNew ? null : `/recurring/${id}`);
  const { data: source } = useApi<DocumentFull>(isNew && from ? `/documents/${from}` : null);

  const [f, setF] = useState({
    name: '',
    kind: 'sales_invoice' as Kind,
    frequency: 'monthly' as Frequency,
    interval: 1,
    firstDate: todayIso(),
    endDate: '',
    maxCount: null as number | null,
    autoPost: false,
    isActive: true,
    partyId: null as number | null,
    notes: '',
    memo: '',
    reference: '',
    taxInclusive: false,
  });
  const [docLines, setDocLines] = useState<DocLine[]>([blankDoc()]);
  const [jLines, setJLines] = useState<JournalLine[]>([blankJournal(), blankJournal()]);

  useEffect(() => {
    if (!cur) return;
    const p = cur.payload;
    setF({
      name: cur.name,
      kind: cur.kind,
      frequency: cur.frequency,
      interval: cur.interval,
      firstDate: cur.first_date,
      endDate: cur.end_date ?? '',
      maxCount: cur.max_count,
      autoPost: !!cur.auto_post,
      isActive: !!cur.is_active,
      partyId: p.partyId ?? null,
      notes: p.notes ?? '',
      memo: p.memo ?? '',
      reference: p.reference ?? '',
      taxInclusive: !!p.taxInclusive,
    });
    if (cur.kind === 'journal') setJLines(p.lines as JournalLine[]);
    else setDocLines(p.lines as DocLine[]);
  }, [cur]);
  // "Repeat this invoice": start from an existing sales invoice or supplier bill.
  useEffect(() => {
    if (!source || (source.kind !== 'sales_invoice' && source.kind !== 'purchase_bill')) return;
    setF((x) => ({ ...x, name: `${source.party.name}`, kind: source.kind as Kind, partyId: source.party_id, notes: source.notes ?? '', reference: source.reference ?? '', taxInclusive: !!source.tax_inclusive }));
    setDocLines(source.lines.map((l) => ({ itemId: l.item_id, description: l.description, quantity: l.quantity, unitPrice: l.unit_price, discountBp: l.discount_bp, accountId: l.account_id, taxId: l.tax_id })));
  }, [source]);

  const locked = !!cur && cur.done_count > 0;
  const journal = f.kind === 'journal';
  const dr = jLines.reduce((s, l) => s + (l.debit || 0), 0);
  const cr = jLines.reduce((s, l) => s + (l.credit || 0), 0);
  const docTotal = docLines.reduce((s, l) => s + Math.round((l.quantity * l.unitPrice) / 1000), 0);
  const body = () => ({
    name: f.name,
    kind: f.kind,
    frequency: f.frequency,
    interval: f.interval,
    firstDate: f.firstDate,
    endDate: f.endDate || null,
    maxCount: f.maxCount,
    autoPost: f.autoPost,
    isActive: f.isActive,
    payload: journal
      ? { memo: f.memo || null, reference: f.reference || null, lines: jLines.map((l) => ({ ...l, description: l.description || null })) }
      : { partyId: f.partyId, notes: f.notes || null, reference: f.reference || null, taxInclusive: f.taxInclusive, lines: docLines.map((l) => ({ ...l, description: l.description || null })) },
  });
  const save = useApiMutation(() => (isNew ? api.post<{ id: number }>('/recurring', body()) : api.put<{ id: number }>(`/recurring/${id}`, body())));
  const del = useApiMutation(() => api.del(`/recurring/${id}`));
  // Pausing keeps the saved template as it is (not unsaved edits on the screen).
  const pause = useApiMutation((active: boolean) =>
    api.put(`/recurring/${id}`, { name: cur!.name, kind: cur!.kind, frequency: cur!.frequency, interval: cur!.interval, firstDate: cur!.first_date, endDate: cur!.end_date, maxCount: cur!.max_count, autoPost: !!cur!.auto_post, isActive: active, payload: cur!.payload }),
  );
  const onSave = () =>
    save.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(t('rec.saved'));
        if (isNew) navigate(`/recurring/${r.id}`, { replace: true });
      },
      onError: (e) => toast.error(errText(e)),
    });
  if (!isNew && (isLoading || !cur)) return <Loading />;
  const setDoc = (i: number, patch: Partial<DocLine>) => setDocLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setJ = (i: number, patch: Partial<JournalLine>) => setJLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const writable = can('recurring.templates.write');
  const invalid = !f.name.trim() || (journal ? dr !== cr || dr === 0 || jLines.some((l) => !l.accountId) : !f.partyId || docLines.some((l) => !l.quantity || (!l.itemId && !l.description)));

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/recurring', label: t('rec.title') }]}
        title={isNew ? t('rec.new') : cur!.name}
        subtitle={!isNew && cur ? `${schedule(cur.frequency, cur.interval)} · ${cur.next_date ? t('rec.nextOn', { date: formatDate(cur.next_date, locale) }) : t('rec.state.finished')}` : t('rec.editorHint')}
        badge={!isNew && !cur!.is_active ? <Badge>{t('rec.state.paused')}</Badge> : undefined}
        actions={
          writable && (
            <>
              {!isNew && cur!.next_date && cur!.next_date <= todayIso() && !!cur!.is_active && (
                <Button icon={<Zap />} loading={gen.pending} onClick={() => gen.run(cur!.id)}>
                  {t('rec.makeNow')}
                </Button>
              )}
              {!isNew && (
                <Button
                  icon={cur!.is_active ? <Pause /> : <Play />}
                  loading={pause.isPending}
                  onClick={() => pause.mutate(!cur!.is_active, { onSuccess: () => toast.success(cur!.is_active ? t('rec.paused') : t('rec.resumed')), onError: (e) => toast.error(errText(e)) })}
                >
                  {cur!.is_active ? t('rec.pause') : t('rec.resume')}
                </Button>
              )}
              {!isNew && !locked && (
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if (!(await confirm({ title: t('rec.deleteQ'), danger: true, confirmLabel: t('common.delete') })).ok) return;
                    del.mutate(undefined, { onSuccess: () => navigate('/recurring', { replace: true }), onError: (e) => toast.error(errText(e)) });
                  }}
                >
                  {t('common.delete')}
                </Button>
              )}
              <Button variant="primary" icon={<Save />} loading={save.isPending} disabled={invalid} onClick={onSave}>
                {t('common.save')}
              </Button>
            </>
          )
        }
      />
      <Card pad>
        <div className="stack">
          <div className="grid-3">
            <Field label={t('common.name')} hint={t('rec.nameHint')}>
              <Input value={f.name} autoFocus={isNew} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label={t('rec.kind')} hint={locked ? t('rec.lockedHint') : undefined}>
              <Select value={f.kind} disabled={locked} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
                {(['sales_invoice', 'purchase_bill', 'journal'] as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {t('rec.kinds.' + k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('rec.autoPost')} hint={t('rec.autoPostHint')}>
              <Switch checked={f.autoPost} onChange={(v) => setF({ ...f, autoPost: v })} />
            </Field>
          </div>
          <div className="grid-3">
            <Field label={t('rec.every')}>
              <div className="row" style={{ gap: 8 }}>
                <Input type="number" min={1} max={24} value={f.interval} disabled={locked} style={{ width: 80 }} onChange={(e) => setF({ ...f, interval: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })} />
                <Select value={f.frequency} disabled={locked} onChange={(e) => setF({ ...f, frequency: e.target.value as Frequency })}>
                  {(['weekly', 'monthly', 'quarterly', 'yearly'] as Frequency[]).map((k) => (
                    <option key={k} value={k}>
                      {t('rec.units.' + k)}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label={t('rec.firstDate')} hint={t('rec.firstDateHint')}>
              <Input type="date" value={f.firstDate} disabled={locked} onChange={(e) => setF({ ...f, firstDate: e.target.value })} />
            </Field>
            <div className="grid-2">
              <Field label={t('rec.endDate')}>
                <Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
              </Field>
              <Field label={t('rec.maxCount')}>
                <Input type="number" min={1} value={f.maxCount ?? ''} onChange={(e) => setF({ ...f, maxCount: e.target.value ? Math.max(1, Number(e.target.value)) : null })} />
              </Field>
            </div>
          </div>
          {journal ? (
            <div className="grid-2">
              <Field label={t('common.memo')} hint={t('rec.placeholders')}>
                <Input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
              </Field>
              <Field label={t('common.reference')}>
                <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
              </Field>
            </div>
          ) : (
            <div className="grid-3">
              <Field label={f.kind === 'sales_invoice' ? t('rec.customer') : t('rec.supplier')}>
                <PartyPicker kind={f.kind === 'sales_invoice' ? 'customer' : 'supplier'} value={f.partyId} onChange={(v) => setF({ ...f, partyId: v })} />
              </Field>
              <Field label={t('common.notes')} hint={t('rec.placeholders')}>
                <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
              </Field>
              <Field label={t('common.reference')}>
                <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
      </Card>

      <Card className="lines-grid">
        <div className="table-wrap">
          {journal ? (
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: '28%' }}>{t('common.account')}</th>
                  <th>{t('common.description')}</th>
                  <th style={{ width: '18%' }}>{t('rec.party')}</th>
                  <th className="end" style={{ width: 140 }}>
                    {t('common.debit')}
                  </th>
                  <th className="end" style={{ width: 140 }}>
                    {t('common.credit')}
                  </th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {jLines.map((l, i) => (
                  <tr key={i}>
                    <td className="line-no">{i + 1}</td>
                    <td>
                      <AccountPicker value={l.accountId} onChange={(v) => setJ(i, { accountId: v })} />
                    </td>
                    <td>
                      <Input value={l.description ?? ''} onChange={(e) => setJ(i, { description: e.target.value })} />
                    </td>
                    <td>
                      <PartyPicker value={l.partyId} onChange={(v) => setJ(i, { partyId: v })} />
                    </td>
                    <td>
                      <DecimalInput scale={scale} value={l.debit || null} onChange={(v) => setJ(i, { debit: v ?? 0, credit: v ? 0 : l.credit })} aria-label={t('common.debit')} />
                    </td>
                    <td>
                      <DecimalInput scale={scale} value={l.credit || null} onChange={(v) => setJ(i, { credit: v ?? 0, debit: v ? 0 : l.debit })} aria-label={t('common.credit')} />
                    </td>
                    <td>
                      <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} disabled={jLines.length <= 2} onClick={() => setJLines((ls) => ls.filter((_, j) => j !== i))} aria-label={t('common.remove')} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="grand-row">
                  <td colSpan={4} className={dr !== cr ? 'danger-text' : undefined}>
                    {dr !== cr ? t('rec.unbalanced', { diff: fmt(Math.abs(dr - cr)) }) : t('common.total')}
                  </td>
                  <td className="end num">{fmt(dr)}</td>
                  <td className="end num">{fmt(cr)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink center">#</th>
                  <th style={{ width: '20%' }}>{t('rec.item')}</th>
                  <th>{t('common.description')}</th>
                  <th className="end" style={{ width: 100 }}>
                    {t('rec.qty')}
                  </th>
                  <th className="end" style={{ width: 130 }}>
                    {t('rec.price')}
                  </th>
                  <th style={{ width: 150 }}>{t('rec.tax')}</th>
                  <th style={{ width: '18%' }}>{t('common.account')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {docLines.map((l, i) => (
                  <tr key={i}>
                    <td className="line-no">{i + 1}</td>
                    <td>
                      <ItemPicker
                        value={l.itemId}
                        onChange={(v, item) =>
                          setDoc(i, {
                            itemId: v,
                            description: l.description || (item ? (locale === 'ar' ? item.name_ar : item.name_en) : ''),
                            unitPrice: item ? (f.kind === 'sales_invoice' ? item.sale_price : item.purchase_price) : l.unitPrice,
                          })
                        }
                      />
                    </td>
                    <td>
                      <Input value={l.description ?? ''} placeholder={t('rec.placeholders')} onChange={(e) => setDoc(i, { description: e.target.value })} />
                    </td>
                    <td>
                      <DecimalInput scale={3} trim value={l.quantity} onChange={(v) => setDoc(i, { quantity: v ?? 0 })} aria-label={t('rec.qty')} />
                    </td>
                    <td>
                      <DecimalInput scale={scale} value={l.unitPrice} onChange={(v) => setDoc(i, { unitPrice: v ?? 0 })} aria-label={t('rec.price')} />
                    </td>
                    <td>
                      <TaxSelect side={f.kind === 'sales_invoice' ? 'sales' : 'purchases'} value={l.taxId} onChange={(v) => setDoc(i, { taxId: v })} />
                    </td>
                    <td>
                      <AccountPicker value={l.accountId} placeholder={t('rec.defaultAccount')} onChange={(v) => setDoc(i, { accountId: v })} />
                    </td>
                    <td>
                      <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} disabled={docLines.length <= 1} onClick={() => setDocLines((ls) => ls.filter((_, j) => j !== i))} aria-label={t('common.remove')} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="grand-row">
                  <td colSpan={4}>{t('rec.beforeTax')}</td>
                  <td className="end num">{fmt(docTotal)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        <div style={{ padding: '10px 14px' }}>
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => (journal ? setJLines((ls) => [...ls, blankJournal()]) : setDocLines((ls) => [...ls, blankDoc()]))}>
            {t('common.addLine')}
          </Button>
        </div>
      </Card>

      {!isNew && (
        <Card className="table-card">
          <CardHeader title={t('rec.history')} icon={<CalendarClock size={18} className="muted" />} />
          {!cur!.runs.length ? (
            <EmptyState title={t('rec.noRuns')} text={cur!.next_date ? t('rec.nextOn', { date: formatDate(cur!.next_date, locale) }) : undefined} />
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('common.number')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('rec.message')}</th>
                </tr>
              </thead>
              <tbody>
                {cur!.runs.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{formatDate(r.date, locale)}</td>
                    <td>
                      {r.entry_id ? (
                        <Link to={`/journal/${r.entry_id}`} className="num">
                          {r.entry_number ?? t('status.draft')}
                        </Link>
                      ) : r.document_id && cur!.kind !== 'journal' ? (
                        r.document_number || r.status === 'created' ? (
                          <Link to={`${DOC_BASE[DOC_KIND[cur!.kind as Exclude<Kind, 'journal'>]]}/${r.document_id}`} className="num">
                            {r.document_number ?? t('status.draft')}
                          </Link>
                        ) : (
                          <span className="faint">—</span>
                        )
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td>
                      <Badge plain tone={RUN_TONE[r.status]}>
                        {t('rec.runStatus.' + r.status)}
                      </Badge>
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {r.message?.replace(/^[a-z_.]+: /, '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ slots

/** On an invoice or bill: "Repeat this" starts a template from it. */
function RepeatDocument({ documentId, kind }: { documentId: number; kind: string; status: string }) {
  const { t } = useI18n();
  const { can, hasApp } = useSession();
  if (!hasApp('recurring') || !can('recurring.templates.write') || (kind !== 'sales_invoice' && kind !== 'purchase_bill')) return null;
  return (
    <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Link to={`/recurring/new?from=${documentId}`} className="btn btn-sm">
        <Repeat /> {t('rec.repeatThis')}
      </Link>
    </div>
  );
}

/** On the dashboard: what is due and one click to make it. */
function DueWidget() {
  const { t } = useI18n();
  const { can, hasApp } = useSession();
  const ok = hasApp('recurring') && can('recurring.templates.read');
  const { data } = useApi<{ id: number; name: string; dates: string[] }[]>(ok ? '/recurring/due' : null, { upTo: todayIso() });
  const gen = useGenerate();
  if (!data?.length) return null;
  const n = data.reduce((s, d) => s + d.dates.length, 0);
  return (
    <Card className="table-card">
      <CardHeader
        title={t('rec.dueTitle', { n })}
        icon={<Repeat size={18} className="muted" />}
        actions={
          can('recurring.templates.write') && (
            <Button size="sm" variant="primary" icon={<Zap />} loading={gen.pending} onClick={() => gen.run(null)}>
              {t('rec.makeAll')}
            </Button>
          )
        }
      />
      <table className="table table-compact">
        <tbody>
          {data.slice(0, 6).map((d) => (
            <tr key={d.id}>
              <td>
                <Link to={`/recurring/${d.id}`}>{d.name}</Link>
              </td>
              <td className="end num faint">{d.dates.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export const recurringModule: WebModule = {
  id: 'recurring',
  nav: [{ to: '/recurring', label: 'rec.title', icon: Repeat, section: 'gl', order: 60, perm: 'recurring.templates.read', app: 'recurring' }],
  routes: [
    { path: '/recurring', element: <RecurringPage /> },
    { path: '/recurring/:id', element: <RecurringEditor key="rec" /> },
  ],
  commands: [
    { id: 'go-recurring', label: 'rec.title', icon: Repeat, group: 'navigate', to: '/recurring', perm: 'recurring.templates.read', app: 'recurring', keywords: 'recurring repeat subscription rent monthly متكرر شهري إيجار اشتراك' },
    { id: 'new-recurring', label: 'rec.new', icon: Repeat, group: 'create', to: '/recurring/new', perm: 'recurring.templates.write', app: 'recurring' },
  ],
  slots: { 'document.view': RepeatDocument, 'dashboard.widgets': DueWidget },
};
