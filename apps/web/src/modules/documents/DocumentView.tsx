import { Link, useNavigate, useParams } from 'react-router';
import { Ban, BookOpen, FileMinus, Pencil, Printer, Send, Trash2, Wallet } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatBp, formatQty, todayIso } from '../../core/format';
import { DOC_BASE } from '../../core/links';
import type { DocKind, DocumentFull } from '../../core/types';
import { PageHeader, Loading, ErrorBlock } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { DocStatus } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { LogoMark } from '../../ui/Brand';
import { useConfirm } from '../../ui/Dialog';
import { useToast } from '../../ui/Toast';
import { KIND_UI } from './kinds';
import { useSlot } from '../../core/slots';

export function DocumentView({ kind }: { kind: DocKind }) {
  const { id } = useParams();
  const ui = KIND_UI[kind];
  const { t, locale } = useI18n();
  const date = useDate();
  const { fmt } = useMoney();
  const { can, company } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: d, isLoading, error } = useApi<DocumentFull>(`/documents/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const panels = useSlot('document.view');

  if (isLoading) return <Loading />;
  if (error || !d) return <ErrorBlock message={errText(error)} />;

  const outstanding = d.total - d.amount_settled;
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) =>
    act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });

  const post = async () => {
    if ((await confirm({ title: t('common.post'), body: t('docs.postConfirm'), confirmLabel: t('common.post') })).ok) {
      run(() => api.post(`/documents/${d.id}/post`), t('common.posted'));
    }
  };
  const voidDoc = async () => {
    const r = await confirm({
      title: t('docs.voidTitle'),
      body: t('docs.voidText'),
      danger: true,
      confirmLabel: t('common.void'),
      withDate: { label: t('common.date'), value: d.date },
    });
    if (r.ok) run(() => api.post(`/documents/${d.id}/void`, { date: r.date || null }), t('common.voided'));
  };
  const remove = async () => {
    if ((await confirm({ title: t('common.areYouSure'), body: t('common.cannotUndo'), danger: true, confirmLabel: t('common.delete') })).ok) {
      run(() => api.del(`/documents/${d.id}`), t('common.deleted'), () => navigate(ui.base));
    }
  };

  // Money in settles invoices and supplier debit notes; money out settles bills and customer credit notes.
  const payBase = kind === 'sales_invoice' || kind === 'purchase_credit' ? '/receipts' : '/payments';
  const creditBase = kind === 'sales_invoice' ? DOC_BASE.sales_credit : DOC_BASE.purchase_credit;
  const role = ui.partyKind;
  const overdueDays = d.status === 'posted' && outstanding > 0 ? Math.round((Date.parse(todayIso()) - Date.parse(d.due_date)) / 86_400_000) : 0;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: ui.base, label: t(`docs.${kind}.title`) }]}
        title={d.number ?? `${t(`docs.${kind}.one`)} · ${t('status.draft')}`}
        badge={<DocStatus status={d.status} total={d.total} settled={d.amount_settled} due={d.due_date} />}
        subtitle={`${d.party.name} · ${date(d.date, 'long')}`}
        actions={
          <>
            <Button icon={<Printer />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
            {d.status === 'draft' && can(`${ui.side}.write`) && (
              <>
                <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                  {t('common.delete')}
                </Button>
                <Link to={`${ui.base}/${d.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {d.status === 'draft' && can(`${ui.side}.post`) && (
              <Button variant="primary" icon={<Send className="flip-rtl" />} onClick={post} loading={act.isPending}>
                {t('common.post')}
              </Button>
            )}
            {d.status === 'posted' && can(`${ui.side}.post`) && (
              <Button variant="danger" icon={<Ban />} onClick={voidDoc} loading={act.isPending}>
                {t('common.void')}
              </Button>
            )}
            {d.status === 'posted' && ui.creditOf === undefined && can(`${ui.side}.write`) && (
              <Link to={`${creditBase}/new?party=${d.party_id}&against=${d.id}`} className="btn">
                <FileMinus /> {t(kind === 'sales_invoice' ? 'docs.sales_credit.new' : 'docs.purchase_credit.new')}
              </Link>
            )}
            {d.status === 'posted' && outstanding > 0 && can('payments.write') && (
              <Link to={`${payBase}/new?party=${d.party_id}&role=${role}&doc=${d.id}`} className="btn btn-primary">
                <Wallet /> {t('docs.recordPayment')}
              </Link>
            )}
          </>
        }
      />

      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {overdueDays > 0 && (
          <div className="notice danger no-print">
            <Ban />
            <div>{t('docs.daysOverdue', { n: overdueDays })}</div>
          </div>
        )}

        <Card className="doc-paper">
          <div className="doc-head">
            <div>
              <div className="row" style={{ gap: 10 }}>
                <LogoMark size={30} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 17 }}>{company?.legalName || company?.name}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {[company?.address, company?.phone, company?.email].filter(Boolean).join(' · ')}
                  </div>
                  {company?.taxNumber && (
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {t('common.taxNumber')}: {company.taxNumber}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'end' }}>
              <div className="doc-title">{t(`docs.${kind}.one`)}</div>
              <div className="num" style={{ fontWeight: 650, fontSize: 16 }}>
                {d.number ?? t('status.draft')}
              </div>
            </div>
          </div>

          <div className="doc-meta">
            <div>
              <div className="label">{ui.side === 'sales' ? t('docs.billTo') : t('docs.from')}</div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{d.party.name}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {[d.party.address, d.party.city, d.party.country].filter(Boolean).join(', ')}
              </div>
              {d.party.tax_number && (
                <div className="muted" style={{ fontSize: 13 }}>
                  {t('common.taxNumber')}: {d.party.tax_number}
                </div>
              )}
            </div>
            <dl className="dl">
              <dt>{t('common.date')}</dt>
              <dd>{date(d.date)}</dd>
              <dt>{t('common.dueDate')}</dt>
              <dd>{date(d.due_date)}</dd>
              {d.reference && (
                <>
                  <dt>{t('common.reference')}</dt>
                  <dd>{d.reference}</dd>
                </>
              )}
              {d.against_number && (
                <>
                  <dt>{t('docs.against')}</dt>
                  <dd>
                    <Link to={`${DOC_BASE[ui.creditOf!]}/${d.against_document_id}`}>{d.against_number}</Link>
                  </dd>
                </>
              )}
            </dl>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink">#</th>
                  <th>{t('common.description')}</th>
                  <th className="end">{t('docs.qty')}</th>
                  <th className="end">{t('docs.price')}</th>
                  <th className="end">{t('docs.discount')}</th>
                  <th className="end">{t('docs.tax')}</th>
                  <th className="end">{t('docs.lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>
                      {l.description}
                      {l.item_sku && (
                        <span className="faint" style={{ fontSize: 12, marginInline: 8, unicodeBidi: 'isolate' }}>
                          {l.item_sku}
                        </span>
                      )}
                    </td>
                    <td className="end num">{formatQty(l.quantity, locale)}</td>
                    <td className="end">
                      <Money v={l.unit_price} />
                    </td>
                    <td className="end muted">{l.discount_bp ? formatBp(l.discount_bp) : '—'}</td>
                    <td className="end muted">{l.tax_id ? formatBp(l.tax_rate_bp) : '—'}</td>
                    <td className="end">
                      <Money v={d.tax_inclusive ? l.total : l.net} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="doc-bottom" style={{ padding: 20 }}>
            <div>
              {d.notes && (
                <>
                  <div className="label">{t('common.notes')}</div>
                  <p style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{d.notes}</p>
                </>
              )}
            </div>
            <div className="totals">
              <span className="t-label">{t('common.subtotal')}</span>
              <span className="t-value">{fmt(d.subtotal)}</span>
              {d.discount_total > 0 && (
                <>
                  <span className="t-label">{t('docs.discountTotal')}</span>
                  <span className="t-value">{fmt(-d.discount_total)}</span>
                </>
              )}
              <span className="t-label">{t('docs.taxTotal')}</span>
              <span className="t-value">{fmt(d.tax_total)}</span>
              <span className="t-label t-grand">
                {t('common.total')} <span className="faint" style={{ fontSize: 12 }}>{d.currency}</span>
              </span>
              <span className="t-value t-grand">{fmt(d.total)}</span>
              {d.status === 'posted' && (
                <>
                  <span className="t-label">{t('docs.paid')}</span>
                  <span className="t-value">{fmt(d.amount_settled)}</span>
                  <span className="t-label" style={{ fontWeight: 650, color: 'var(--text)' }}>
                    {t('docs.outstanding')}
                  </span>
                  <span className="t-value" style={{ fontWeight: 700 }}>
                    {fmt(outstanding)}
                  </span>
                </>
              )}
            </div>
          </div>
        </Card>

        <div className="grid-2 no-print">
          {(d.settlements.length > 0 || d.applied.length > 0) && (
            <Card>
              <CardHeader title={d.applied.length ? t('docs.appliedTo') : t('docs.settlements')} />
              <table className="table table-compact">
                <tbody>
                  {d.settlements.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={s.source_type === 'credit' ? `${creditBase}/${s.source_id}` : `${payBase}/${s.source_id}`}>
                          {s.source_number}
                        </Link>
                      </td>
                      <td className="muted">{date(s.date)}</td>
                      <td className="end">
                        <Money v={s.amount} />
                      </td>
                    </tr>
                  ))}
                  {d.applied.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`${DOC_BASE[ui.creditOf!]}/${s.document_id}`}>{s.number}</Link>
                      </td>
                      <td className="muted">{date(s.date)}</td>
                      <td className="end">
                        <Money v={s.amount} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          {d.journal_entry_id && (
            <Card>
              <CardHeader title={t('common.journalEntry')} icon={<BookOpen size={18} className="muted" />} />
              <div className="card-body stack" style={{ '--gap': '6px' } as React.CSSProperties}>
                <Link to={`/journal/${d.journal_entry_id}`} style={{ fontWeight: 550 }}>
                  {d.journal_number}
                </Link>
                {d.void_entry_id && (
                  <Link to={`/journal/${d.void_entry_id}`} className="danger-text">
                    {t('status.void')}: {d.void_journal_number}
                  </Link>
                )}
              </div>
            </Card>
          )}
        </div>
        {panels.map((Panel, i) => (
          <Panel key={i} documentId={d.id} kind={d.kind} status={d.status} />
        ))}
      </div>
    </div>
  );
}
