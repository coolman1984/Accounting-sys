import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, Search } from 'lucide-react';
import { useApi, useDate } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import type { Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, Pager } from '../../ui/Page';
import { Card } from '../../ui/Card';
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

const LIMIT = 50;

export function OperationsList() {
  const { t } = useI18n();
  const date = useDate();
  const navigate = useNavigate();
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading } = useApi<Paged<Row>>('/inventory/operations', { kind, q, limit: LIMIT, offset });
  return (
    <div className="page">
      <PageHeader title={t('inventory.operations')} subtitle={t('inventory.operationsSubtitle')} actions={<NewOperationButtons />} />
      <div className="toolbar">
        <div className="input-group">
          <Search />
          <input className="input" placeholder={t('common.search')} value={q} onChange={(e) => (setQ(e.target.value), setOffset(0))} />
        </div>
        <div className="segmented">
          {['', 'adjustment', 'transfer', 'count', 'opening'].map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => (setKind(k), setOffset(0))}>
              {k ? t('inventory.kinds.' + k) : t('common.all')}
            </button>
          ))}
        </div>
      </div>
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.number')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('inventory.warehouse')}</th>
                    <th className="end">{t('inventory.lines')}</th>
                    <th className="end">{t('inventory.value')}</th>
                    <th>{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/inventory/operations/${r.id}`)}>
                      <td className="nowrap" style={{ fontWeight: 550 }}>
                        {r.number ?? <span className="faint">{t('status.draft')}</span>}
                        {r.memo && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{r.memo}</div>}
                      </td>
                      <td>{t('inventory.kinds.' + r.kind)}</td>
                      <td className="nowrap">{date(r.date)}</td>
                      <td className="nowrap">
                        {r.warehouse_code}
                        {r.to_warehouse_code && (
                          <>
                            {' '}
                            <ArrowRight size={13} className="flip-rtl faint" style={{ verticalAlign: -2 }} /> {r.to_warehouse_code}
                          </>
                        )}
                      </td>
                      <td className="end num">{r.line_count}</td>
                      <td className="end">{r.kind === 'transfer' ? <span className="faint">—</span> : <Money v={r.value} dashZero />}</td>
                      <td>
                        <SimpleStatus status={r.status} />
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
