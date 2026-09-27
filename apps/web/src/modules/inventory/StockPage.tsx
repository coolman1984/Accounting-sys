import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, ArrowLeftRight, ClipboardCheck, PackageCheck, PackageX, Plus, SlidersHorizontal, Warehouse as WarehouseIcon, Wallet } from 'lucide-react';
import { useApi, useDate, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { PageHeader, EmptyState } from '../../ui/Page';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { Money } from '../../ui/Money';
import { Qty, StockStatus, WarehouseSelect } from './common';

interface StockRow {
  id: number;
  sku: string;
  barcode: string | null;
  name_en: string;
  name_ar: string;
  unit: string | null;
  category_name_en: string | null;
  category_name_ar: string | null;
  qty: number;
  value: number;
  avg_cost: number;
  reorder_level: number;
  status: 'ok' | 'low' | 'out';
  last_move: string | null;
  last_sale: string | null;
}

export interface Summary {
  value: number;
  items: number;
  inStock: number;
  low: number;
  out: number;
  warehouses: number;
  top: { id: number; sku: string; name_en: string; name_ar: string; qty: number; value: number }[];
  lowItems: { id: number; sku: string; name_en: string; name_ar: string; qty: number; reorder_level: number }[];
}

export function Kpi({ icon, label, value, tone, onClick, active }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: string; onClick?(): void; active?: boolean }) {
  return (
    <button
      type="button"
      className="card kpi"
      onClick={onClick}
      style={{ textAlign: 'start', cursor: onClick ? 'pointer' : 'default', borderColor: active ? 'var(--primary)' : undefined, font: 'inherit', color: 'inherit' }}
    >
      <div className="kpi-label">
        <span className="kpi-icon" style={tone ? { background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone } : undefined}>
          {icon}
        </span>
        {label}
      </div>
      <div className="kpi-value">{value}</div>
    </button>
  );
}

export function NewOperationButtons() {
  const { t } = useI18n();
  const { can } = useSession();
  if (!can('inventory.write')) return null;
  return (
    <>
      <Link to="/inventory/operations/new?kind=transfer" className="btn">
        <ArrowLeftRight /> {t('inventory.kinds.transfer')}
      </Link>
      <Link to="/inventory/operations/new?kind=count" className="btn">
        <ClipboardCheck /> {t('inventory.kinds.count')}
      </Link>
      <Link to="/inventory/operations/new?kind=adjustment" className="btn btn-primary">
        <SlidersHorizontal /> {t('inventory.kinds.adjustment')}
      </Link>
    </>
  );
}

export function StockPage() {
  const { t, pick } = useI18n();
  const date = useDate();
  const { fmt } = useMoney();
  const navigate = useNavigate();
  const [wh, setWh] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const { data: summary } = useApi<Summary>('/inventory/summary');
  // The warehouse and the stock status cards decide what is loaded; the grid filters the rest.
  const { data, isLoading } = useApi<{ rows: StockRow[]; totals: { qty: number; value: number } }>('/inventory/stock', {
    warehouseId: wh ?? undefined,
    status,
  });

  const columns = useMemo<Column<StockRow>[]>(
    () => [
      { id: 'sku', header: t('items.sku'), pinned: true, width: 110, value: (r) => r.sku, render: (r) => <span className="num faint">{r.sku}</span> },
      { id: 'name', header: t('common.name'), value: (r) => pick(r.name_en, r.name_ar), render: (r) => <span style={{ fontWeight: 550 }}>{pick(r.name_en, r.name_ar)}</span> },
      { id: 'category', header: t('items.category'), type: 'enum', value: (r) => (r.category_name_en ? pick(r.category_name_en, r.category_name_ar ?? '') : null) },
      { id: 'barcode', header: t('adv.unitBarcode'), hidden: true, value: (r) => r.barcode },
      { id: 'unit', header: t('adv.baseUnit'), type: 'enum', hidden: true, value: (r) => r.unit },
      { id: 'qty', header: t('inventory.onHand'), type: 'qty', value: (r) => r.qty, render: (r) => <strong><Qty v={r.qty} unit={r.unit} /></strong> },
      { id: 'reorder', header: t('inventory.reorderLevel'), type: 'qty', value: (r) => r.reorder_level || null },
      { id: 'avg', header: t('inventory.avgCost'), type: 'money', value: (r) => r.avg_cost, render: (r) => <Money v={r.avg_cost} dashZero /> },
      { id: 'value', header: t('inventory.value'), type: 'money', total: true, value: (r) => r.value, render: (r) => <Money v={r.value} dashZero /> },
      { id: 'status', header: t('inventory.status'), type: 'enum', value: (r) => r.status, format: (v) => t('inventory.' + v), render: (r) => <StockStatus status={r.status} /> },
      { id: 'lastSale', header: t('inventory.lastSale'), type: 'date', nowrap: true, value: (r) => r.last_sale, render: (r) => <span className="muted">{r.last_sale ? date(r.last_sale) : '—'}</span> },
      { id: 'lastMove', header: t('inventory.lastMove'), type: 'date', hidden: true, value: (r) => r.last_move },
    ],
    [t, pick, date],
  );

  return (
    <div className="page">
      <PageHeader title={t('inventory.title')} subtitle={t('inventory.subtitle')} actions={<NewOperationButtons />} />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {summary && (
          <div className="grid-4">
            <Kpi icon={<Wallet />} label={t('inventory.value')} value={fmt(summary.value)} />
            <Kpi icon={<PackageCheck />} tone="var(--success)" label={t('inventory.inStock')} value={`${summary.inStock} / ${summary.items}`} onClick={() => setStatus(status === 'in' ? '' : 'in')} active={status === 'in'} />
            <Kpi icon={<AlertTriangle />} tone="var(--line-amber)" label={t('inventory.low')} value={summary.low} onClick={() => setStatus(status === 'low' ? '' : 'low')} active={status === 'low'} />
            <Kpi icon={<PackageX />} tone="var(--danger)" label={t('inventory.out')} value={summary.out} onClick={() => setStatus(status === 'out' ? '' : 'out')} active={status === 'out'} />
          </div>
        )}
        <DataGrid
          id="stock"
          rows={data?.rows}
          loading={isLoading}
          columns={columns}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/inventory/items/${r.id}`)}
          exportName="stock-on-hand"
          toolbar={
            <>
              <WarehouseSelect all value={wh} onChange={setWh} />
              <Link to="/inventory/warehouses" className="btn btn-sm btn-ghost">
                <WarehouseIcon /> {t('inventory.warehouses')}
              </Link>
            </>
          }
          empty={<EmptyState title={t('common.noResults')} action={<Link to="/items" className="btn btn-primary"><Plus /> {t('items.new')}</Link>} />}
        />
      </div>
    </div>
  );
}
