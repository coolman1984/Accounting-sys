import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Plus, Search } from 'lucide-react';
import { useApi, useDate, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { DocKind, DocumentRow, Paged } from '../../core/types';
import { PageHeader, Loading, EmptyState, Pager } from '../../ui/Page';
import { Card } from '../../ui/Card';
import { DocStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { KIND_UI } from './kinds';

const LIMIT = 50;

export function DocumentList({ kind }: { kind: DocKind }) {
  const { t } = useI18n();
  const date = useDate();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ui = KIND_UI[kind];
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(params.get('overdue') ? 'overdue' : '');
  const [offset, setOffset] = useState(0);
  const query = {
    kind,
    q,
    status: filter === 'draft' || filter === 'void' ? filter : '',
    open: filter === 'open',
    overdue: filter === 'overdue',
    limit: LIMIT,
    offset,
  };
  const { data, isLoading } = useApi<Paged<DocumentRow>>('/documents', query);
  const Icon = ui.icon;

  return (
    <div className="page">
      <PageHeader
        title={t(`docs.${kind}.title`)}
        subtitle={t(`docs.${kind}.subtitle`)}
        actions={
          can(`${ui.side}.write`) && (
            <Link to={`${ui.base}/new`} className="btn btn-primary">
              <Plus /> {t(`docs.${kind}.new`)}
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
          {[
            ['', t('common.all')],
            ['draft', t('status.draft')],
            ['open', t('docs.openOnly')],
            ['overdue', t('docs.overdueOnly')],
            ['void', t('status.void')],
          ].map(([v, label]) => (
            <button key={v} aria-pressed={filter === v} onClick={() => (setFilter(v), setOffset(0))}>
              {label}
            </button>
          ))}
        </div>
        {data?.sums && (
          <div className="muted" style={{ marginInlineStart: 'auto', fontSize: 13 }}>
            {t('docs.outstanding')}: <strong className="num" style={{ color: 'var(--text)' }}>{fmt(data.sums.outstanding)}</strong>
          </div>
        )}
      </div>
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <EmptyState
            icon={<Icon size={22} />}
            title={t('docs.empty')}
            text={t('docs.emptyText')}
            action={
              can(`${ui.side}.write`) && (
                <Link to={`${ui.base}/new`} className="btn btn-primary">
                  <Plus /> {t(`docs.${kind}.new`)}
                </Link>
              )
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.number')}</th>
                    <th>{t(`docs.${ui.partyKind}`)}</th>
                    <th>{t('common.date')}</th>
                    <th>{t('common.dueDate')}</th>
                    <th>{t('common.status')}</th>
                    <th className="end">{t('common.total')}</th>
                    <th className="end">{t('docs.outstanding')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`${ui.base}/${r.id}`)}>
                      <td className="nowrap" style={{ fontWeight: 550 }}>
                        {r.number ?? <span className="faint">{t('status.draft')}</span>}
                        {r.reference && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{r.reference}</div>}
                      </td>
                      <td>{r.party_name}</td>
                      <td className="nowrap">{date(r.date)}</td>
                      <td className="nowrap">{date(r.due_date)}</td>
                      <td>
                        <DocStatus status={r.status} total={r.total} settled={r.amount_settled} due={r.due_date} />
                      </td>
                      <td className="end">
                        <Money v={r.total} />
                      </td>
                      <td className="end">{r.status === 'posted' ? <Money v={r.total - r.amount_settled} dashZero /> : <span className="faint">—</span>}</td>
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
