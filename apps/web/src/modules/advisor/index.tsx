import { useState } from 'react';
import { Link } from 'react-router';
import { AlertOctagon, AlertTriangle, ArrowUpRight, BookOpenCheck, CheckCircle2, Lightbulb, Scale, ShieldCheck } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { formatDate, todayIso } from '../../core/format';
import { Loading, PageHeader } from '../../ui/Page';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Input } from '../../ui/Field';

type Severity = 'error' | 'warning' | 'tip';
type Area = 'vat' | 'wht' | 'payroll' | 'income_tax' | 'standards' | 'books';
interface Finding {
  id: string;
  area: Area;
  severity: Severity;
  values: Record<string, string | number>;
  money: string[];
  items: { label: string; sub?: string; link?: string; amount?: number }[];
}

const TONE: Record<Severity, Tone> = { error: 'red', warning: 'amber', tip: 'blue' };
const ICON = { error: AlertOctagon, warning: AlertTriangle, tip: Lightbulb };
const AREAS: Area[] = ['vat', 'wht', 'payroll', 'income_tax', 'standards', 'books'];

/** A finding's words, with its amounts and dates written for the reader. */
function useWords() {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  return (f: Finding, part: 'title' | 'body' | 'fix' | 'law') => {
    const v: Record<string, string | number> = {};
    for (const [k, val] of Object.entries(f.values)) {
      v[k] = f.money.includes(k) ? fmt(Number(val)) : typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val) ? formatDate(val, locale, 'long') : val;
    }
    return t(`advisor.checks.${f.id}.${part}`, v);
  };
}

