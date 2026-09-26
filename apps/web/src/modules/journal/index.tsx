import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BookOpen, Plus, Search } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useDate } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, Pager } from '../../ui/Page';
import { Card } from '../../ui/Card';
import { Select } from '../../ui/Field';
import { EntryStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { JournalEditor } from './JournalEditor';
import { JournalView } from './JournalView';

interface Row {
  id: number;
  number: string | null;
  date: string;
  reference: string | null;
  memo: string | null;
  source_type: string;
  status: 'draft' | 'posted';
  total: number;
  reversal_of_id: number | null;
  reversed_by_id: number | null;
  created_by_name: string | null;
}

const SOURCES = ['manual', 'opening', 'sales_invoice', 'sales_credit', 'purchase_bill', 'purchase_credit', 'receipt', 'payment', 'reversal', 'closing'];
const LIMIT = 50;

function JournalList() {
  const { t } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading } = useApi<Paged<Row>>('/journal', { q, status, source, from, to, limit: LIMIT, offset });

  return (
    <div className="page">
      <PageHeader
        title={t('journal.title')}
        subtitle={t('journal.subtitle')}
        actions={
          can('journal.write') && (
            <Link to="/journal/new" className="btn btn-primary">
              <Plus /> {t('journal.new')}
            </Link>
          )
        }
      />
      <div className="toolbar">
        <div className="input-group">
          <Search />
          <input className="input" placeholder={t('common.search')} value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} />
        </div>
        <div className="segmented">
          {['', 'draft', 'posted'].map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => (setStatus(s), setOffset(0))}>
              {s ? t('status.' + s) : t('common.all')}
            </button>
          ))}
        </div>
        <Select value={source} onChange={(e) => (setSource(e.target.value), setOffset(0))} style={{ width: 'auto' }}>
          <option value="">{t('common.source')}: {t('common.all')}</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {t('journal.sources.' + s)}
            </option>
          ))}
        </Select>
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} aria-label={t('common.from')} />
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} aria-label={t('common.to')} />
      </div>
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <EmptyState icon={<BookOpen size={22} />} title={t('common.noResults')} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.number')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('common.memo')}</th>
                    <th>{t('common.source')}</th>
                    <th>{t('common.status')}</th>
                    <th className="end">{t('common.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/journal/${r.id}`)}>
                      <td className="nowrap" style={{ fontWeight: 550 }}>
                        {r.number ?? <span className="faint">#{r.id}</span>}
                      </td>
                      <td className="nowrap">{date(r.date)}</td>
                      <td>
                        {r.memo || <span className="faint">—</span>}
                        {r.reference && <div className="faint" style={{ fontSize: 12 }}>{r.reference}</div>}
                      </td>
                      <td className="muted nowrap">{t('journal.sources.' + r.source_type)}</td>
                      <td>
                        <EntryStatus status={r.status} reversed={!!r.reversed_by_id} reversal={!!r.reversal_of_id} />
                      </td>
                      <td className="end">
                        <Money v={r.total} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}

export const journalModule: WebModule = {
  id: 'journal',
  nav: [{ to: '/journal', label: 'nav.journal', icon: BookOpen, section: 'accounting', order: 20, perm: 'journal.read' }],
  routes: [
    { path: '/journal', element: <JournalList /> },
    { path: '/journal/new', element: <JournalEditor /> },
    { path: '/journal/:id', element: <JournalView /> },
    { path: '/journal/:id/edit', element: <JournalEditor /> },
  ],
  commands: [
    { id: 'new-journal', label: 'journal.new', icon: BookOpen, group: 'create', to: '/journal/new', perm: 'journal.write', keywords: 'entry قيد' },
    { id: 'go-journal', label: 'nav.journal', icon: BookOpen, group: 'navigate', to: '/journal', perm: 'journal.read', keywords: 'entries قيود' },
  ],
};
