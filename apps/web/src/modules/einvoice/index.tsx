import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ban, CheckCircle2, ExternalLink, FileCheck2, ListPlus, PlugZap, RefreshCw, Save, Send, Settings2, SkipForward } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api, ApiError } from '../../core/api';
import { DOC_BASE } from '../../core/links';
import type { DocKind } from '../../core/types';
import { formatDate, formatDateTime, todayIso } from '../../core/format';
import { EmptyState, Loading, PageHeader } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Field, Input, Select } from '../../ui/Field';
import { Switch } from '../../ui/Switch';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column } from '../../ui/DataGrid';

type Status = 'pending' | 'submitted' | 'valid' | 'invalid' | 'rejected' | 'cancel_requested' | 'cancelled' | 'skipped';
interface Problem {
  code: string;
  message: string;
  values?: Record<string, string | number>;
}
interface Row {
  document_id: number;
  status: Status;
  uuid: string | null;
  long_id: string | null;
  problems: Problem[];
  attempts: number;
  submitted_at: string | null;
  checked_at: string | null;
  number: string;
  kind: DocKind;
  date: string;
  total: number;
  currency: string;
  party_name: string;
}
interface Settings {
  enabled: boolean;
  environment: 'preprod' | 'prod' | 'custom';
  apiUrl: string | null;
  idUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  version: '1.0' | '0.9';
  signerUrl: string | null;
  rin: string | null;
  issuerName: string | null;
  branchId: string;
  activityCode: string | null;
  governate: string | null;
  regionCity: string | null;
  street: string | null;
  buildingNumber: string | null;
  defaultCodeType: 'EGS' | 'GS1';
  defaultItemCode: string | null;
  defaultUnitType: string;
  untaxedSubType: string;
  hasSecret?: boolean;
  problems?: Problem[];
}
type SendResult = { results: { documentId: number; status: string; message?: string }[] };

const TONE: Record<Status, Tone> = { pending: 'amber', submitted: 'blue', valid: 'green', invalid: 'red', rejected: 'red', cancel_requested: 'amber', cancelled: 'neutral', skipped: 'neutral' };
const RESENDABLE: Status[] = ['pending', 'invalid', 'rejected'];

/** A problem in the reader's language: errors.<code> when translated, else the ETA's own words. */
function useProblemText() {
  const { t, has } = useI18n();
  return (p: Problem) => {
    if (p.code === 'einvoice.p.setting' && p.values?.field) return t('errors.einvoice.p.setting', { field: t('ei.f.' + p.values.field) });
    return has('errors.' + p.code) && p.code !== 'einvoice.p.eta' ? t('errors.' + p.code, p.values) : p.message;
  };
}

function useSendToast() {
  const { t } = useI18n();
  const toast = useToast();
  return (r: SendResult) => {
    const ok = r.results.filter((x) => x.status === 'submitted' || x.status === 'valid').length;
    const bad = r.results.filter((x) => !['submitted', 'valid', 'cancelled', 'cancel_requested'].includes(x.status));
    if (!r.results.length) toast.success(t('ei.nothing'));
    else if (!bad.length) toast.success(t('ei.sentOk', { n: ok }));
    else toast.error(t('ei.sentSome', { n: ok, bad: bad.length }));
  };
}

// ------------------------------------------------------------------ queue

