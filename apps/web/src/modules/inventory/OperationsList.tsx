import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import type { Paged } from '../../core/types';
import { PageHeader, EmptyState } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { NewOperationButtons } from './StockPage';

interface Row {
  id: number;
  kind: string;
  number: string | null;
  date: string;
  status: string;
  reference: string | null;
  memo: string | null;
  warehouse_code: string;
  to_warehouse_code: string | null;
  line_count: number;
  value: number;
}

export function OperationsList() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Paged<Row>>('/inventory/operations', { limit: 20000 });
  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        id: 'number',
        header: t('common.number'),
        pinned: true,
        nowrap: true,
        value: (r) => r.number,
        render: (r) => (
          <span style={{ fontWeight: 550 }}>
            {r.number ?? <span className="faint">{t('status.draft')}</span>}
            {r.memo && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{r.memo}</div>}
          </span>
        ),
      },
      { id: 'kind', header: t('common.type'), type: 'enum', value: (r) => r.kind, format: (v) => t('inventory.kinds.' + v) },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      {
        id: 'warehouse',
        header: t('inventory.warehouse'),
        type: 'enum',
        value: (r) => r.warehouse_code,
        render: (r) => (
          <span className="nowrap">
            {r.warehouse_code}
            {r.to_warehouse_code && (
              <>
                {' '}
                <ArrowRight size={13} className="flip-rtl faint" style={{ verticalAlign: -2 }} /> {r.to_warehouse_code}
              </>
            )}
          </span>
        ),
      },
      { id: 'reference', header: t('common.reference'), hidden: true, value: (r) => r.reference },
      { id: 'lines', header: t('inventory.lines'), type: 'number', value: (r) => r.line_count },
      {
        id: 'value',
        header: t('inventory.value'),
        type: 'money',
        total: true,
        value: (r) => (r.kind === 'transfer' || r.status === 'void' ? null : r.value),
        render: (r) => (r.kind === 'transfer' ? <span className="faint">—</span> : <Money v={r.value} dashZero />),
      },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('status.' + v), render: (r) => <SimpleStatus status={r.status} /> },
    ],
    [t],
  );
  const presets = useMemo<Preset<Row>[]>(
    () => ['adjustment', 'transfer', 'count', 'opening'].map((k) => ({ id: k, label: t('inventory.kinds.' + k), test: (r: Row) => r.kind === k })),
    [t],
  );
  return (
    <div className="page">
      <PageHeader title={t('inventory.operations')} subtitle={t('inventory.operationsSubtitle')} actions={<NewOperationButtons />} />
      <DataGrid
        id="stock-operations"
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/inventory/operations/${r.id}`)}
        exportName={t('inventory.operations')}
        empty={<EmptyState title={t('common.noResults')} />}
      />
    </div>
  );
}
