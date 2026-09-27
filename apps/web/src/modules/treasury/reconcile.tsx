import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { AlertTriangle, CheckCircle2, FileUp, Landmark, Link2, Plus, Trash2, Unlink, Wand2, Wallet } from 'lucide-react';
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
import { Checkbox, DecimalInput, Field, Input, Select } from '../../ui/Field';
import { AccountPicker } from '../../ui/Pickers';
import { CostCenterSelect, useCostCenters } from '../../ui/CostCenter';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { guessMapping, parseCsv, toLines, type DateFormat, type Mapping, type ParsedLine } from './csv';

interface BankAccount {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  subtype: 'cash' | 'bank';
  is_active: number;
  balance: number;
  currency: string | null;
  balance_fx: number;
  reconciled_to: string | null;
  reconciled_balance: number | null;
  open_statement_id: number | null;
  uncleared: number;
}

interface StatementRow {
  id: number;
  account_id: number;
  account_code: string;
  account_name_en: string;
  account_name_ar: string;
  date: string;
  reference: string | null;
  opening_balance: number;
  closing_balance: number;
  status: 'open' | 'reconciled';
  lines: number;
  unmatched: number;
}

interface SLine {
  id: number;
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  journal_line_id: number | null;
  entry_id: number | null;
  entry_number: string | null;
  source_type: string | null;
}

interface BookLine {
  id: number;
  entry_id: number;
  number: string | null;
  date: string;
  reference: string | null;
  memo: string | null;
  description: string | null;
  source_type: string;
  amount: number;
}

interface StatementFull {
  id: number;
  account_id: number;
  account: { id: number; code: string; name_en: string; name_ar: string };
  date: string;
  reference: string | null;
  opening_balance: number;
  closing_balance: number;
  status: 'open' | 'reconciled';
  lines: SLine[];
  book: BookLine[];
  summary: { linesTotal: number; lines: number; unmatched: number; difference: number; bookBalance: number; unclearedTotal: number };
}

// ------------------------------------------------------------------ import