function FindingCard({ f }: { f: Finding }) {
  const { t } = useI18n();
  const { fmt } = useMoney();
  const words = useWords();
  const Icon = ICON[f.severity];
  const [open, setOpen] = useState(f.severity !== 'tip');
  const link = f.items.length === 1 && !f.items[0].label ? f.items[0].link : null;
  const list = f.items.filter((i) => i.label);
  return (
    <Card className={`advice advice-${f.severity}`}>
      <button type="button" className="advice-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon size={20} className="advice-icon" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <strong>{words(f, 'title')}</strong>
            <Badge plain tone={TONE[f.severity]}>
              {t('advisor.severity.' + f.severity)}
            </Badge>
            <Badge plain>{t('advisor.areas.' + f.area)}</Badge>
          </div>
        </div>
      </button>
      {open && (
        <div className="advice-body">
          <p>{words(f, 'body')}</p>
          <div className="advice-fix">
            <strong>{t('advisor.whatToDo')}</strong> {words(f, 'fix')}
          </div>
          <div className="advice-law">
            <Scale size={14} /> {words(f, 'law')}
          </div>
          {list.length > 0 && (
            <table className="table table-compact" style={{ marginTop: 10 }}>
              <tbody>
                {list.map((i, n) => (
                  <tr key={n}>
                    <td>{i.link ? <Link to={i.link}>{i.label}</Link> : i.label}</td>
                    <td className="muted nowrap">{i.sub}</td>
                    <td className="end num">{i.amount != null ? fmt(i.amount) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {link && (
            <Link to={link} className="btn btn-sm" style={{ marginTop: 10 }}>
              <ArrowUpRight /> {t('advisor.open')}
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}

function AdvisorPage() {
  const { t } = useI18n();
  const [asOf, setAsOf] = useState(todayIso());
  const [area, setArea] = useState<Area | 'all'>('all');
  const { data, isLoading } = useApi<{ asOf: string; findings: Finding[] }>('/advisor', { asOf });
  const list = (data?.findings ?? []).filter((f) => area === 'all' || f.area === area);
  const count = (s: Severity) => (data?.findings ?? []).filter((f) => f.severity === s).length;
  return (
    <div className="page">
      <PageHeader
        title={t('advisor.title')}
        subtitle={t('advisor.subtitle')}
        actions={
          <label className="row" style={{ gap: 8 }}>
            <span className="muted">{t('advisor.asOf')}</span>
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || todayIso())} style={{ width: 170 }} />
          </label>
        }
      />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <div className="grid-3">
            {(['error', 'warning', 'tip'] as Severity[]).map((s) => {
              const Icon = ICON[s];
              return (
                <Card key={s} className={`kpi advice-kpi advice-${s}`}>
                  <div className="kpi-label row" style={{ gap: 6 }}>
                    <Icon size={15} /> {t('advisor.count.' + s)}
                  </div>
                  <div className="kpi-value">{count(s)}</div>
                </Card>
              );
            })}
          </div>
          <div className="segmented" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
            <button aria-pressed={area === 'all'} onClick={() => setArea('all')}>
              {t('common.all')}
            </button>
            {AREAS.map((a) => {
              const n = data.findings.filter((f) => f.area === a).length;
              return (
                <button key={a} aria-pressed={area === a} onClick={() => setArea(a)} disabled={!n}>
                  {t('advisor.areas.' + a)}
                  {n ? <span className="faint"> · {n}</span> : null}
                </button>
              );
            })}
          </div>
          {!list.length ? (
            <Card pad>
              <div className="row" style={{ gap: 12 }}>
                <ShieldCheck size={28} className="success-text" />
                <div>
                  <strong>{t('advisor.allClear')}</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {t('advisor.allClearText')}
                  </p>
                </div>
              </div>
            </Card>
          ) : (
            list.map((f) => <FindingCard key={f.id} f={f} />)
          )}
          <p className="faint" style={{ fontSize: 12.5 }}>
            {t('advisor.disclaimer')}
          </p>
        </div>
      )}
    </div>
  );
}

/** On an invoice or bill: the advice that concerns it. */
function DocumentAdvice({ documentId, status }: { documentId: number; kind: string; status: string }) {
  const { hasApp, can } = useSession();
  const words = useWords();
  const on = hasApp('advisor') && can('advisor.findings.read') && status !== 'void';
  const { data } = useApi<Finding[]>(on ? `/advisor/documents/${documentId}` : null);
  if (!data?.length) return null;
  return (
    <div className="stack no-print" style={{ gap: 8 }}>
      {data.map((f) => (
        <div key={f.id} className="notice warn">
          <AlertTriangle />
          <div>
            <strong>{words(f, 'title')}</strong>
            <div style={{ marginTop: 4 }}>{words(f, 'fix')}</div>
            <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
              {words(f, 'law')}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** On the dashboard: the most serious points, in one card. */
function AdvisorWidget() {
  const { t } = useI18n();
  const { hasApp, can } = useSession();
  const words = useWords();
  const on = hasApp('advisor') && can('advisor.findings.read');
  const { data } = useApi<{ findings: Finding[] }>(on ? '/advisor' : null, { asOf: todayIso() });
  if (!data) return null;
  const top = data.findings.filter((f) => f.severity !== 'tip').slice(0, 4);
  const tips = data.findings.filter((f) => f.severity === 'tip').length;
  return (
    <Card className="table-card">
      <CardHeader
        title={t('advisor.title')}
        icon={<BookOpenCheck size={18} className="muted" />}
        actions={
          <Link to="/advisor" className="btn btn-sm">
            {t('advisor.openAll')}
          </Link>
        }
      />
      {!top.length ? (
        <div className="card-body row" style={{ gap: 8 }}>
          <CheckCircle2 size={18} className="success-text" /> {tips ? t('advisor.onlyTips', { n: tips }) : t('advisor.allClear')}
        </div>
      ) : (
        <table className="table table-compact">
          <tbody>
            {top.map((f) => {
              const Icon = ICON[f.severity];
              return (
                <tr key={f.id}>
                  <td style={{ width: 28 }}>
                    <Icon size={16} className={f.severity === 'error' ? 'danger-text' : 'warning-text'} />
                  </td>
                  <td>
                    <Link to="/advisor">{words(f, 'title')}</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export const advisorModule: WebModule = {
  id: 'advisor',
  nav: [{ to: '/advisor', label: 'advisor.title', icon: BookOpenCheck, section: 'tax', order: 5, perm: 'advisor.findings.read', app: 'advisor' }],
  routes: [{ path: '/advisor', element: <AdvisorPage /> }],
  commands: [{ id: 'go-advisor', label: 'advisor.title', icon: BookOpenCheck, group: 'navigate', to: '/advisor', perm: 'advisor.findings.read', app: 'advisor', keywords: 'advisor compliance egypt law tax eas ifrs مراجع التزام ضرائب قانون معايير' }],
  slots: { 'document.view': DocumentAdvice, 'dashboard.widgets': AdvisorWidget },
};