function QueuePage() {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const problemText = useProblemText();
  const sentToast = useSendToast();
  const [status, setStatus] = useState<'all' | Status>('all');
  const [queueFrom, setQueueFrom] = useState<string | null>(null);
  const { data, isLoading } = useApi<{ rows: Row[]; counts: Partial<Record<Status, number>>; enabled: boolean }>('/einvoice/documents', { status });
  const submit = useApiMutation(() => api.post<SendResult>('/einvoice/submit', {}));
  const refresh = useApiMutation(() => api.post<SendResult>('/einvoice/refresh', {}));
  const queue = useApiMutation((from: string) => api.post<{ queued: number }>('/einvoice/queue', { from }));
  const counts = data?.counts ?? {};
  const columns = useMemo<Column<Row>[]>(
    () => [
      { id: 'number', header: t('common.number'), pinned: true, value: (r) => r.number, render: (r) => <strong className="num">{r.number}</strong> },
      { id: 'kind', header: t('ei.kind'), type: 'enum', value: (r) => r.kind, format: (v) => t('ei.kinds.' + v) },
      { id: 'date', header: t('common.date'), type: 'date', value: (r) => r.date, render: (r) => formatDate(r.date, locale) },
      { id: 'party', header: t('ei.customer'), value: (r) => r.party_name },
      { id: 'total', header: t('common.total'), type: 'number', value: (r) => r.total, render: (r) => <span className="num">{fmt(r.total)}</span> },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('ei.status.' + v), render: (r) => <Badge tone={TONE[r.status]}>{t('ei.status.' + r.status)}</Badge> },
      { id: 'problem', header: t('ei.problem'), value: (r) => (r.problems[0] ? problemText(r.problems[0]) : ''), render: (r) => (r.problems[0] ? <span className="danger-text" style={{ fontSize: 13 }}>{problemText(r.problems[0])}{r.problems.length > 1 ? ` (+${r.problems.length - 1})` : ''}</span> : null) },
    ],
    [t, locale, fmt, problemText],
  );
  const onErr = (e: ApiError) => toast.error(errText(e));
  return (
    <div className="page">
      <PageHeader
        title={t('ei.title')}
        subtitle={t('ei.subtitle')}
        actions={
          <>
            {can('einvoice.settings.manage') && (
              <Link to="/einvoice/settings" className="btn">
                <Settings2 /> {t('ei.settings')}
              </Link>
            )}
            {can('einvoice.documents.post') && (
              <>
                <Button icon={<ListPlus />} onClick={() => setQueueFrom(todayIso().slice(0, 8) + '01')}>
                  {t('ei.queueOld')}
                </Button>
                <Button icon={<RefreshCw />} loading={refresh.isPending} disabled={!data?.enabled} onClick={() => refresh.mutate(undefined, { onSuccess: sentToast, onError: onErr })}>
                  {t('ei.refresh')}
                </Button>
                <Button variant="primary" icon={<Send />} loading={submit.isPending} disabled={!data?.enabled || !(counts.pending || counts.invalid || counts.rejected)} onClick={() => submit.mutate(undefined, { onSuccess: sentToast, onError: onErr })}>
                  {t('ei.sendAll', { n: (counts.pending ?? 0) + (counts.invalid ?? 0) + (counts.rejected ?? 0) })}
                </Button>
              </>
            )}
          </>
        }
      />
      {data && !data.enabled && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          {t('ei.offNotice')}{' '}
          {can('einvoice.settings.manage') && <Link to="/einvoice/settings">{t('ei.settings')}</Link>}
        </div>
      )}
      <div className="segmented" style={{ marginBottom: 12 }}>
        {(['all', 'pending', 'submitted', 'valid', 'invalid', 'rejected', 'cancelled'] as const).map((s) => (
          <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s === 'all' ? t('common.all') : t('ei.status.' + s)}
            {s !== 'all' && counts[s] ? <span className="faint"> · {counts[s]}</span> : null}
          </button>
        ))}
      </div>
      <DataGrid
        id="einvoice"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        rowKey={(r) => r.document_id}
        onRowClick={(r) => navigate(`${DOC_BASE[r.kind]}/${r.document_id}`)}
        exportName={t('ei.title')}
        empty={<EmptyState icon={<FileCheck2 size={22} />} title={t('ei.none')} text={t('ei.noneText')} />}
      />
      <Dialog
        open={queueFrom != null}
        onClose={() => setQueueFrom(null)}
        title={t('ei.queueOld')}
        footer={
          <>
            <Button onClick={() => setQueueFrom(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={queue.isPending}
              onClick={() => queue.mutate(queueFrom!, { onSuccess: (r) => (toast.success(t('ei.queued', { n: r.queued })), setQueueFrom(null)), onError: onErr })}
            >
              {t('ei.queue')}
            </Button>
          </>
        }
      >
        <Field label={t('ei.queueFrom')} hint={t('ei.queueHint')}>
          <Input type="date" value={queueFrom ?? ''} onChange={(e) => setQueueFrom(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ settings + codes

function SettingsPage() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const problemText = useProblemText();
  const { data, isLoading } = useApi<Settings>('/einvoice/settings');
  const { data: codes } = useApi<{
    items: { id: number; sku: string; name_en: string; name_ar: string; code_type: string | null; item_code: string | null; unit_type: string | null }[];
    taxes: { id: number; code: string; name_en: string; name_ar: string; rate_bp: number; tax_type: string | null; sub_type: string | null }[];
  }>('/einvoice/codes');
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (data) setS({ ...data, clientSecret: '' });
  }, [data]);
  const save = useApiMutation(() => api.put('/einvoice/settings', s));
  const test = useApiMutation(() => api.post<{ ok: boolean; message?: string }>('/einvoice/test'));
  const saveItem = useApiMutation((v: { id: number; body: unknown }) => api.put(`/einvoice/codes/items/${v.id}`, v.body));
  const saveTax = useApiMutation((v: { id: number; body: unknown }) => api.put(`/einvoice/codes/taxes/${v.id}`, v.body));
  if (isLoading || !s) return <Loading />;
  const text = (k: keyof Settings, hint?: string, type = 'text') => (
    <Field label={t('ei.f.' + k)} hint={hint}>
      <Input type={type} value={(s[k] as string | null) ?? ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
    </Field>
  );
  const onSaved = { onSuccess: () => toast.success(t('ei.saved')), onError: (e: ApiError) => toast.error(errText(e)) };
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/einvoice', label: t('ei.title') }]}
        title={t('ei.settings')}
        subtitle={t('ei.settingsSub')}
        actions={
          <>
            <Button icon={<PlugZap />} loading={test.isPending} onClick={() => test.mutate(undefined, { onSuccess: (r) => (r.ok ? toast.success(t('ei.testOk')) : toast.error(t('ei.testFailed', { message: r.message ?? '' }))), onError: (e) => toast.error(errText(e)) })}>
              {t('ei.test')}
            </Button>
            <Button variant="primary" icon={<Save />} loading={save.isPending} onClick={() => save.mutate(undefined, onSaved)}>
              {t('common.save')}
            </Button>
          </>
        }
      />
      {!!data?.problems?.length && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <div>
            <strong>{t('ei.notReady')}</strong>
            <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
              {data.problems.map((p, i) => (
                <li key={i}>{problemText(p)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <Card>
        <CardHeader title={t('ei.connection')} />
        <div className="card-body">
        <div className="stack">
          <div className="grid-3">
            <Field label={t('ei.f.enabled')} hint={t('ei.enabledHint')}>
              <Switch checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} />
            </Field>
            <Field label={t('ei.f.environment')}>
              <Select value={s.environment} onChange={(e) => setS({ ...s, environment: e.target.value as Settings['environment'] })}>
                {(['preprod', 'prod', 'custom'] as const).map((x) => (
                  <option key={x} value={x}>
                    {t('ei.env.' + x)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('ei.f.version')} hint={t('ei.versionHint')}>
              <Select value={s.version} onChange={(e) => setS({ ...s, version: e.target.value as Settings['version'] })}>
                <option value="1.0">1.0 — {t('ei.signed')}</option>
                <option value="0.9">0.9 — {t('ei.unsigned')}</option>
              </Select>
            </Field>
          </div>
          {s.environment === 'custom' && (
            <div className="grid-2">
              {text('apiUrl')}
              {text('idUrl')}
            </div>
          )}
          <div className="grid-3">
            {text('clientId')}
            <Field label={t('ei.f.clientSecret')} hint={data?.hasSecret ? t('ei.secretKept') : undefined}>
              <Input type="password" autoComplete="new-password" value={s.clientSecret ?? ''} onChange={(e) => setS({ ...s, clientSecret: e.target.value })} />
            </Field>
            {text('signerUrl', t('ei.signerHint'))}
          </div>
        </div>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('ei.issuer')} sub={t('ei.issuerSub')} />
        <div className="card-body">
        <div className="stack">
          <div className="grid-3">
            {text('rin', t('ei.rinHint'))}
            {text('issuerName')}
            {text('activityCode', t('ei.activityHint'))}
          </div>
          <div className="grid-3">
            {text('governate')}
            {text('regionCity')}
            {text('street')}
          </div>
          <div className="grid-3">
            {text('buildingNumber')}
            {text('branchId', t('ei.branchHint'))}
          </div>
        </div>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('ei.defaults')} sub={t('ei.defaultsSub')} />
        <div className="card-body">
        <div className="grid-4">
          <Field label={t('ei.f.defaultCodeType')}>
            <Select value={s.defaultCodeType} onChange={(e) => setS({ ...s, defaultCodeType: e.target.value as 'EGS' | 'GS1' })}>
              <option value="EGS">EGS</option>
              <option value="GS1">GS1</option>
            </Select>
          </Field>
          {text('defaultItemCode', t('ei.defaultItemHint'))}
          {text('defaultUnitType', t('ei.unitHint'))}
          {text('untaxedSubType', t('ei.untaxedHint'))}
        </div>
        </div>
      </Card>

      <Card className="table-card">
        <CardHeader title={t('ei.itemCodes')} sub={t('ei.itemCodesSub')} />
        {!codes?.items.length ? (
          <EmptyState title={t('ei.noItems')} />
        ) : (
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('ei.item')}</th>
                  <th style={{ width: 110 }}>{t('ei.f.defaultCodeType')}</th>
                  <th style={{ width: 240 }}>{t('ei.itemCode')}</th>
                  <th style={{ width: 110 }}>{t('ei.unit')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {codes.items.map((i) => (
                  <CodeRow key={i.id} label={`${i.sku} · ${pick(i.name_en, i.name_ar)}`} codeType={i.code_type} code={i.item_code} unit={i.unit_type} onSave={(body) => saveItem.mutate({ id: i.id, body }, onSaved)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card className="table-card">
        <CardHeader title={t('ei.taxCodes')} sub={t('ei.taxCodesSub')} />
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t('ei.tax')}</th>
              <th style={{ width: 140 }}>{t('ei.taxType')}</th>
              <th style={{ width: 140 }}>{t('ei.subType')}</th>
              <th className="shrink" />
            </tr>
          </thead>
          <tbody>
            {(codes?.taxes ?? []).map((x) => (
              <TaxRow key={x.id} label={`${x.code} · ${pick(x.name_en, x.name_ar)} (${x.rate_bp / 100}%)`} taxType={x.tax_type ?? (x.rate_bp === 1400 ? 'T1' : '')} subType={x.sub_type ?? (x.rate_bp === 1400 ? 'V009' : '')} onSave={(body) => saveTax.mutate({ id: x.id, body }, onSaved)} />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function CodeRow({ label, codeType, code, unit, onSave }: { label: string; codeType: string | null; code: string | null; unit: string | null; onSave(body: unknown): void }) {
  const { t } = useI18n();
  const [v, setV] = useState({ codeType: codeType ?? 'EGS', itemCode: code ?? '', unitType: unit ?? '' });
  const dirty = v.codeType !== (codeType ?? 'EGS') || v.itemCode !== (code ?? '') || v.unitType !== (unit ?? '');
  return (
    <tr>
      <td>{label}</td>
      <td>
        <Select className="input-sm" value={v.codeType} onChange={(e) => setV({ ...v, codeType: e.target.value })}>
          <option value="EGS">EGS</option>
          <option value="GS1">GS1</option>
        </Select>
      </td>
      <td>
        <Input sm value={v.itemCode} placeholder="EG-123456789-1001" onChange={(e) => setV({ ...v, itemCode: e.target.value })} />
      </td>
      <td>
        <Input sm value={v.unitType} placeholder="EA" onChange={(e) => setV({ ...v, unitType: e.target.value })} />
      </td>
      <td>
        <Button size="sm" disabled={!dirty} onClick={() => onSave(v.itemCode.trim() ? { ...v, unitType: v.unitType || null } : null)}>
          {t('common.save')}
        </Button>
      </td>
    </tr>
  );
}

function TaxRow({ label, taxType, subType, onSave }: { label: string; taxType: string; subType: string; onSave(body: unknown): void }) {
  const { t } = useI18n();
  const [v, setV] = useState({ taxType, subType });
  return (
    <tr>
      <td>{label}</td>
      <td>
        <Input sm value={v.taxType} placeholder="T1" onChange={(e) => setV({ ...v, taxType: e.target.value.toUpperCase() })} />
      </td>
      <td>
        <Input sm value={v.subType} placeholder="V009" onChange={(e) => setV({ ...v, subType: e.target.value.toUpperCase() })} />
      </td>
      <td>
        <Button size="sm" onClick={() => onSave(v.taxType && v.subType ? v : null)}>
          {t('common.save')}
        </Button>
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------ on the invoice

function InvoicePanel({ documentId, kind, status }: { documentId: number; kind: string; status: string }) {
  const { t, locale } = useI18n();
  const { can, hasApp } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const problemText = useProblemText();
  const sentToast = useSendToast();
  const on = hasApp('einvoice') && can('einvoice.documents.read') && (kind === 'sales_invoice' || kind === 'sales_credit') && status !== 'draft';
  const { data } = useApi<{ eligible: boolean; enabled: boolean; row: Row | null; problems: Problem[]; link: string | null }>(on ? `/einvoice/documents/${documentId}` : null);
  const submit = useApiMutation(() => api.post<SendResult>('/einvoice/submit', { documentIds: [documentId] }));
  const refresh = useApiMutation(() => api.post<SendResult>('/einvoice/refresh', { documentIds: [documentId] }));
  const cancel = useApiMutation((reason: string) => api.post(`/einvoice/documents/${documentId}/cancel`, { reason }));
  const skip = useApiMutation(() => api.post(`/einvoice/documents/${documentId}/skip`, {}));
  const [reason, setReason] = useState<string | null>(null);
  if (!on || !data || (!data.row && !data.enabled)) return null;
  const row = data.row;
  const problems = row && RESENDABLE.includes(row.status) ? [...data.problems, ...row.problems.filter((p) => !data.problems.some((q) => q.message === p.message))] : [];
  const post = can('einvoice.documents.post');
  const onErr = (e: ApiError) => toast.error(errText(e));
  return (
    <Card className="no-print">
      <CardHeader
        title={t('ei.panel')}
        icon={<FileCheck2 size={18} className="muted" />}
        actions={
          <span className="row" style={{ gap: 8 }}>
            {row ? <Badge tone={TONE[row.status]}>{t('ei.status.' + row.status)}</Badge> : <Badge>{t('ei.notQueued')}</Badge>}
            {data.link && (
              <a href={data.link} target="_blank" rel="noreferrer" className="btn btn-sm">
                <ExternalLink /> {t('ei.openEta')}
              </a>
            )}
            {post && row && RESENDABLE.includes(row.status) && (
              <>
                <Button size="sm" icon={<SkipForward />} loading={skip.isPending} onClick={() => skip.mutate(undefined, { onSuccess: () => toast.success(t('ei.skipped')), onError: onErr })}>
                  {t('ei.skip')}
                </Button>
                <Button size="sm" variant="primary" icon={<Send />} loading={submit.isPending} disabled={!data.enabled} onClick={() => submit.mutate(undefined, { onSuccess: sentToast, onError: onErr })}>
                  {t('ei.send')}
                </Button>
              </>
            )}
            {post && row && (row.status === 'submitted' || row.status === 'cancel_requested') && (
              <Button size="sm" icon={<RefreshCw />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: sentToast, onError: onErr })}>
                {t('ei.refresh')}
              </Button>
            )}
            {post && row && (row.status === 'valid' || row.status === 'submitted') && (
              <Button size="sm" variant="danger" icon={<Ban />} onClick={() => setReason('')}>
                {t('ei.cancel')}
              </Button>
            )}
          </span>
        }
      />
      <div style={{ padding: '0 16px 14px' }}>
        {row?.status === 'valid' && (
          <p className="success-text row" style={{ gap: 6, margin: 0 }}>
            <CheckCircle2 size={16} /> {t('ei.validText', { date: formatDateTime(row.checked_at ?? row.submitted_at, locale) })}
          </p>
        )}
        {row?.uuid && (
          <p className="faint mono" style={{ fontSize: 12, margin: '4px 0 0' }}>
            UUID: {row.uuid}
          </p>
        )}
        {status === 'void' && row && (row.status === 'valid' || row.status === 'submitted') && <div className="notice warn">{t('ei.voidedValid')}</div>}
        {!!problems.length && (
          <ul className="danger-text" style={{ margin: 0, paddingInlineStart: 18, fontSize: 13.5 }}>
            {problems.map((p, i) => (
              <li key={i}>{problemText(p)}</li>
            ))}
          </ul>
        )}
      </div>
      <Dialog
        open={reason != null}
        onClose={() => setReason(null)}
        title={t('ei.cancelTitle')}
        footer={
          <>
            <Button onClick={() => setReason(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={cancel.isPending} disabled={(reason ?? '').trim().length < 3} onClick={() => cancel.mutate(reason!, { onSuccess: () => (toast.success(t('ei.cancelAsked')), setReason(null)), onError: onErr })}>
              {t('ei.cancel')}
            </Button>
          </>
        }
      >
        <Field label={t('ei.reason')} hint={t('ei.cancelHint')}>
          <Input value={reason ?? ''} autoFocus onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </Card>
  );
}

export const einvoiceModule: WebModule = {
  id: 'einvoice',
  nav: [{ to: '/einvoice', label: 'ei.title', icon: FileCheck2, section: 'tax', order: 30, perm: 'einvoice.documents.read', app: 'einvoice' }],
  routes: [
    { path: '/einvoice', element: <QueuePage /> },
    { path: '/einvoice/settings', element: <SettingsPage />, perm: 'einvoice.settings.manage', app: 'einvoice' },
  ],
  commands: [{ id: 'go-einvoice', label: 'ei.title', icon: FileCheck2, group: 'navigate', to: '/einvoice', perm: 'einvoice.documents.read', app: 'einvoice', keywords: 'e-invoice eta tax authority فاتورة إلكترونية مصلحة الضرائب' }],
  slots: { 'document.view': InvoicePanel },
};