/** Read a bank's CSV export: guess the columns, let the user correct them, preview the result. */
function ImportPanel({ onLines }: { onLines(lines: ParsedLine[]): void }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [m, setM] = useState<Mapping | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const result = useMemo(() => (rows && m ? toLines(rows, m, scale) : null), [rows, m, scale]);
  useEffect(() => onLines(result?.lines ?? []), [result, onLines]);

  const load = async (f: File) => {
    const text = await f.text();
    const r = parseCsv(text);
    setRows(r);
    setM(guessMapping(r));
  };
  const cols = (rows?.[0] ?? []).map((h, i) => ({ i, label: m?.header ? h || `#${i + 1}` : `${t('bank.column')} ${i + 1}${h ? ` (${h.slice(0, 18)})` : ''}` }));
  const colSelect = (value: number | null, set: (v: number | null) => void, optional = false) => (
    <Select value={value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}>
      {optional && <option value="">—</option>}
      {cols.map((c) => (
        <option key={c.i} value={c.i}>
          {c.label}
        </option>
      ))}
    </Select>
  );

  return (
    <div className="stack">
      <div className="row" style={{ gap: 10 }}>
        <input ref={file} type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        <Button icon={<FileUp />} onClick={() => file.current?.click()}>
          {t('bank.chooseFile')}
        </Button>
        <span className="faint" style={{ fontSize: 12.5 }}>
          {t('bank.importHint')}
        </span>
      </div>
      {m && rows && (
        <>
          <div className="grid-3">
            <Field label={t('common.date')}>{colSelect(m.date, (v) => setM({ ...m, date: v ?? 0 }))}</Field>
            <Field label={t('bank.dateFormat')}>
              <Select value={m.dateFormat} onChange={(e) => setM({ ...m, dateFormat: e.target.value as DateFormat })}>
                <option value="dmy">31/01/2026</option>
                <option value="mdy">01/31/2026</option>
                <option value="ymd">2026-01-31</option>
              </Select>
            </Field>
            <Field label={t('common.description')}>{colSelect(m.description, (v) => setM({ ...m, description: v ?? 0 }))}</Field>
            <Field label={t('common.reference')}>{colSelect(m.reference, (v) => setM({ ...m, reference: v }), true)}</Field>
            {m.amount != null ? (
              <Field label={t('bank.amountSigned')}>{colSelect(m.amount, (v) => setM({ ...m, amount: v }))}</Field>
            ) : (
              <>
                <Field label={t('bank.moneyIn')}>{colSelect(m.moneyIn, (v) => setM({ ...m, moneyIn: v }), true)}</Field>
                <Field label={t('bank.moneyOut')}>{colSelect(m.moneyOut, (v) => setM({ ...m, moneyOut: v }), true)}</Field>
              </>
            )}
          </div>
          <div className="row" style={{ gap: 18 }}>
            <Checkbox label={t('bank.hasHeader')} checked={m.header} onChange={(v) => setM({ ...m, header: v })} />
            <Checkbox
              label={t('bank.twoColumns')}
              checked={m.amount == null}
              onChange={(v) => setM(v ? { ...m, amount: null, moneyIn: m.amount ?? 2, moneyOut: (m.amount ?? 2) + 1 } : { ...m, amount: m.moneyIn ?? 2, moneyIn: null, moneyOut: null })}
            />
          </div>
          {result && (
            <>
              <div className="table-wrap">
                <table className="table table-compact">
                  <tbody>
                    {result.lines.slice(0, 6).map((l, i) => (
                      <tr key={i}>
                        <td className="nowrap">{l.date}</td>
                        <td>{l.description}</td>
                        <td className="faint">{l.reference}</td>
                        <td className="end">
                          <Money v={l.amount} tone />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={result.errors.length ? 'warning-text' : 'success-text'} style={{ fontSize: 13 }}>
                {t('bank.readLines', { n: result.lines.length })}
                {result.errors.length > 0 && ' · ' + t('bank.badRows', { rows: result.errors.slice(0, 8).join(', ') + (result.errors.length > 8 ? '…' : '') })}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- new statement

function NewStatementDialog({ account, onClose }: { account: BankAccount | null; onClose(): void }) {
  const { t, pick } = useI18n();
  const { scale } = useMoney();
  const navigate = useNavigate();
  const errText = useErrorText();
  const { data: next } = useApi<{ openingBalance: number; after: string | null; fixed: boolean }>(account ? '/bank/statements/next' : null, { accountId: account?.id });
  const [f, setF] = useState({ date: todayIso(), reference: '', opening: null as number | null, closing: null as number | null });
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (account) setF({ date: todayIso(), reference: '', opening: null, closing: null }), setErr(''), setLines([]);
  }, [account]);
  useEffect(() => {
    if (next) setF((x) => ({ ...x, opening: next.openingBalance }));
  }, [next]);
  // With imported lines the closing balance follows from them — one number less to type.
  const computed = (f.opening ?? 0) + lines.reduce((s, l) => s + l.amount, 0);
  const save = useApiMutation(() =>
    api.post<{ id: number }>('/bank/statements', {
      accountId: account!.id,
      date: f.date,
      reference: f.reference || null,
      openingBalance: f.opening,
      closingBalance: f.closing ?? computed,
      lines,
    }),
  );
  return (
    <Dialog
      open={!!account}
      onClose={onClose}
      wide
      title={account ? `${t('bank.newStatement')} · ${account.code} ${pick(account.name_en, account.name_ar)}` : ''}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={f.closing == null && lines.length === 0}
            onClick={() => save.mutate(undefined, { onSuccess: (r) => (onClose(), navigate(`/bank/statements/${r.id}`)), onError: (e) => setErr(errText(e)) })}
          >
            {t('bank.startReconciling')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-4">
          <Field label={t('bank.statementDate')} hint={next?.after ? t('bank.after', { date: next.after }) : undefined}>
            <Input type="date" value={f.date} min={next?.after ?? undefined} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={t('common.reference')}>
            <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder={t('bank.referenceHint')} />
          </Field>
          <Field label={t('bank.opening')} hint={next?.fixed ? t('bank.openingFixed') : undefined}>
            <DecimalInput scale={scale} value={f.opening} onChange={(v) => setF({ ...f, opening: v })} disabled={next?.fixed} />
          </Field>
          <Field label={t('bank.closing')} hint={lines.length ? t('bank.closingFromLines') : undefined}>
            <DecimalInput scale={scale} value={f.closing ?? (lines.length ? computed : null)} onChange={(v) => setF({ ...f, closing: v })} />
          </Field>
        </div>
        <Card pad>
          <CardHeader title={t('bank.importTitle')} sub={t('bank.importSub')} />
          <ImportPanel onLines={setLines} />
        </Card>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ overview

export function BankPage() {
  const { t, pick, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const { data: accounts, isLoading } = useApi<BankAccount[]>('/bank/accounts');
  const { data: statements } = useApi<StatementRow[]>('/bank/statements');
  const [newFor, setNewFor] = useState<BankAccount | null>(null);
  const columns = useMemo<Column<StatementRow>[]>(
    () => [
      { id: 'date', header: t('bank.statementDate'), type: 'date', value: (r) => r.date },
      { id: 'account', header: t('common.account'), type: 'enum', value: (r) => `${r.account_code} · ${pick(r.account_name_en, r.account_name_ar)}` },
      { id: 'reference', header: t('common.reference'), value: (r) => r.reference },
      { id: 'lines', header: t('bank.lines'), type: 'number', value: (r) => r.lines },
      { id: 'closing', header: t('bank.closing'), type: 'money', value: (r) => r.closing_balance, render: (r) => <Money v={r.closing_balance} /> },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (r) => r.status,
        format: (v) => t('bank.status.' + v),
        render: (r) => (r.status === 'reconciled' ? <Badge tone="green">{t('bank.status.reconciled')}</Badge> : <Badge tone="amber">{t('bank.status.open')}</Badge>),
      },
    ],
    [t, pick],
  );
  if (isLoading) return <Loading />;
  return (
    <div className="page">
      <PageHeader title={t('bank.title')} subtitle={t('bank.subtitle')} />
      <div className="bank-cards">
        {(accounts ?? []).map((a) => (
          <Card key={a.id} pad className="bank-card">
            <div className="row" style={{ gap: 10 }}>
              <span className="bank-icon">{a.subtype === 'bank' ? <Landmark size={18} /> : <Wallet size={18} />}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{pick(a.name_en, a.name_ar)}</div>
                <div className="faint num" style={{ fontSize: 12 }}>{a.code}</div>
              </div>
            </div>
            <div className="bank-balance">
              {a.currency && <span className="faint num" style={{ fontSize: 14, marginInlineEnd: 6 }}>{a.currency}</span>}
              <Money v={a.currency ? a.balance_fx : a.balance} />
              {a.currency && (
                <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>
                  ≈ <Money v={a.balance} />
                </div>
              )}
            </div>
            <div className="faint" style={{ fontSize: 12.5 }}>
              {a.reconciled_to ? t('bank.reconciledTo', { date: formatDate(a.reconciled_to, locale) }) : t('bank.neverReconciled')}
              {' · '}
              {t('bank.uncleared', { n: a.uncleared })}
            </div>
            {can('treasury.statements.write') &&
              (a.open_statement_id ? (
                <Button size="sm" variant="primary" onClick={() => navigate(`/bank/statements/${a.open_statement_id}`)}>
                  {t('bank.continue')}
                </Button>
              ) : (
                <Button size="sm" icon={<Plus />} onClick={() => setNewFor(a)}>
                  {t('bank.reconcile')}
                </Button>
              ))}
          </Card>
        ))}
      </div>
      <h3 className="section-title">{t('bank.statements')}</h3>
      <DataGrid
        id="bank.statements"
        rows={statements}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/bank/statements/${r.id}`)}
        exportName={t('bank.statements')}
        empty={<EmptyState icon={<Landmark size={22} />} title={t('bank.noStatements')} text={t('bank.noStatementsText')} />}
      />
      <NewStatementDialog account={newFor} onClose={() => setNewFor(null)} />
    </div>
  );
}

// -------------------------------------------------------- record a bank line

function EntryDialog({ line, onClose }: { line: SLine | null; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const cc = useCostCenters();
  const [f, setF] = useState({ accountId: null as number | null, account: null as Account | null, description: '', costCenterId: null as number | null });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (line) setF({ accountId: null, account: null, description: line.description, costCenterId: null }), setErr('');
  }, [line]);
  const pl = f.account?.type === 'income' || f.account?.type === 'expense';
  const save = useApiMutation(() => api.post(`/bank/statement-lines/${line!.id}/entry`, { accountId: f.accountId, description: f.description || null, costCenterId: pl ? f.costCenterId : null }));
  return (
    <Dialog
      open={!!line}
      onClose={onClose}
      title={t('bank.recordLine')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.accountId}
            onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.posted')), onClose()), onError: (e) => setErr(errText(e)) })}
          >
            {t('common.saveAndPost')}
          </Button>
        </>
      }
    >
      {line && (
        <div className="stack">
          <div className="notice">
            <Landmark />
            <div>
              {line.date} · {line.description} · <Money v={line.amount} tone />
            </div>
          </div>
          <Field label={line.amount < 0 ? t('bank.expenseAccount') : t('bank.incomeAccount')} hint={t('bank.recordHint')}>
            <AccountPicker
              value={f.accountId}
              onChange={(id, a) => setF({ ...f, accountId: id, account: a ?? null })}
              filter={(a) => a.subtype !== 'receivable' && a.subtype !== 'payable'}
              autoFocus
            />
          </Field>
          <Field label={t('common.description')}>
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          {cc.on && pl && (
            <Field label={t('co.costCenter')}>
              <CostCenterSelect value={f.costCenterId} onChange={(v) => setF({ ...f, costCenterId: v })} list={cc.list} />
            </Field>
          )}
          {err && <p className="danger-text">{err}</p>}
        </div>
      )}
    </Dialog>
  );
}

function AddLinesDialog({ statementId, open, onClose }: { statementId: number; open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [mode, setMode] = useState<'one' | 'file'>('one');
  const [one, setOne] = useState({ date: todayIso(), description: '', reference: '', amount: null as number | null });
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) setErr(''), setOne({ date: todayIso(), description: '', reference: '', amount: null });
  }, [open]);
  const body = mode === 'one' ? [{ ...one, reference: one.reference || null }] : lines;
  const save = useApiMutation(() => api.post(`/bank/statements/${statementId}/lines`, { lines: body }));
  const ready = mode === 'one' ? !!one.description.trim() && !!one.amount : lines.length > 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide={mode === 'file'}
      title={t('bank.addLines')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="segmented" role="group">
          <button aria-pressed={mode === 'one'} onClick={() => setMode('one')}>
            {t('bank.oneLine')}
          </button>
          <button aria-pressed={mode === 'file'} onClick={() => setMode('file')}>
            {t('bank.fromFile')}
          </button>
        </div>
        {mode === 'one' ? (
          <div className="grid-2">
            <Field label={t('common.date')}>
              <Input type="date" value={one.date} onChange={(e) => setOne({ ...one, date: e.target.value })} />
            </Field>
            <Field label={t('bank.amountSigned')} hint={t('bank.amountSignedHint')}>
              <DecimalInput scale={scale} value={one.amount} onChange={(v) => setOne({ ...one, amount: v })} />
            </Field>
            <Field label={t('common.description')}>
              <Input value={one.description} onChange={(e) => setOne({ ...one, description: e.target.value })} autoFocus />
            </Field>
            <Field label={t('common.reference')}>
              <Input value={one.reference} onChange={(e) => setOne({ ...one, reference: e.target.value })} />
            </Field>
          </div>
        ) : (
          <ImportPanel onLines={setLines} />
        )}
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------ the workspace

export function StatementPage() {
  const { id } = useParams();
  const { t, pick, locale } = useI18n();
  const { can } = useSession();
  const { fmt } = useMoney();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const { data: s, isLoading } = useApi<StatementFull>(`/bank/statements/${id}`);
  const [selected, setSelected] = useState<number | null>(null);
  const [entryFor, setEntryFor] = useState<SLine | null>(null);
  const [adding, setAdding] = useState(false);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const run = (fn: () => Promise<unknown>, msg?: string | ((r: any) => string), after?: () => void) =>
    act.mutate(fn, { onSuccess: (r) => (msg && toast.success(typeof msg === 'function' ? msg(r) : msg), after?.()), onError: (e) => toast.error(errText(e)) });

  if (isLoading || !s) return <Loading />;
  const open = s.status === 'open';
  const writable = open && can('treasury.statements.write');
  const sel = s.lines.find((l) => l.id === selected) ?? null;
  // Book lines with the selected amount first, then by closeness of date.
  const book = sel
    ? [...s.book].sort((a, b) => Number(b.amount === sel.amount) - Number(a.amount === sel.amount) || Math.abs(Date.parse(a.date) - Date.parse(sel.date)) - Math.abs(Date.parse(b.date) - Date.parse(sel.date)))
    : s.book;
  const sum = s.summary;
  const done = sum.unmatched === 0 && sum.difference === 0 && sum.lines > 0;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/bank', label: t('bank.title') }]}
        title={`${s.account.code} · ${pick(s.account.name_en, s.account.name_ar)}`}
        subtitle={`${t('bank.statementDate')}: ${formatDate(s.date, locale, 'long')}${s.reference ? ' · ' + s.reference : ''}`}
        badge={open ? <Badge tone="amber">{t('bank.status.open')}</Badge> : <Badge tone="green">{t('bank.status.reconciled')}</Badge>}
        actions={
          <>
            {writable && (
              <>
                <Button
                  variant="ghost"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('bank.deleteStatement'), body: t('bank.deleteStatementText'), danger: true, confirmLabel: t('common.delete') })).ok)
                      run(() => api.del(`/bank/statements/${s.id}`), t('common.deleted'), () => navigate('/bank'));
                  }}
                />
                <Button icon={<Plus />} onClick={() => setAdding(true)}>
                  {t('bank.addLines')}
                </Button>
                <Button icon={<Wand2 />} onClick={() => run(() => api.post<{ matched: number }>(`/bank/statements/${s.id}/auto-match`), (r) => t('bank.autoMatched', { n: r.matched }))}>
                  {t('bank.autoMatch')}
                </Button>
              </>
            )}
            {open && can('treasury.statements.post') && (
              <Button variant="primary" icon={<CheckCircle2 />} disabled={!done} onClick={() => run(() => api.post(`/bank/statements/${s.id}/reconcile`), t('bank.reconciledDone'))}>
                {t('bank.finish')}
              </Button>
            )}
            {!open && can('treasury.statements.post') && <Button onClick={() => run(() => api.post(`/bank/statements/${s.id}/reopen`), t('common.saved'))}>{t('bank.reopen')}</Button>}
          </>
        }
      />

      <div className="recon-summary">
        <div>
          <span>{t('bank.opening')}</span>
          <strong className="amount">{fmt(s.opening_balance)}</strong>
        </div>
        <div>
          <span>{t('bank.movements', { n: sum.lines })}</span>
          <strong className="amount">{fmt(sum.linesTotal, { signed: true })}</strong>
        </div>
        <div>
          <span>{t('bank.closing')}</span>
          <strong className="amount">{fmt(s.closing_balance)}</strong>
        </div>
        <div className={sum.difference ? 'bad' : 'good'}>
          <span>{t('bank.difference')}</span>
          <strong className="amount">{fmt(sum.difference)}</strong>
        </div>
        <div className={sum.unmatched ? 'bad' : 'good'}>
          <span>{t('bank.toMatch')}</span>
          <strong>{sum.unmatched}</strong>
        </div>
        <div title={t('bank.inTransitHint')}>
          <span>{t('bank.inTransit')}</span>
          <strong className="amount">{fmt(sum.unclearedTotal)}</strong>
        </div>
        <div className={open || sum.bookBalance === s.closing_balance + sum.unclearedTotal ? '' : 'bad'}>
          <span>{t('bank.bookBalance')}</span>
          <strong className="amount">{fmt(sum.bookBalance)}</strong>
        </div>
      </div>
      {open && !done && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <AlertTriangle />
          <div>{sum.difference ? t('bank.hintDifference') : sum.lines === 0 ? t('bank.hintEmpty') : t('bank.hintMatch')}</div>
        </div>
      )}

      <div className="recon-grid">
        <Card>
          <CardHeader title={t('bank.statementLines')} sub={writable ? t('bank.statementLinesSub') : undefined} icon={<Landmark size={18} className="muted" />} />
          <div className="table-wrap">
            <table className="table table-compact">
              <tbody>
                {s.lines.map((l) => (
                  <tr key={l.id} className={`${l.journal_line_id ? 'matched' : writable ? 'clickable' : ''} ${selected === l.id ? 'selected' : ''}`} onClick={() => writable && !l.journal_line_id && setSelected(selected === l.id ? null : l.id)}>
                    <td className="nowrap faint">{formatDate(l.date, locale)}</td>
                    <td>
                      <div>{l.description}</div>
                      {l.reference && <div className="faint" style={{ fontSize: 12 }}>{l.reference}</div>}
                    </td>
                    <td className="end nowrap">
                      <Money v={l.amount} tone />
                    </td>
                    <td className="shrink nowrap" onClick={(e) => e.stopPropagation()}>
                      {l.journal_line_id ? (
                        <span className="row" style={{ gap: 4 }}>
                          <Link to={`/journal/${l.entry_id}`} className="badge badge-green plain">
                            <Link2 size={12} /> {l.entry_number}
                          </Link>
                          {writable && <Button size="sm" variant="ghost" iconOnly icon={<Unlink />} title={t('bank.unmatch')} onClick={() => run(() => api.post(`/bank/statement-lines/${l.id}/unmatch`))} />}
                        </span>
                      ) : (
                        writable && (
                          <span className="row" style={{ gap: 2 }}>
                            {can('gl.journal.post') && (
                              <Button size="sm" variant="ghost" onClick={() => setEntryFor(l)}>
                                {t('bank.record')}
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} title={t('common.remove')} onClick={() => run(() => api.del(`/bank/statement-lines/${l.id}`))} />
                          </span>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.lines.length === 0 && <EmptyState icon={<FileUp size={22} />} title={t('bank.noLines')} text={t('bank.noLinesText')} />}
          </div>
        </Card>

        {open && (
          <Card>
            <CardHeader title={t('bank.bookLines')} sub={sel ? t('bank.pickFor', { amount: fmt(sel.amount) }) : t('bank.bookLinesSub', { total: fmt(sum.unclearedTotal) })} icon={<Wallet size={18} className="muted" />} />
            <div className="table-wrap">
              <table className="table table-compact">
                <tbody>
                  {book.map((b) => {
                    const fits = sel && b.amount === sel.amount;
                    return (
                      <tr key={b.id} className={`${sel ? (fits ? 'clickable fits' : 'dim') : ''}`} onClick={() => fits && run(() => api.post(`/bank/statement-lines/${sel!.id}/match`, { journalLineId: b.id }), t('bank.matched'), () => setSelected(null))}>
                        <td className="nowrap faint">{formatDate(b.date, locale)}</td>
                        <td>
                          <div>{b.memo || b.description || t('journal.sources.' + b.source_type)}</div>
                          <div className="faint" style={{ fontSize: 12 }}>
                            {b.number} {b.reference && `· ${b.reference}`}
                          </div>
                        </td>
                        <td className="end nowrap">
                          <Money v={b.amount} tone />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {book.length === 0 && <EmptyState icon={<CheckCircle2 size={22} />} title={t('bank.bookClear')} />}
            </div>
          </Card>
        )}
      </div>
      <EntryDialog line={entryFor} onClose={() => setEntryFor(null)} />
      <AddLinesDialog statementId={s.id} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
