import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BookOpen, Plus } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { Paged } from '../../core/types';
import { PageHeader, EmptyState } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
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

function JournalList() {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const year = new Date().getFullYear();
  // The period bounds what is loaded; everything else is filtered in the grid.
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const { data, isLoading } = useApi<Paged<Row>>('/journal', { from, to, limit: 20000 });

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        id: 'number',
        header: t('common.number'),
        pinned: true,
        nowrap: true,
        value: (r) => r.number,
        render: (r) => <span style={{ fontWeight: 550 }}>{r.number ?? <span className="faint">#{r.id}</span>}</span>,
      },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      {
        id: 'memo',
        header: t('common.memo'),
        value: (r) => r.memo,
        render: (r) => (
          <>
            {r.memo || <span className="faint">—</span>}
            {r.reference && <div className="faint" style={{ fontSize: 12 }}>{r.reference}</div>}
          </>
        ),
      },
      { id: 'reference', header: t('common.reference'), hidden: true, value: (r) => r.reference },
      { id: 'source', header: t('common.source'), type: 'enum', value: (r) => r.source_type, format: (v) => t('journal.sources.' + v) },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (r) => (r.status === 'draft' ? 'draft' : r.reversed_by_id ? 'reversed' : r.reversal_of_id ? 'reversal' : 'posted'),
        format: (v) => t('status.' + v),
        render: (r) => <EntryStatus status={r.status} reversed={!!r.reversed_by_id} reversal={!!r.reversal_of_id} />,
      },
      { id: 'user', header: t('common.createdBy'), type: 'enum', hidden: true, value: (r) => r.created_by_name },
      { id: 'total', header: t('common.total'), type: 'money', total: true, value: (r) => r.total, render: (r) => <Money v={r.total} /> },
    ],
    [t],
  );
  const presets = useMemo<Preset<Row>[]>(
    () => [
      { id: 'manual', label: t('journal.sources.manual'), test: (r) => r.source_type === 'manual' },
      { id: 'draft', label: t('status.draft'), test: (r) => r.status === 'draft' },
    ],
    [t],
  );

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
      <DataGrid
        id="journal"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/journal/${r.id}`)}
        exportName={t('journal.title')}
        toolbar={
          <span className="row" style={{ gap: 6 }}>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} aria-label={t('common.from')} />
            <span className="faint">–</span>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} aria-label={t('common.to')} />
          </span>
        }
        empty={<EmptyState icon={<BookOpen size={22} />} title={t('common.noResults')} />}
      />
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
