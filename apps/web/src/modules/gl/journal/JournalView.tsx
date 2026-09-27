import { Link, useNavigate, useParams } from 'react-router';
import { ExternalLink, Pencil, Send, Trash2, Undo2 } from 'lucide-react';
import { useApi, useApiMutation, useDate, useErrorText } from '../../../core/hooks';
import { useI18n } from '../../../core/i18n';
import { useSession } from '../../../core/session';
import { api } from '../../../core/api';
import { sourceLink } from '../../../core/links';
import { todayIso } from '../../../core/format';
import type { JournalEntry } from '../../../core/types';
import { PageHeader, Loading, ErrorBlock } from '../../../ui/Page';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { EntryStatus } from '../../../ui/Badge';
import { Money } from '../../../ui/Money';
import { useConfirm } from '../../../ui/Dialog';
import { useToast } from '../../../ui/Toast';

export function JournalView() {
  const { id } = useParams();
  const { t, pick } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: e, isLoading, error } = useApi<JournalEntry>(`/journal/${id}`);
  const { data: reversal } = useApi<JournalEntry>(e?.reversed_by_id ? `/journal/${e.reversed_by_id}` : null);
  const { data: original } = useApi<JournalEntry>(e?.reversal_of_id ? `/journal/${e.reversal_of_id}` : null);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());

  if (isLoading) return <Loading />;
  if (error || !e) return <ErrorBlock message={errText(error)} />;

  const manual = e.source_type === 'manual' || e.source_type === 'opening';
  const src = sourceLink(e.source_type, e.source_id);
  const run = (fn: () => Promise<unknown>, msg: string, after?: (r: unknown) => void) =>
    act.mutate(fn, { onSuccess: (r) => (toast.success(msg), after?.(r)), onError: (x) => toast.error(errText(x)) });

  const post = async () => {
    if ((await confirm({ title: t('common.post'), body: t('journal.postConfirm'), confirmLabel: t('common.post') })).ok) {
      run(() => api.post(`/journal/${e.id}/post`), t('common.posted'));
    }
  };
  const reverse = async () => {
    const r = await confirm({
      title: t('journal.reverseTitle'),
      body: t('journal.reverseText'),
      confirmLabel: t('common.reverse'),
      danger: true,
      withDate: { label: t('common.date'), value: e.date >= todayIso() ? e.date : todayIso() },
    });
    if (r.ok) run(() => api.post<{ id: number }>(`/journal/${e.id}/reverse`, { date: r.date }), t('common.posted'), (x) => navigate(`/journal/${(x as { id: number }).id}`));
  };
  const remove = async () => {
    if ((await confirm({ title: t('common.areYouSure'), body: t('common.cannotUndo'), danger: true, confirmLabel: t('common.delete') })).ok) {
      run(() => api.del(`/journal/${e.id}`), t('common.deleted'), () => navigate('/journal'));
    }
  };

  const totalD = e.lines.reduce((s, l) => s + l.debit, 0);
  const totalC = e.lines.reduce((s, l) => s + l.credit, 0);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/journal', label: t('journal.title') }]}
        title={e.number ?? t('journal.draftTitle')}
        badge={<EntryStatus status={e.status} reversed={!!e.reversed_by_id} reversal={!!e.reversal_of_id} />}
        subtitle={`${date(e.date, 'long')} · ${t('journal.sources.' + e.source_type)}`}
        actions={
          <>
            {src && (
              <Link to={src} className="btn">
                <ExternalLink /> {t('common.source')}
              </Link>
            )}
            {e.status === 'draft' && manual && can('gl.journal.write') && (
              <>
                <Button variant="danger" icon={<Trash2 />} onClick={remove}>
                  {t('common.delete')}
                </Button>
                <Link to={`/journal/${e.id}/edit`} className="btn">
                  <Pencil /> {t('common.edit')}
                </Link>
              </>
            )}
            {e.status === 'draft' && manual && can('gl.journal.post') && (
              <Button variant="primary" icon={<Send className="flip-rtl" />} onClick={post} loading={act.isPending}>
                {t('common.post')}
              </Button>
            )}
            {e.status === 'posted' && manual && !e.reversed_by_id && !e.reversal_of_id && can('gl.journal.post') && (
              <Button icon={<Undo2 />} onClick={reverse} loading={act.isPending}>
                {t('common.reverse')}
              </Button>
            )}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {(reversal || original) && (
          <div className="notice warn">
            <Undo2 />
            <div>
              {reversal && (
                <Link to={`/journal/${reversal.id}`}>{t('journal.reversedBy', { number: reversal.number })}</Link>
              )}
              {original && <Link to={`/journal/${original.id}`}>{t('journal.reversalOf', { number: original.number })}</Link>}
            </div>
          </div>
        )}
        <Card pad>
          <dl className="dl">
            <dt>{t('common.reference')}</dt>
            <dd>{e.reference || '—'}</dd>
            <dt>{t('common.memo')}</dt>
            <dd>{e.memo || '—'}</dd>
          </dl>
        </Card>
        <Card className="table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="shrink">#</th>
                  <th>{t('common.account')}</th>
                  <th>{t('common.description')}</th>
                  <th className="end">{t('common.debit')}</th>
                  <th className="end">{t('common.credit')}</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="faint">{l.line_no}</td>
                    <td>
                      <Link to={`/reports/general-ledger?accountId=${l.account_id}`}>
                        <span className="num faint" style={{ marginInlineEnd: 8 }}>
                          {l.account_code}
                        </span>
                        {pick(l.account_name_en, l.account_name_ar)}
                      </Link>
                      {l.party_name && <div className="muted" style={{ fontSize: 12.5 }}>{l.party_name}</div>}
                    </td>
                    <td className="muted">{l.description}</td>
                    <td className="end">{l.debit ? <Money v={l.debit} /> : ''}</td>
                    <td className="end">{l.credit ? <Money v={l.credit} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td colSpan={2}>{t('common.total')}</td>
                  <td className="end">
                    <Money v={totalD} />
                  </td>
                  <td className="end">
                    <Money v={totalC} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
