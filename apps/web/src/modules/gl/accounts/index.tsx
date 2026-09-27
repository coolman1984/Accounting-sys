import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronDown, ChevronRight, FolderTree, ListTree, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { WebModule } from '../../../core/registry';
import { useApiMutation, useErrorText } from '../../../core/hooks';
import { useI18n } from '../../../core/i18n';
import { useSession } from '../../../core/session';
import { api } from '../../../core/api';
import type { Account, AccountType } from '../../../core/types';
import { PageHeader, Loading } from '../../../ui/Page';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Badge } from '../../../ui/Badge';
import { Money } from '../../../ui/Money';
import { useAccounts } from '../../../ui/Pickers';
import { useConfirm } from '../../../ui/Dialog';
import { useToast } from '../../../ui/Toast';
import { AccountDialog } from './AccountDialog';

const TYPES: (AccountType | 'all')[] = ['all', 'asset', 'liability', 'equity', 'income', 'expense'];

function ChartPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data, isLoading } = useAccounts();
  const [type, setType] = useState<AccountType | 'all'>('all');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<{ account?: Account | null; parent?: Account | null } | null>(null);
  const del = useApiMutation((id: number) => api.del(`/accounts/${id}`));
  const writable = can('gl.accounts.write');

  const rows = useMemo(() => {
    const list = data ?? [];
    const byId = new Map(list.map((a) => [a.id, a]));
    const hidden = (a: Account): boolean => {
      let p = a.parent_id;
      while (p) {
        if (collapsed.has(p)) return true;
        p = byId.get(p)?.parent_id ?? null;
      }
      return false;
    };
    const s = q.trim().toLowerCase();
    // Tree order: walk from roots, children sorted by code.
    const children = new Map<number | null, Account[]>();
    for (const a of list) children.set(a.parent_id, [...(children.get(a.parent_id) ?? []), a]);
    const ordered: Account[] = [];
    const walk = (pid: number | null) => {
      for (const a of (children.get(pid) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
        ordered.push(a);
        walk(a.id);
      }
    };
    walk(null);
    return ordered.filter(
      (a) =>
        (type === 'all' || a.type === type) &&
        (s ? `${a.code} ${a.name_en} ${a.name_ar}`.toLowerCase().includes(s) : !hidden(a)),
    );
  }, [data, type, q, collapsed]);

  const parents = useMemo(() => new Set((data ?? []).map((a) => a.parent_id).filter((x): x is number => x != null)), [data]);

  const toggle = (id: number) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const remove = async (a: Account) => {
    const { ok } = await confirm({ title: t('accounts.deleteConfirm', { code: a.code }), body: t('common.cannotUndo'), danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;
    del.mutate(a.id, { onSuccess: () => toast.success(t('common.deleted')), onError: (e) => toast.error(errText(e)) });
  };

  return (
    <div className="page">
      <PageHeader
        title={t('accounts.title')}
        subtitle={t('accounts.subtitle')}
        actions={
          writable && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({})}>
              {t('accounts.new')}
            </Button>
          )
        }
      />
      <div className="toolbar">
        <div className="input-group">
          <Search />
          <input className="input" placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="segmented">
          {TYPES.map((ty) => (
            <button key={ty} aria-pressed={type === ty} onClick={() => setType(ty)}>
              {ty === 'all' ? t('common.all') : t('accountTypes.' + ty)}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <Button size="sm" variant="ghost" icon={<ListTree />} onClick={() => setCollapsed(new Set())}>
          {t('accounts.expandAll')}
        </Button>
        <Button size="sm" variant="ghost" icon={<FolderTree />} onClick={() => setCollapsed(new Set((data ?? []).filter((a) => a.is_group).map((a) => a.id)))}>
          {t('accounts.collapseAll')}
        </Button>
      </div>
      <Card className="table-card">
        {isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '48%' }}>{t('common.account')}</th>
                  <th>{t('accounts.subtype')}</th>
                  <th className="end">{t('common.balance')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.is_group ? 'group-row' : ''} style={{ opacity: a.is_active ? 1 : 0.55 }}>
                    <td>
                      <div className="row" style={{ paddingInlineStart: q ? 0 : a.depth * 22, gap: 6 }}>
                        {a.is_group ? (
                          <button className="btn btn-ghost btn-sm btn-icon" style={{ '--h': '24px' } as React.CSSProperties} onClick={() => toggle(a.id)}>
                            {collapsed.has(a.id) ? <ChevronRight className="flip-rtl" /> : <ChevronDown />}
                          </button>
                        ) : (
                          <span style={{ width: 24 }} />
                        )}
                        <span className="num faint" style={{ minWidth: 44 }}>
                          {a.code}
                        </span>
                        <button
                          className="btn-link"
                          style={{ all: 'unset', cursor: 'pointer' }}
                          onClick={() => navigate(`/reports/general-ledger?accountId=${a.id}`)}
                        >
                          {pick(a.name_en, a.name_ar)}
                        </button>
                        {!a.is_active && <Badge>{t('common.inactive')}</Badge>}
                      </div>
                    </td>
                    <td className="muted">{a.is_group ? t('accounts.group') : t('subtypes.' + a.subtype)}</td>
                    <td className="end">
                      <Money v={a.balance} dashZero tone />
                    </td>
                    <td className="shrink">
                      {writable && (
                        <div className="row" style={{ gap: 2 }}>
                          {!!a.is_group && (
                            <Button size="sm" variant="ghost" iconOnly icon={<Plus />} title={t('accounts.new')} onClick={() => setDialog({ parent: a })} />
                          )}
                          <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} title={t('common.edit')} onClick={() => setDialog({ account: a })} />
                          {!a.has_postings && !parents.has(a.id) && (
                            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} title={t('common.delete')} onClick={() => remove(a)} />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <AccountDialog open={!!dialog} onClose={() => setDialog(null)} account={dialog?.account} parent={dialog?.parent} />
    </div>
  );
}

export const accountsModule: WebModule = {
  id: 'accounts',
  nav: [{ to: '/accounts', label: 'nav.chartOfAccounts', icon: ListTree, section: 'gl', order: 10, perm: 'gl.accounts.read' }],
  routes: [{ path: '/accounts', element: <ChartPage /> }],
  commands: [{ id: 'go-accounts', label: 'nav.chartOfAccounts', icon: ListTree, group: 'navigate', to: '/accounts', perm: 'gl.accounts.read', keywords: 'coa chart دليل حسابات' }],
};
