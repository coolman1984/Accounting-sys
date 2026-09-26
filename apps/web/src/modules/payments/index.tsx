import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDownLeft, ArrowUpRight, Plus, Search } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useDate, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { Direction, Paged, PaymentRow } from '../../core/types';
import { PageHeader, Loading, EmptyState, Pager } from '../../ui/Page';
import { Card } from '../../ui/Card';
import { SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { PaymentEditor } from './PaymentEditor';
import { PaymentView } from './PaymentView';

const LIMIT = 50;

function PaymentList({ direction }: { direction: Direction }) {
  const { t, pick } = useI18n();
  const date = useDate();
  const { fmt } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const base = direction === 'in' ? '/receipts' : '/payments';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading } = useApi<Paged<PaymentRow>>('/payments', { direction, q, status, limit: LIMIT, offset });
  const Icon = direction === 'in' ? ArrowDownLeft : ArrowUpRight;

  return (
    <div className="page">
      <PageHeader
        title={t(`payments.${direction}.title`)}
        subtitle={t(`payments.${direction}.subtitle`)}
        actions={
          can('payments.write') && (
            <Link to={`${base}/new`} className="btn btn-primary">
              <Plus /> {t(`payments.${direction}.new`)}
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
          {['', 'draft', 'posted', 'void'].map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => (setStatus(s), setOffset(0))}>
              {s ? t('status.' + s) : t('common.all')}
            </button>
          ))}
        </div>
        {data?.sums && (
          <div className="muted" style={{ marginInlineStart: 'auto', fontSize: 13 }}>
            {t('common.total')}: <strong className="num" style={{ color: 'var(--text)' }}>{fmt(data.sums.total)}</strong>
          </div>
        )}
      </div>
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : !data?.rows.length ? (
          <EmptyState icon={<Icon size={22} />} title={t('common.noResults')} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.number')}</th>
                    <th>{t('common.date')}</th>
                    <th>{direction === 'in' ? t('payments.receivedFrom') : t('payments.paidTo')}</th>
                    <th>{t('payments.cashAccount')}</th>
                    <th>{t('common.status')}</th>
                    <th className="end">{t('common.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`${base}/${r.id}`)}>
                      <td className="nowrap" style={{ fontWeight: 550 }}>
                        {r.number ?? <span className="faint">{t('status.draft')}</span>}
                        {r.reference && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{r.reference}</div>}
                      </td>
                      <td className="nowrap">{date(r.date)}</td>
                      <td>{r.party_name ?? <span className="muted">{pick(r.counter_name_en, r.counter_name_ar)}</span>}</td>
                      <td className="muted">{pick(r.account_name_en, r.account_name_ar)}</td>
                      <td>
                        <SimpleStatus status={r.status} />
                      </td>
                      <td className="end">
                        <Money v={r.amount} />
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

const routesFor = (direction: Direction) => {
  const base = direction === 'in' ? '/receipts' : '/payments';
  return [
    { path: base, element: <PaymentList key={direction} direction={direction} /> },
    { path: `${base}/new`, element: <PaymentEditor key={direction + '-new'} direction={direction} /> },
    { path: `${base}/:id`, element: <PaymentView key={direction + '-view'} direction={direction} /> },
    { path: `${base}/:id/edit`, element: <PaymentEditor key={direction + '-edit'} direction={direction} /> },
  ];
};

export const paymentsModule: WebModule = {
  id: 'payments',
  nav: [
    { to: '/receipts', label: 'nav.receipts', icon: ArrowDownLeft, section: 'banking', order: 10, perm: 'payments.read' },
    { to: '/payments', label: 'nav.payments', icon: ArrowUpRight, section: 'banking', order: 20, perm: 'payments.read' },
  ],
  routes: [...routesFor('in'), ...routesFor('out')],
  commands: [
    { id: 'new-receipt', label: 'payments.in.new', icon: ArrowDownLeft, group: 'create', to: '/receipts/new', perm: 'payments.write', keywords: 'receipt receive قبض تحصيل' },
    { id: 'new-payment', label: 'payments.out.new', icon: ArrowUpRight, group: 'create', to: '/payments/new', perm: 'payments.write', keywords: 'pay expense صرف دفع' },
    { id: 'go-receipts', label: 'nav.receipts', icon: ArrowDownLeft, group: 'navigate', to: '/receipts', perm: 'payments.read' },
    { id: 'go-payments', label: 'nav.payments', icon: ArrowUpRight, group: 'navigate', to: '/payments', perm: 'payments.read' },
  ],
};
