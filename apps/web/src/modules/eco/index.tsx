import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Network, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDateTime } from '../../core/format';
import { PageHeader, Loading } from '../../ui/Page';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, Field, Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';

const SCOPES = ['eco.feed.read', 'eco.inbox.write', 'eco.acks.write', 'eco.events.read'];

function Overview() {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const { data: company } = useApi<any>('/eco/company');
  const { data: s, refetch } = useApi<any>('/eco/status');
  const resync = useApiMutation(() => api.post<{ published: number }>('/eco/resync'));
  if (!company || !s) return <Loading />;
  return (
    <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      <Card pad>
        <dl className="kv">
          <dt>{t('eco.companyId')}</dt>
          <dd className="mono">{company.companyId}</dd>
          <dt>{t('eco.source')}</dt>
          <dd className="mono">{company.source}</dd>
          <dt>{t('eco.published')}</dt>
          <dd>{s.events} · #{s.head}</dd>
          <dt>{t('eco.received')}</dt>
          <dd>{s.received}</dd>
          <dt>{t('eco.parked')}</dt>
          <dd>{s.parked ? <Badge tone="red">{s.parked}</Badge> : <Badge tone="green">0</Badge>}</dd>
          <dt>{t('eco.rejected')}</dt>
          <dd>{s.rejected ? <Badge tone="amber">{s.rejected}</Badge> : <Badge tone="green">0</Badge>}</dd>
          <dt>{t('eco.publishes')}</dt>
          <dd className="mono">{s.types.join(', ')}</dd>
        </dl>
        <p className="faint" style={{ marginTop: 10 }}>{t('eco.companyHint')}</p>
        <div style={{ marginTop: 12 }}>
          <Button icon={<RefreshCw />} loading={resync.isPending} onClick={() => resync.mutate(undefined, { onSuccess: (r) => (toast.success(t('eco.resynced', { n: r.published })), refetch()), onError: (e) => toast.error(errText(e)) })}>
            {t('eco.resync')}
          </Button>
        </div>
      </Card>
      <Card className="table-card">
        <CardHeader title={t('eco.consumers')} />
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('eco.consumer')}</th>
                <th className="end">{t('eco.acks')}</th>
                <th>{t('eco.lastAck')}</th>
              </tr>
            </thead>
            <tbody>
              {s.consumers.map((c: any) => (
                <tr key={c.consumer}>
                  <td>{c.consumer}</td>
                  <td className="end">{c.n}</td>
                  <td>{c.last ? formatDateTime(c.last, 'en') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Keys() {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const { data, refetch } = useApi<any[]>('/eco/keys');
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['eco.feed.read']);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [err, setErr] = useState('');
  const create = useApiMutation((body: object) => api.post<{ name: string; key: string }>('/eco/keys', body));
  const revoke = useApiMutation((id: number) => api.post(`/eco/keys/${id}/revoke`));
  return (
    <Card className="table-card">
      <CardHeader title={t('eco.keys')} actions={<Button size="sm" icon={<Plus />} onClick={() => (setDialog(true), setErr(''), setName(''))}>{t('eco.newKey')}</Button>} />
      <p className="faint" style={{ padding: '0 16px 8px' }}>{t('eco.keysHint')}</p>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('eco.scopes')}</th>
              <th>{t('common.status')}</th>
              <th className="shrink" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((k) => (
              <tr key={k.id}>
                <td style={{ fontWeight: 550 }}>{k.name}</td>
                <td className="mono muted">{k.scopes.join(' ')}</td>
                <td>{k.active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge tone="red">{t('eco.revoked')}</Badge>}</td>
                <td>
                  {k.active ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Trash2 />}
                      title={t('eco.revoke')}
                      onClick={async () => {
                        if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('eco.revoke') })).ok) revoke.mutate(k.id, { onSuccess: () => refetch(), onError: (e) => toast.error(errText(e)) });
                      }}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title={t('eco.newKey')}
        footer={
          <>
            <Button onClick={() => setDialog(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!name || !scopes.length}
              onClick={() => create.mutate({ name, scopes }, { onSuccess: (r) => (setDialog(false), setCreated(r), refetch()), onError: (e) => setErr(errText(e)) })}
            >
              {t('eco.createKey')}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
          <Field label={t('common.name')} hint={t('eco.keyNameHint')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="gmes-plant-1" />
          </Field>
          {SCOPES.map((s) => (
            <Checkbox key={s} label={<span><span className="mono">{s}</span> — {t('eco.scopeText.' + s)}</span>} checked={scopes.includes(s)} onChange={(v) => setScopes(v ? [...scopes, s] : scopes.filter((x) => x !== s))} />
          ))}
          {err && <p className="danger-text">{err}</p>}
        </div>
      </Dialog>
      <Dialog open={!!created} onClose={() => setCreated(null)} title={t('eco.keyCreated', { name: created?.name ?? '' })} footer={<Button variant="primary" onClick={() => setCreated(null)}>{t('common.close')}</Button>}>
        <p className="muted">{t('eco.keyOnce')}</p>
        <p className="mono" style={{ userSelect: 'all', wordBreak: 'break-all', padding: 12, background: 'var(--bg-subtle)', borderRadius: 8 }}>{created?.key}</p>
      </Dialog>
    </Card>
  );
}

function Peers() {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const { data, refetch } = useApi<any[]>('/eco/peers');
  const [dialog, setDialog] = useState(false);
  const [f, setF] = useState({ name: '', url: 'http://', key: '', consumer: 'mizan', push: true, pull: false });
  const [err, setErr] = useState('');
  const add = useApiMutation((body: object) => api.post('/eco/peers', body));
  const sync = useApiMutation((id: number) => api.post<any>(`/eco/peers/${id}/sync`));
  const remove = useApiMutation((id: number) => api.del(`/eco/peers/${id}`));
  return (
    <Card className="table-card">
      <CardHeader title={t('eco.peers')} actions={<Button size="sm" icon={<Plus />} onClick={() => (setDialog(true), setErr(''))}>{t('eco.newPeer')}</Button>} />
      <p className="faint" style={{ padding: '0 16px 8px' }}>{t('eco.peersHint')}</p>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('eco.address')}</th>
              <th>{t('eco.direction')}</th>
              <th className="end">{t('eco.cursors')}</th>
              <th>{t('eco.lastSync')}</th>
              <th className="shrink" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 550 }}>{p.name}</td>
                <td className="mono muted">{p.url}</td>
                <td>{[p.push ? t('eco.push') : '', p.pull ? t('eco.pull') : ''].filter(Boolean).join(' + ')}</td>
                <td className="end mono">{p.push_cursor} / {p.pull_cursor}</td>
                <td>{p.last_error ? <Badge tone="red">{p.last_error}</Badge> : p.last_ok_at ? formatDateTime(p.last_ok_at, 'en') : '—'}</td>
                <td className="nowrap">
                  <Button size="sm" variant="ghost" iconOnly icon={<RefreshCw />} title={t('eco.syncNow')} loading={sync.isPending} onClick={() => sync.mutate(p.id, { onSuccess: (r) => (r.error ? toast.error(r.error) : toast.success(t('eco.synced', { pushed: r.pushed, parked: r.parked, applied: r.applied }))), onSettled: () => refetch() })} />
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 />}
                    onClick={async () => {
                      if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok) remove.mutate(p.id, { onSuccess: () => refetch(), onError: (e) => toast.error(errText(e)) });
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title={t('eco.newPeer')}
        footer={
          <>
            <Button onClick={() => setDialog(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={add.isPending} disabled={!f.name || !f.url || !f.key || !(f.push || f.pull)} onClick={() => add.mutate(f, { onSuccess: () => (setDialog(false), refetch()), onError: (e) => setErr(errText(e)) })}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ '--gap': '14px' } as React.CSSProperties}>
          <Field label={t('common.name')}>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="gmes-plant-1" />
          </Field>
          <Field label={t('eco.address')}>
            <Input dir="ltr" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          </Field>
          <Field label={t('eco.peerKey')} hint={t('eco.peerKeyHint')}>
            <Input dir="ltr" type="password" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={t('eco.consumerName')} hint={t('eco.consumerNameHint')}>
            <Input dir="ltr" value={f.consumer} onChange={(e) => setF({ ...f, consumer: e.target.value })} />
          </Field>
          <Checkbox label={t('eco.pushLabel')} checked={f.push} onChange={(v) => setF({ ...f, push: v })} />
          <Checkbox label={t('eco.pullLabel')} checked={f.pull} onChange={(v) => setF({ ...f, pull: v })} />
          {err && <p className="danger-text">{err}</p>}
        </div>
      </Dialog>
    </Card>
  );
}

function Events() {
  const { t } = useI18n();
  const [status, setStatus] = useState<string>('parked');
  const { data } = useApi<any[]>('/integration/events', { status: status || undefined, limit: 500 });
  const { data: inbox } = useApi<any>('/integration/inbox');
  return (
    <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
      <Card className="table-card">
        <CardHeader
          title={t('eco.events')}
          actions={
            <div className="row" style={{ gap: 6 }}>
              {['parked', 'pending', 'applied', 'skipped', ''].map((s) => (
                <Button key={s} size="sm" variant={status === s ? 'primary' : 'ghost'} onClick={() => setStatus(s)}>
                  {s ? t('eco.st.' + s) : t('common.all')}
                </Button>
              ))}
            </div>
          }
        />
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th className="end">#</th>
                <th>{t('common.type')}</th>
                <th>{t('eco.subject')}</th>
                <th>{t('eco.consumer')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.details')}</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((e, i) => (
                <tr key={`${e.id}-${e.consumer ?? i}`}>
                  <td className="end mono">{e.seq}</td>
                  <td className="mono">{e.type}</td>
                  <td className="mono muted">{e.subject}</td>
                  <td>{e.consumer ?? '—'}</td>
                  <td>{e.status ? <Badge tone={e.status === 'parked' ? 'red' : e.status === 'applied' ? 'green' : 'neutral'}>{t('eco.st.' + e.status)}</Badge> : <Badge>{t('eco.st.pending')}</Badge>}</td>
                  <td>{[e.code, e.message, e.target_ref].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {inbox?.rejected?.length > 0 && (
        <Card className="table-card">
          <CardHeader title={t('eco.refusedIncoming')} />
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t('eco.source')}</th>
                  <th>{t('common.type')}</th>
                  <th>{t('eco.code')}</th>
                  <th>{t('common.details')}</th>
                  <th className="end">{t('eco.attempts')}</th>
                </tr>
              </thead>
              <tbody>
                {inbox.rejected.map((r: any) => (
                  <tr key={`${r.source}-${r.event_id}`}>
                    <td className="mono muted">{r.source}</td>
                    <td className="mono">{r.type}</td>
                    <td className="mono">{r.code}</td>
                    <td>{r.message}</td>
                    <td className="end">{r.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

const TABS = [
  { id: 'overview', el: <Overview />, perm: 'eco.events.read' },
  { id: 'events', el: <Events />, perm: 'eco.events.read' },
  { id: 'keys', el: <Keys />, perm: 'eco.settings.manage' },
  { id: 'peers', el: <Peers />, perm: 'eco.settings.manage' },
];

function IntegrationPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const visible = TABS.filter((x) => can(x.perm));
  const tab = visible.find((x) => x.id === params.get('tab')) ?? visible[0];
  return (
    <div className="page">
      <PageHeader title={t('eco.title')} subtitle={t('eco.subtitle')} />
      <div className="tabs" role="tablist">
        {visible.map((x) => (
          <button key={x.id} className="tab" role="tab" aria-selected={tab?.id === x.id} onClick={() => setParams({ tab: x.id }, { replace: true })}>
            {t('eco.tabs.' + x.id)}
          </button>
        ))}
      </div>
      {tab?.el}
    </div>
  );
}

/** Integration with the other applications of the plant (manufacturing, HR, space planning): keys, peers, events. */
export const ecoModule: WebModule = {
  id: 'eco',
  nav: [{ to: '/integration', label: 'nav.integration', icon: Network, section: 'admin', order: 40, perm: 'eco.events.read', app: 'eco' }],
  routes: [{ path: '/integration', element: <IntegrationPage /> }],
  commands: [{ id: 'go-integration', label: 'nav.integration', icon: Network, group: 'navigate', to: '/integration', perm: 'eco.events.read', app: 'eco', keywords: 'integration gmes eco keys تكامل ربط' }],
};
