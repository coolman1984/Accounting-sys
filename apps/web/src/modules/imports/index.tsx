import { useRef, useState } from 'react';
import { BookOpen, Boxes, CheckCircle2, Download, FileSpreadsheet, Scale, Upload, Users } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api, ApiError } from '../../core/api';
import { formatBytes } from '../../core/format';
import { PageHeader } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Field, Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';

type Dataset = 'accounts' | 'parties' | 'items' | 'opening';
interface Col {
  key: string;
  en: string;
  ar: string;
  required: boolean;
  type: string;
}
interface RowError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
interface Result {
  dataset: Dataset;
  committed: boolean;
  counts: { new: number; exists: number; errors: number };
  problem: RowError | null;
  rows: { row: number; values: Record<string, string | number | boolean | null>; status: 'new' | 'exists' | 'error'; error: RowError | null }[];
}

const ICONS = { accounts: BookOpen, parties: Users, items: Boxes, opening: Scale } as const;
const TONE: Record<string, Tone> = { new: 'green', exists: 'neutral', error: 'red' };
/** The bytes of a file as base64 (the server takes JSON). */
const toBase64 = (file: File) =>
  new Promise<string>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(file);
  });
const MAX_BYTES = 3_500_000;

function ImportPage() {
  const { t, locale, pick } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const { fmt } = useMoney();
  const { data: sets } = useApi<{ id: Dataset; columns: Col[] }[]>('/imports/datasets');
  const [dataset, setDataset] = useState<Dataset>('parties');
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const cols = sets?.find((s) => s.id === dataset)?.columns ?? [];
  const label = (key: string) => {
    const c = cols.find((x) => x.key === key);
    return c ? pick(c.en, c.ar) : key;
  };
  /** A row problem in the reader's language (the column named in their language too). */
  const problemText = (e: RowError) => {
    const d = { ...(e.details ?? {}) };
    if (typeof d.column === 'string') d.column = label(d.column);
    return errText(new ApiError(e.code, e.message, 400, d));
  };

  const send = useApiMutation(async (commit: boolean) => {
    const body = { dataset, file: await toBase64(file!), date: date || null };
    return api.post<Result>(commit ? '/imports/commit' : '/imports/preview', body);
  });
  const run = (commit: boolean) =>
    send.mutate(commit, {
      onSuccess: (r) => {
        setResult(r);
        if (r.committed) toast.success(t('imp.done', { n: r.counts.new }));
      },
      onError: (e) => toast.error(errText(e)),
    });
  const pickFile = (f: File | null) => {
    setResult(null);
    if (f && f.size > MAX_BYTES) {
      toast.error(t('imp.tooBig', { size: formatBytes(MAX_BYTES) }));
      return;
    }
    setFile(f);
  };
  const shown = cols.filter((c) => result?.rows.some((r) => r.values[c.key] != null)).slice(0, 6);
  const canCommit = !!result && !result.committed && !result.counts.errors && !result.problem && result.counts.new > 0;

  return (
    <div className="page">
      <PageHeader title={t('imp.title')} subtitle={t('imp.subtitle')} />
      <div className="grid-4" style={{ marginBottom: 16 }}>
        {(['parties', 'items', 'accounts', 'opening'] as Dataset[]).map((d) => {
          const Icon = ICONS[d];
          return (
            <button
              key={d}
              type="button"
              className="card card-pad choice-card"
              aria-pressed={dataset === d}
              onClick={() => (setDataset(d), setResult(null))}
            >
              <div className="row" style={{ gap: 10 }}>
                <Icon size={20} className="muted" />
                <strong>{t('imp.sets.' + d)}</strong>
              </div>
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>
                {t('imp.setsHint.' + d)}
              </p>
            </button>
          );
        })}
      </div>

      <Card pad>
        <div className="stack">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <span className="step-no">1</span>
            <span>{t('imp.step1')}</span>
            <a className="btn btn-sm" href={`/api/imports/template/${dataset}?lang=${locale}`} download>
              <Download /> {t('imp.template')}
            </a>
          </div>
          <div className="faint" style={{ fontSize: 13 }}>
            {t('imp.columns')}: {cols.map((c) => pick(c.en, c.ar) + (c.required ? ' *' : '')).join(' · ')}
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <span className="step-no">2</span>
            <input ref={input} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <Button icon={<Upload />} onClick={() => input.current?.click()}>
              {file ? t('imp.otherFile') : t('imp.chooseFile')}
            </Button>
            {file && (
              <span className="row" style={{ gap: 6 }}>
                <FileSpreadsheet size={16} className="muted" />
                <strong>{file.name}</strong>
                <span className="faint">{formatBytes(file.size)}</span>
              </span>
            )}
            {dataset === 'opening' && (
              <Field label={t('imp.openingDate')} hint={t('imp.openingDateHint')}>
                <Input type="date" value={date} onChange={(e) => (setDate(e.target.value), setResult(null))} />
              </Field>
            )}
          </div>
          <div className="row" style={{ gap: 12 }}>
            <span className="step-no">3</span>
            <Button variant="primary" icon={<CheckCircle2 />} disabled={!file} loading={send.isPending && !result} onClick={() => run(false)}>
              {t('imp.check')}
            </Button>
            {can('imports.data.write') && (
              <Button variant="primary" icon={<Upload />} disabled={!canCommit} loading={send.isPending && !!result} onClick={() => run(true)}>
                {t('imp.import', { n: result?.counts.new ?? 0 })}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {result && (
        <Card className="table-card">
          <CardHeader
            title={result.committed ? t('imp.imported') : t('imp.preview')}
            sub={t('imp.counts', { new: result.counts.new, exists: result.counts.exists, errors: result.counts.errors })}
          />
          {result.problem && (
            <div className="notice danger" style={{ margin: '0 16px 12px' }}>
              {problemText(result.problem)}
            </div>
          )}
          {!!result.counts.errors && (
            <div className="notice warn" style={{ margin: '0 16px 12px' }}>
              {t('imp.fixAndRetry')}
            </div>
          )}
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th className="shrink">{t('imp.row')}</th>
                  <th className="shrink">{t('common.status')}</th>
                  {shown.map((c) => (
                    <th key={c.key}>{pick(c.en, c.ar)}</th>
                  ))}
                  <th>{t('imp.problem')}</th>
                </tr>
              </thead>
              <tbody>
                {[...result.rows]
                  .sort((a, b) => Number(b.status === 'error') - Number(a.status === 'error') || a.row - b.row)
                  .slice(0, 500)
                  .map((r) => (
                    <tr key={r.row}>
                      <td className="num faint">{r.row}</td>
                      <td>
                        <Badge plain tone={TONE[r.status]}>
                          {t('imp.status.' + r.status)}
                        </Badge>
                      </td>
                      {shown.map((c) => (
                        <td key={c.key} className={c.type === 'money' || c.type === 'int' ? 'num' : undefined}>
                          {r.values[c.key] == null ? '' : typeof r.values[c.key] === 'boolean' ? t(r.values[c.key] ? 'common.yes' : 'common.no') : c.type === 'money' ? fmt(Number(r.values[c.key])) : String(r.values[c.key])}
                        </td>
                      ))}
                      <td className="danger-text" style={{ fontSize: 13 }}>
                        {r.error ? problemText(r.error) : ''}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {result.rows.length > 500 && <p className="faint" style={{ padding: '8px 16px' }}>{t('imp.firstRows', { n: 500 })}</p>}
        </Card>
      )}
    </div>
  );
}

export const importsModule: WebModule = {
  id: 'imports',
  nav: [{ to: '/import', label: 'imp.title', icon: FileSpreadsheet, section: 'admin', order: 50, perm: 'imports.data.write', app: 'imports' }],
  routes: [{ path: '/import', element: <ImportPage /> }],
  commands: [{ id: 'go-import', label: 'imp.title', icon: FileSpreadsheet, group: 'navigate', to: '/import', perm: 'imports.data.write', app: 'imports', keywords: 'import excel xlsx csv upload استيراد اكسل رفع' }],
};
