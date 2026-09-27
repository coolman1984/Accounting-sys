import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Landmark, Plus } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import type { Direction, Paged, PaymentRow } from '../../core/types';
import { PageHeader, EmptyState } from '../../ui/Page';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { SimpleStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { PaymentEditor } from './PaymentEditor';
import { PaymentView } from './PaymentView';
import { TransfersPage } from './transfers';
import { BankPage, StatementPage } from './reconcile';

function PaymentList({ direction }: { direction: Direction }) {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const base = direction === 'in' ? '/receipts' : '/payments';
  const { data, isLoading } = useApi<Paged<PaymentRow>>('/payments', { direction, limit: 20000 });
  const Icon = direction === 'in' ? ArrowDownLeft : ArrowUpRight;

  const columns = useMemo<Column<PaymentRow>[]>(
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
            {r.reference && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{r.reference}</div>}
          </span>
        ),
      },
      { id: 'date', header: t('common.date'), type: 'date', nowrap: true, value: (r) => r.date },
      {
        id: 'party',
        header: direction === 'in' ? t('payments.receivedFrom') : t('payments.paidTo'),
        type: 'enum',
        value: (r) => r.party_name ?? (r.counter_name_en ? pick(r.counter_name_en, r.counter_name_ar ?? '') : null),
      },
      { id: 'account', header: t('payments.cashAccount'), type: 'enum', value: (r) => pick(r.account_name_en, r.account_name_ar) },
      { id: 'method', header: t('payments.method'), type: 'enum', hidden: true, value: (r) => r.method, format: (v) => (v ? t('payments.methods.' + v) : '') },
      { id: 'memo', header: t('common.memo'), hidden: true, value: (r) => r.memo },
      { id: 'status', header: t('common.status'), type: 'enum', value: (r) => r.status, format: (v) => t('status.' + v), render: (r) => <SimpleStatus status={r.status} /> },
      { id: 'amount', header: t('common.amount'), type: 'money', total: true, value: (r) => (r.status === 'void' ? 0 : r.amount), render: (r) => <Money v={r.amount} /> },
    ],
    [t, pick, direction],
  );
  const presets = useMemo<Preset<PaymentRow>[]>(
    () => [
      { id: 'draft', label: t('status.draft'), test: (r) => r.status === 'draft' },
      { id: 'posted', label: t('status.posted'), test: (r) => r.status === 'posted' },
      { id: 'void', label: t('status.void'), test: (r) => r.status === 'void' },
    ],
    [t],
  );

  return (
    <div className="page">
      <PageHeader
        title={t(`payments.${direction}.title`)}
        subtitle={t(`payments.${direction}.subtitle`)}
        actions={
          can(direction === 'in' ? 'treasury.receipts.write' : 'treasury.payments.write') && (
            <Link to={`${base}/new`} className="btn btn-primary">
              <Plus /> {t(`payments.${direction}.new`)}
            </Link>
          )
        }
      />
      <DataGrid
        id={`payments.${direction}`}
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`${base}/${r.id}`)}
        exportName={t(`payments.${direction}.title`)}
        empty={<EmptyState icon={<Icon size={22} />} title={t('common.noResults')} />}
      />
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

export const treasuryModule: WebModule = {
  id: 'treasury',
  nav: [
    { to: '/receipts', label: 'nav.receipts', icon: ArrowDownLeft, section: 'treasury', order: 10, perm: 'treasury.receipts.read', app: 'treasury' },
    { to: '/payments', label: 'nav.payments', icon: ArrowUpRight, section: 'treasury', order: 20, perm: 'treasury.payments.read', app: 'treasury' },
    { to: '/bank/transfers', label: 'nav.transfers', icon: ArrowLeftRight, section: 'treasury', order: 30, perm: 'treasury.transfers.read', app: 'treasury' },
    { to: '/bank', label: 'nav.bank', icon: Landmark, section: 'treasury', order: 40, perm: 'treasury.statements.read', app: 'treasury', end: true },
  ],
  routes: [
    ...routesFor('in'),
    ...routesFor('out'),
    { path: '/bank', element: <BankPage /> },
    { path: '/bank/statements/:id', element: <StatementPage /> },
    { path: '/bank/transfers', element: <TransfersPage /> },
  ],
  commands: [
    { id: 'new-receipt', label: 'payments.in.new', icon: ArrowDownLeft, group: 'create', to: '/receipts/new', perm: 'treasury.receipts.write', app: 'treasury', keywords: 'receipt receive قبض تحصيل' },
    { id: 'new-payment', label: 'payments.out.new', icon: ArrowUpRight, group: 'create', to: '/payments/new', perm: 'treasury.payments.write', app: 'treasury', keywords: 'pay expense صرف دفع' },
    { id: 'go-receipts', label: 'nav.receipts', icon: ArrowDownLeft, group: 'navigate', to: '/receipts', perm: 'treasury.receipts.read', app: 'treasury' },
    { id: 'go-payments', label: 'nav.payments', icon: ArrowUpRight, group: 'navigate', to: '/payments', perm: 'treasury.payments.read', app: 'treasury' },
    { id: 'go-transfers', label: 'nav.transfers', icon: ArrowLeftRight, group: 'navigate', to: '/bank/transfers', perm: 'treasury.transfers.read', app: 'treasury', keywords: 'transfer bank cash تحويل بنك خزينة' },
    { id: 'go-bank', label: 'nav.bank', icon: Landmark, group: 'navigate', to: '/bank', perm: 'treasury.statements.read', app: 'treasury', keywords: 'bank reconciliation statement مطابقة كشف بنك تسوية بنكية' },
  ],
};
