import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Download, FilePlus, Mail, MapPin, Pencil, Phone, Plus, Search, Trash2, Truck, Users, Wallet } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { sourceLink } from '../../core/links';
import type { Paged, Party } from '../../core/types';
import { downloadCsv, csvMoney } from '../../lib/csv';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Input } from '../../ui/Field';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { DataGrid, type Column, type Preset } from '../../ui/DataGrid';
import { PartyDialog } from './PartyDialog';

type Kind = 'customer' | 'supplier';
const base = (k: Kind) => (k === 'customer' ? '/customers' : '/suppliers');

function PartyList({ kind }: { kind: Kind }) {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState(false);
  const { data, isLoading } = useApi<Paged<Party>>('/parties', { kind, limit: 20000 });
  const Icon = kind === 'customer' ? Users : Truck;
  const balanceOf = (p: Party) => (kind === 'customer' ? p.receivable : p.payable);

  const columns = useMemo<Column<Party>[]>(
    () => [
      { id: 'code', header: t('common.code'), pinned: true, width: 90, value: (p) => p.code, render: (p) => <span className="num faint">{p.code}</span> },
      {
        id: 'name',
        header: t('common.name'),
        value: (p) => p.name,
        render: (p) => (
          <span style={{ fontWeight: 550 }}>
            {p.name}
            {p.name_alt && <div className="faint" style={{ fontSize: 12, fontWeight: 400 }}>{p.name_alt}</div>}
          </span>
        ),
      },
      { id: 'phone', header: t('common.phone'), value: (p) => p.phone, render: (p) => <span className="muted" dir="ltr">{p.phone}</span> },
      { id: 'email', header: t('common.email'), hidden: true, value: (p) => p.email },
      { id: 'city', header: t('common.city'), type: 'enum', value: (p) => p.city },
      { id: 'country', header: t('common.country'), type: 'enum', hidden: true, value: (p) => p.country },
      { id: 'taxNumber', header: t('common.taxNumber'), hidden: true, value: (p) => p.tax_number },
      { id: 'terms', header: t('parties.terms'), type: 'number', hidden: true, value: (p) => p.payment_terms_days },
      ...(kind === 'customer'
        ? [{ id: 'limit', header: t('parties.creditLimit'), type: 'money' as const, hidden: true, value: (p: Party) => p.credit_limit }]
        : []),
      {
        id: 'active',
        header: t('common.status'),
        type: 'enum',
        hidden: true,
        value: (p) => (p.is_active ? 'active' : 'inactive'),
        format: (v) => t('common.' + v),
      },
      {
        id: 'balance',
        header: kind === 'customer' ? t('parties.receivable') : t('parties.payable'),
        type: 'money',
        total: true,
        value: balanceOf,
        render: (p) => <Money v={balanceOf(p)} dashZero tone />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, kind],
  );
  const presets = useMemo<Preset<Party>[]>(
    () => [
      { id: 'balance', label: kind === 'customer' ? t('parties.receivable') : t('parties.payable'), test: (p) => balanceOf(p) !== 0 },
      { id: 'inactive', label: t('common.inactive'), test: (p) => !p.is_active },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, kind],
  );
  const newBtn = can('parties.write') && (
    <Button variant="primary" icon={<Plus />} onClick={() => setDialog(true)}>
      {t(`parties.${kind}s.new`)}
    </Button>
  );

  return (
    <div className="page">
      <PageHeader title={t(`parties.${kind}s.title`)} subtitle={t(`parties.${kind}s.subtitle`)} actions={newBtn} />
      <DataGrid
        id={`parties.${kind}`}
        rows={data?.rows}
        loading={isLoading}
        columns={columns}
        presets={presets}
        rowKey={(p) => p.id}
        onRowClick={(p) => navigate(`${base(kind)}/${p.id}`)}
        exportName={t(`parties.${kind}s.title`)}
        empty={<EmptyState icon={<Icon size={22} />} title={t('common.noResults')} action={newBtn} />}
      />
      <PartyDialog open={dialog} onClose={() => setDialog(false)} kind={kind} onSaved={(id) => navigate(`${base(kind)}/${id}`)} />
    </div>
  );
}

interface Statement {
  opening: number;
  closing: number;
  rows: { entry_id: number; number: string; date: string; memo: string | null; reference: string | null; source_type: string; source_id: number | null; debit: number; credit: number; balance: number }[];
}

function PartyView({ kind }: { kind: Kind }) {
  const { id } = useParams();
  const { t } = useI18n();
  const date = useDate();
  const { scale } = useMoney();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [dialog, setDialog] = useState(false);
  const { data: p, isLoading, error } = useApi<Party>(`/parties/${id}`);
  const { data: st } = useApi<Statement>(`/parties/${id}/statement`, { from, to });
  const del = useApiMutation(() => api.del(`/parties/${id}`));

  if (isLoading) return <Loading />;
  if (error || !p) return <ErrorBlock message={errText(error)} />;

  const isCustomer = kind === 'customer';
  const newDoc = isCustomer ? `/sales/invoices/new?party=${p.id}` : `/purchases/bills/new?party=${p.id}`;
  const newPay = isCustomer ? `/receipts/new?party=${p.id}&role=customer` : `/payments/new?party=${p.id}&role=supplier`;

  const exportCsv = () =>
    st &&
    downloadCsv(
      `statement-${p.code}-${from}-${to}`,
      [t('common.date'), t('common.number'), t('common.memo'), t('common.debit'), t('common.credit'), t('common.balance')],
      [
        [from, '', t('parties.opening'), '', '', csvMoney(st.opening, scale)],
        ...st.rows.map((r) => [r.date, r.number, r.memo ?? '', csvMoney(r.debit, scale), csvMoney(r.credit, scale), csvMoney(r.balance, scale)]),
      ],
    );

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: base(kind), label: t(`parties.${kind}s.title`) }]}
        title={p.name}
        badge={!p.is_active ? <Badge>{t('common.inactive')}</Badge> : <Badge tone="blue" plain>{p.code}</Badge>}
        subtitle={p.name_alt ?? undefined}
        actions={
          <>
            {can('parties.write') && (
              <>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  onClick={async () => {
                    if ((await confirm({ title: t('parties.deleteConfirm', { name: p.name }), body: t('common.cannotUndo'), danger: true, confirmLabel: t('common.delete') })).ok)
                      del.mutate(undefined, { onSuccess: () => (toast.success(t('common.deleted')), navigate(base(kind))), onError: (e) => toast.error(errText(e)) });
                  }}
                >
                  {t('common.delete')}
                </Button>
                <Button icon={<Pencil />} onClick={() => setDialog(true)}>
                  {t('parties.edit')}
                </Button>
              </>
            )}
            {can('payments.write') && (
              <Link to={newPay} className="btn">
                <Wallet /> {isCustomer ? t('payments.in.new') : t('payments.out.new')}
              </Link>
            )}
            {can(isCustomer ? 'sales.write' : 'purchases.write') && (
              <Link to={newDoc} className="btn btn-primary">
                <FilePlus /> {isCustomer ? t('docs.sales_invoice.new') : t('docs.purchase_bill.new')}
              </Link>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        <div className="grid-3">
          <Card className="kpi">
            <div className="kpi-label">{isCustomer ? t('parties.receivable') : t('parties.payable')}</div>
            <div className="kpi-value">
              <Money v={isCustomer ? p.receivable : p.payable} />
            </div>
            {p.credit_limit != null && isCustomer && (
              <div className="kpi-foot">
                {t('parties.creditLimit')}: <Money v={p.credit_limit} />
              </div>
            )}
          </Card>
          <Card pad className="span-2">
            <div className="stack" style={{ '--gap': '8px', fontSize: 13.5 } as React.CSSProperties}>
              {p.phone && (
                <span className="row muted">
                  <Phone size={15} /> <span dir="ltr">{p.phone}</span>
                </span>
              )}
              {p.email && (
                <span className="row muted">
                  <Mail size={15} /> {p.email}
                </span>
              )}
              {(p.address || p.city) && (
                <span className="row muted">
                  <MapPin size={15} /> {[p.address, p.city, p.country].filter(Boolean).join(', ')}
                </span>
              )}
              <span className="muted">
                {t('parties.terms')}: <strong style={{ color: 'var(--text)' }}>{p.payment_terms_days}</strong>
                {p.tax_number && (
                  <>
                    {' '}
                    · {t('common.taxNumber')}: <strong style={{ color: 'var(--text)' }}>{p.tax_number}</strong>
                  </>
                )}
              </span>
            </div>
          </Card>
        </div>

        <Card className="table-card">
          <CardHeader
            title={t('parties.statement')}
            actions={
              <div className="row wrap no-print">
                <Input type="date" sm value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
                <Input type="date" sm value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
                <Button size="sm" icon={<Download />} onClick={exportCsv}>
                  CSV
                </Button>
              </div>
            }
          />
          {!st ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.number')}</th>
                    <th>{t('common.memo')}</th>
                    <th className="end">{t('common.debit')}</th>
                    <th className="end">{t('common.credit')}</th>
                    <th className="end">{t('common.balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="group-row">
                    <td colSpan={5}>{t('parties.opening')}</td>
                    <td className="end">
                      <Money v={st.opening} />
                    </td>
                  </tr>
                  {st.rows.map((r, i) => {
                    const link = sourceLink(r.source_type, r.source_id) ?? `/journal/${r.entry_id}`;
                    return (
                      <tr key={i}>
                        <td className="nowrap">{date(r.date)}</td>
                        <td className="nowrap">
                          <Link to={link}>{r.reference?.split(' ')[0] || r.number}</Link>
                        </td>
                        <td className="muted">{t('journal.sources.' + r.source_type)}</td>
                        <td className="end">{r.debit ? <Money v={r.debit} /> : ''}</td>
                        <td className="end">{r.credit ? <Money v={r.credit} /> : ''}</td>
                        <td className="end">
                          <Money v={r.balance} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>{t('parties.closing')}</td>
                    <td className="end">
                      <Money v={st.closing} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      </div>
      <PartyDialog open={dialog} onClose={() => setDialog(false)} kind={kind} party={p} />
    </div>
  );
}

export const partiesModule: WebModule = {
  id: 'parties',
  nav: [
    { to: '/customers', label: 'nav.customers', icon: Users, section: 'sales', order: 30, perm: 'parties.read' },
    { to: '/suppliers', label: 'nav.suppliers', icon: Truck, section: 'purchases', order: 30, perm: 'parties.read' },
  ],
  routes: [
    { path: '/customers', element: <PartyList key="c" kind="customer" /> },
    { path: '/customers/:id', element: <PartyView key="cv" kind="customer" /> },
    { path: '/suppliers', element: <PartyList key="s" kind="supplier" /> },
    { path: '/suppliers/:id', element: <PartyView key="sv" kind="supplier" /> },
  ],
  commands: [
    { id: 'go-customers', label: 'nav.customers', icon: Users, group: 'navigate', to: '/customers', perm: 'parties.read', keywords: 'clients عملاء' },
    { id: 'go-suppliers', label: 'nav.suppliers', icon: Truck, group: 'navigate', to: '/suppliers', perm: 'parties.read', keywords: 'vendors موردين' },
  ],
};
