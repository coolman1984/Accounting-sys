import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useApi, useApiMutation, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDateTime } from '../../core/format';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, Field, Input, Select, Textarea } from '../../ui/Field';
import { useToast } from '../../ui/Toast';

// ---------------------------------------------------------------- data
interface Role {
  id: number;
  key: string | null;
  name: string;
  description: string | null;
  builtin: boolean;
  permissions: string[];
  users: number;
}
interface UserRow {
  id: number;
  username: string;
  display_name: string;
  locale: string;
  is_active: number;
  last_login_at: string | null;
  role_ids: number[];
  permissions: string[];
}
interface Catalogue {
  modules: { id: string; apps: string[]; permissions: string[] }[];
  templates: { id: string; module: string; permissions: string[] }[];
  sod: [string, string][];
}

const ACTIONS = ['read', 'write', 'post', 'approve', 'manage', 'override'] as const;

/** "ar.invoices.post" → { object: "ar.invoices", action: "post" } */
const split = (key: string) => {
  const i = key.lastIndexOf('.');
  return { object: key.slice(0, i), action: key.slice(i + 1) };
};

/** Readable names: built-in roles are translated, custom ones keep their name. */
function useRoleName() {
  const { t } = useI18n();
  return (r: Pick<Role, 'key' | 'name'>) => (r.key ? t(`roles.builtin.${r.key}.name`) : r.name);
}

/** Conflicting pairs (segregation of duties) a set of permissions contains. */
function conflicts(perms: Set<string>, sod: [string, string][]) {
  return sod.filter(([a, b]) => perms.has(a) && perms.has(b));
}

// ---------------------------------------------------------------- page
export function AccessPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  return (
    <div className="page">
      <PageHeader title={t('access.title')} subtitle={t('access.subtitle')} />
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')}>
          {t('access.users')}
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'roles'} onClick={() => setTab('roles')}>
          {t('access.roles')}
        </button>
      </div>
      {tab === 'users' ? <UsersPanel /> : <RolesPanel />}
    </div>
  );
}

