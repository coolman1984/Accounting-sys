import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { todayIso } from '../../core/format';
import type { DocKind, DocumentRow, Paged } from '../../core/types';
import { PageHeader, EmptyState } from '../../ui/Page';
import { DocStatus, docState } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { KIND_UI } from './kinds';

const outstanding = (r: DocumentRow) => (r.status === 'posted' ? r.total - r.amount_settled : 0);

export function DocumentList({ kind }: { kind: DocKind }) {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ui = KIND_UI[kind];
  const { data, isLoading } = useApi<Paged<DocumentRow>>('/documents', { kind, limit: 20000 });
  const Icon = ui.icon;

  const columns = useMemo<Column<DocumentRow>[]>(
    () => [
      {
        id: 'number',
        header: t('common.number'),
        pinned: true,
        nowrap: true,
        value: (r) => r.number,
        format: (v) => (v ? String(v) : t('status.draft')),
        render: (r) => (
          <span style={{ fontWeight: 550 }}>
            {r.number ?? <span className="faint">{t('status.draft')}</span>}
            {r.reference && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{r.reference}</div>}
          </span>
        ),
      },
      { id: 'party', header: t(`docs.${ui.partyKind}`), type: 'enum', value: (r) => r.party_name },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      { id: 'due', header: t('common.dueDate'), type: 'date', nowrap: true, value: (r) => r.due_date },
      { id: 'reference', header: t('common.reference'), hidden: true, value: (r) => r.reference },
      {
        id: 'status',
        header: t('common.status'),
        type: 'enum',
        value: (r) => docState(r.status, r.total, r.amount_settled, r.due_date),
        format: (v) => t('status.' + v),
        render: (r) => <DocStatus status={r.status} total={r.total} settled={r.amount_settled} due={r.due_date} />,
      },
      { id: 'subtotal', header: t('common.subtotal'), type: 'money', hidden: true, total: true, value: (r) => r.subtotal },
      { id: 'tax', header: t('docs.tax'), type: 'money', hidden: true, total: true, value: (r) => r.tax_total },
      { id: 'total', header: t('common.total'), type: 'money', total: true, value: (r) => r.total, render: (r) => <Money v={r.total} /> },
      {
        id: 'outstanding',
        header: t('docs.outstanding'),
        type: 'money',
        total: true,
        value: outstanding,
        render: (r) => (r.status === 'posted' ? <Money v={outstanding(r)} dashZero /> : <span className="faint">—</span>),
      },
    ],
    [t, ui.partyKind],
  );

  const presets = useMemo<Preset<DocumentRow>[]>(
    () => [
      { id: 'draft', label: t('status.draft'), test: (r) => r.status === 'draft' },
      { id: 'open', label: t('docs.openOnly'), test: (r) => r.status === 'posted' && r.amount_settled < r.total },
      { id: 'overdue', label: t('docs.overdueOnly'), test: (r) => r.status === 'posted' && r.amount_settled < r.total && r.due_date < todayIso() },
      { id: 'void', label: t('status.void'), test: (r) => r.status === 'void' },
    ],
    [t],
  );

  const newBtn = can(`${ui.perm}.write`) && (
    <Link to={`${ui.base}/new`} className="btn btn-primary">
      <Plus /> {t(`docs.${kind}.new`)}
    </Link>
  );

  return (
    <div className="page">
      <PageHeader title={t(`docs.${kind}.title`)} subtitle={t(`docs.${kind}.subtitle`)} actions={newBtn} />
      <DataGrid
        id={`documents.${kind}`}
        key={params.get('overdue') ? 'overdue' : 'all'}
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        initialPreset={params.get('overdue') ? 'overdue' : undefined}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`${ui.base}/${r.id}`)}
        exportName={t(`docs.${kind}.title`)}
        empty={<EmptyState icon={<Icon size={22} />} title={t('docs.empty')} text={t('docs.emptyText')} action={newBtn} />}
      />
    </div>
  );
}