// ---------------------------------------------------------------- users
function UsersPanel() {
  const { t, locale } = useI18n();
  const roleName = useRoleName();
  const { data: users, isLoading } = useApi<UserRow[]>('/users');
  const { data: roles } = useApi<Role[]>('/roles');
  const { data: cat } = useApi<Catalogue>('/permissions');
  const [dialog, setDialog] = useState<{ user: UserRow | null } | null>(null);
  const [pwdFor, setPwdFor] = useState<UserRow | null>(null);
  const byId = new Map((roles ?? []).map((r) => [r.id, r]));
  return (
    <Card className="table-card">
      <CardHeader
        title={t('access.users')}
        sub={t('access.usersHint')}
        actions={
          <Button size="sm" variant="primary" icon={<UserPlus />} onClick={() => setDialog({ user: null })}>
            {t('settings.newUser')}
          </Button>
        }
      />
      {isLoading || !users ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('access.roles')}</th>
                <th className="end">{t('access.rights')}</th>
                <th>{t('settings.lastLogin')}</th>
                <th>{t('common.status')}</th>
                <th className="shrink" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isAdmin = u.role_ids.some((id) => byId.get(id)?.key === 'admin');
                const sod = cat && !isAdmin ? conflicts(new Set(u.permissions), cat.sod) : [];
                return (
                  <tr key={u.id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{u.display_name}</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        @{u.username}
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {u.role_ids.map((id) => {
                          const r = byId.get(id);
                          return r ? (
                            <Badge key={id} tone={r.key === 'admin' ? 'blue' : r.builtin ? 'cyan' : 'neutral'} plain>
                              {roleName(r)}
                            </Badge>
                          ) : null;
                        })}
                        {!u.role_ids.length && <span className="faint">{t('access.noRole')}</span>}
                      </div>
                      {sod.length > 0 && (
                        <div className="row warning-text" style={{ gap: 4, fontSize: 12, marginTop: 4 }} title={sod.map(([a, b]) => `${a} + ${b}`).join('\n')}>
                          <AlertTriangle size={12} /> {t('access.sodCount', { n: sod.length })}
                        </div>
                      )}
                    </td>
                    <td className="end num muted">{u.permissions.length}</td>
                    <td className="muted">{u.last_login_at ? formatDateTime(u.last_login_at, locale) : '—'}</td>
                    <td>{u.is_active ? <Badge tone="green">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                    <td>
                      <div className="row" style={{ gap: 2 }}>
                        <Button size="sm" variant="ghost" iconOnly icon={<KeyRound />} title={t('settings.resetPassword')} onClick={() => setPwdFor(u)} />
                        <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} title={t('common.edit')} onClick={() => setDialog({ user: u })} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <UserDialog open={!!dialog} user={dialog?.user ?? null} roles={roles ?? []} cat={cat} onClose={() => setDialog(null)} />
      <ResetPasswordDialog user={pwdFor} onClose={() => setPwdFor(null)} />
    </Card>
  );
}

function UserDialog({ open, user, roles, cat, onClose }: { open: boolean; user: UserRow | null; roles: Role[]; cat?: Catalogue; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const roleName = useRoleName();
  const [f, setF] = useState({ username: '', displayName: '', locale: 'ar', isActive: true, password: '', roleIds: [] as number[] });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    const accountant = roles.find((r) => r.key === 'accountant')?.id;
    setF(
      user
        ? { username: user.username, displayName: user.display_name, locale: user.locale, isActive: !!user.is_active, password: '', roleIds: user.role_ids }
        : { username: '', displayName: '', locale: 'ar', isActive: true, password: '', roleIds: accountant ? [accountant] : [] },
    );
  }, [open, user, roles]);
  const save = useApiMutation(() => {
    const { password, ...rest } = f;
    return user ? api.put(`/users/${user.id}`, rest) : api.post('/users', { ...rest, password });
  });
  // What the chosen roles add up to, and any duty that should be split between two people.
  const perms = new Set(roles.filter((r) => f.roleIds.includes(r.id)).flatMap((r) => r.permissions));
  // An administrator holds everything by design — warning them adds noise, not safety.
  const isAdmin = roles.some((r) => r.key === 'admin' && f.roleIds.includes(r.id));
  const sod = cat && !isAdmin ? conflicts(perms, cat.sod) : [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={user ? t('settings.editUser') : t('settings.newUser')}
      footer={
        <>
          <span className="muted" style={{ marginInlineEnd: 'auto', fontSize: 13 }}>
            {t('access.rightsCount', { n: perms.size })}
          </span>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.username || !f.displayName || (!user && f.password.length < 8)}
            onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('setup.adminName')}>
            <Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
          </Field>
          <Field label={t('auth.username')}>
            <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} dir="ltr" />
          </Field>
        </div>
        <div className="grid-2">
          {!user && (
            <Field label={t('auth.password')} hint={t('setup.adminPasswordHint')}>
              <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
            </Field>
          )}
          <Field label={t('setup.language')}>
            <Select value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value })}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </div>
        <Field label={t('access.roles')} hint={t('access.rolesHint')}>
          <div className="role-pick">
            {roles.map((r) => (
              <label key={r.id} className={`role-option ${f.roleIds.includes(r.id) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={f.roleIds.includes(r.id)}
                  onChange={(e) => setF({ ...f, roleIds: e.target.checked ? [...f.roleIds, r.id] : f.roleIds.filter((x) => x !== r.id) })}
                />
                <span style={{ minWidth: 0 }}>
                  <strong>{roleName(r)}</strong>
                  <span className="faint">{r.key ? t(`roles.builtin.${r.key}.hint`) : r.description ?? t('access.permCount', { n: r.permissions.length })}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {sod.length > 0 && (
          <div className="notice warn">
            <AlertTriangle />
            <div>
              <strong>{t('access.sodTitle')}</strong>
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
                {sod.map(([a, b]) => (
                  <li key={a + b}>
                    <PermLabel k={a} /> + <PermLabel k={b} />
                  </li>
                ))}
              </ul>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {t('access.sodHint')}
              </div>
            </div>
          </div>
        )}
        <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function PermLabel({ k }: { k: string }) {
  const { t } = useI18n();
  const { object, action } = split(k);
  return (
    <span>
      {t(`perms.objects.${object}`)} · {t(`perms.actions.${action}`)}
    </span>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserRow | null; onClose(): void }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const [pw, setPw] = useState('');
  useEffect(() => setPw(''), [user]);
  const save = useApiMutation(() => api.post(`/users/${user!.id}/password`, { password: pw }));
  return (
    <Dialog
      open={!!user}
      onClose={onClose}
      title={`${t('settings.resetPassword')} · ${user?.display_name ?? ''}`}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={pw.length < 8}
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('auth.passwordChanged')), onClose()), onError: (e) => toast.error(errText(e)) })}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('auth.newPassword')} hint={t('setup.adminPasswordHint')}>
        <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- roles
function RolesPanel() {
  const { t } = useI18n();
  const roleName = useRoleName();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: roles, isLoading } = useApi<Role[]>('/roles');
  const { data: cat } = useApi<Catalogue>('/permissions');
  const [editing, setEditing] = useState<{ role: Role | null; seed?: { name: string; permissions: string[] } } | null>(null);
  const [template, setTemplate] = useState('');
  const del = useApiMutation((id: number) => api.del(`/roles/${id}`));

  return (
    <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
      <Card className="table-card">
        <CardHeader
          title={t('access.roles')}
          sub={t('access.rolesSub')}
          actions={
            <div className="row" style={{ gap: 8 }}>
              {cat && cat.templates.length > 0 && (
                <Select
                  value={template}
                  onChange={(e) => {
                    const tpl = cat.templates.find((x) => x.id === e.target.value);
                    setTemplate('');
                    if (tpl) setEditing({ role: null, seed: { name: t(`roles.templates.${tpl.id}`), permissions: tpl.permissions } });
                  }}
                  style={{ width: 'auto' }}
                >
                  <option value="">{t('access.fromTemplate')}</option>
                  {cat.templates.map((x) => (
                    <option key={x.id} value={x.id}>
                      {t(`roles.templates.${x.id}`)}
                    </option>
                  ))}
                </Select>
              )}
              <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setEditing({ role: null })}>
                {t('access.newRole')}
              </Button>
            </div>
          }
        />
        {isLoading || !roles ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th className="end">{t('access.rights')}</th>
                  <th className="end">{t('access.users')}</th>
                  <th className="shrink" />
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setEditing({ role: r })}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <ShieldCheck size={16} className={r.builtin ? 'muted' : ''} style={r.builtin ? undefined : { color: 'var(--primary)' }} />
                        <span style={{ fontWeight: 550 }}>{roleName(r)}</span>
                        {r.builtin && <Badge plain>{t('access.builtin')}</Badge>}
                      </div>
                      <div className="faint" style={{ fontSize: 12, marginInlineStart: 24 }}>
                        {r.key ? t(`roles.builtin.${r.key}.hint`) : r.description}
                      </div>
                    </td>
                    <td className="end num">{r.permissions.length}</td>
                    <td className="end num">{r.users}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="row" style={{ gap: 2 }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon={<Copy />}
                          title={t('access.copy')}
                          onClick={() => setEditing({ role: null, seed: { name: `${roleName(r)} (${t('access.copySuffix')})`, permissions: r.permissions } })}
                        />
                        {!r.builtin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon={<Trash2 />}
                            title={t('common.delete')}
                            onClick={async () => {
                              if ((await confirm({ title: t('access.deleteRole', { name: r.name }), body: t('access.deleteRoleText', { n: r.users }), danger: true, confirmLabel: t('common.delete') })).ok)
                                del.mutate(r.id, { onSuccess: () => toast.success(t('common.deleted')), onError: (e) => toast.error(errText(e)) });
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && cat && <RoleEditor role={editing.role} seed={editing.seed} cat={cat} onClose={() => setEditing(null)} />}
    </div>
  );
}

/**
 * The role editor: modules as sections, pages as rows, actions as columns —
 * the owner thinks in screens ("may post invoices"), not in keys.
 */
function RoleEditor({ role, seed, cat, onClose }: { role: Role | null; seed?: { name: string; permissions: string[] }; cat: Catalogue; onClose(): void }) {
  const { t } = useI18n();
  const { hasApp } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const roleName = useRoleName();
  const readOnly = !!role?.builtin;
  const [name, setName] = useState(role ? roleName(role) : seed?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? seed?.permissions ?? []));
  const [err, setErr] = useState('');
  const save = useApiMutation(() => {
    const body = { name, description: description || null, permissions: [...perms] };
    return role ? api.put(`/roles/${role.id}`, body) : api.post('/roles', body);
  });

  // module → object → actions present
  const sections = useMemo(
    () =>
      cat.modules.map((m) => {
        const objects = new Map<string, Set<string>>();
        for (const k of m.permissions) {
          const { object, action } = split(k);
          if (!objects.has(object)) objects.set(object, new Set());
          objects.get(object)!.add(action);
        }
        return { module: m, objects: [...objects.entries()] };
      }),
    [cat],
  );
  const toggle = (keys: string[], on: boolean) =>
    setPerms((p) => {
      const n = new Set(p);
      for (const k of keys) {
        if (on) n.add(k);
        else n.delete(k);
      }
      return n;
    });
  const sod = conflicts(perms, cat.sod);

  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={readOnly ? `${roleName(role!)} · ${t('access.builtin')}` : role ? t('access.editRole') : t('access.newRole')}
      footer={
        <>
          <span className="muted" style={{ marginInlineEnd: 'auto', fontSize: 13 }}>
            {t('access.rightsCount', { n: perms.size })}
          </span>
          <Button onClick={onClose}>{readOnly ? t('common.close') : t('common.cancel')}</Button>
          {!readOnly && (
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!name.trim()}
              onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}
            >
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {readOnly ? (
          <div className="notice">
            <ShieldCheck />
            <div>{t('access.builtinHint')}</div>
          </div>
        ) : (
          <div className="grid-2">
            <Field label={t('common.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!role} />
            </Field>
            <Field label={t('common.description')}>
              <Textarea rows={1} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="perm-matrix">
          {sections.map(({ module: m, objects }) => {
            const all = m.permissions;
            const on = all.filter((k) => perms.has(k)).length;
            const off = m.apps.length > 0 && !m.apps.some(hasApp);
            return (
              <section key={m.id} className={off ? 'off' : ''}>
                <header>
                  <label className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={on === all.length}
                      ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < all.length;
                      }}
                      onChange={(e) => toggle(all, e.target.checked)}
                    />
                    <strong>{t(`perms.modules.${m.id}`)}</strong>
                  </label>
                  {off && <Badge plain>{t('access.appOff')}</Badge>}
                  <span className="spacer" />
                  <span className="faint num" style={{ fontSize: 12 }}>
                    {on}/{all.length}
                  </span>
                </header>
                <table>
                  <tbody>
                    {objects.map(([object, actions]) => (
                      <tr key={object}>
                        <th>{t(`perms.objects.${object}`)}</th>
                        {ACTIONS.map((a) => {
                          const key = `${object}.${a}`;
                          return (
                            <td key={a}>
                              {actions.has(a) && (
                                <label className={`perm-cell ${perms.has(key) ? 'on' : ''}`}>
                                  <input type="checkbox" disabled={readOnly} checked={perms.has(key)} onChange={(e) => toggle([key], e.target.checked)} />
                                  {t(`perms.actions.${a}`)}
                                </label>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
        {sod.length > 0 && (
          <div className="notice warn">
            <AlertTriangle />
            <div>
              <strong>{t('access.sodTitle')}</strong>
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
                {sod.map(([a, b]) => (
                  <li key={a + b}>
                    <PermLabel k={a} /> + <PermLabel k={b} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}
