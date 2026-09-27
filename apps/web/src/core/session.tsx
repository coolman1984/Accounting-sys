import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized } from './api';
import { useI18n } from './i18n';
import type { Company, Me } from './types';

export interface SystemInfo {
  app: string;
  version: string;
  setupComplete: boolean;
  companyName: string | null;
  lanUrls: string[];
  apps: AppInfo[];
}

export interface AppInfo {
  id: string;
  core: boolean;
  requires: string[];
  enabled: boolean;
  order: number;
}

interface SessionValue {
  status: 'loading' | 'setup' | 'anonymous' | 'ready';
  info: SystemInfo | null;
  user: Me | null;
  company: Company | null;
  lockDate: string | null;
  /** Apps switched on for this company (Sales, Inventory…). */
  apps: string[];
  hasApp(id: string): boolean;
  can(perm: string): boolean;
  /** Permission and app gate together — what menus, commands and tiles use. */
  allowed(x: { perm?: string; app?: string | string[] }): boolean;
  refresh(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { setLocale } = useI18n();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [user, setUser] = useState<Me | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [lockDate, setLockDate] = useState<string | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [status, setStatus] = useState<SessionValue['status']>('loading');

  const refresh = useCallback(async () => {
    const i = await api.get<SystemInfo>('/system/info').catch(() => null);
    setInfo(i);
    if (i && !i.setupComplete) {
      setStatus('setup');
      return;
    }
    try {
      const me = await api.get<{ user: Me; company: Company; lockDate: string | null; apps: string[] }>('/auth/me');
      setUser(me.user);
      setApps(me.apps ?? []);
      setCompany(me.company);
      setLockDate(me.lockDate);
      setStatus('ready');
    } catch {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setStatus('anonymous');
        qc.clear();
      }),
    [qc],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      info,
      user,
      company,
      lockDate,
      apps,
      hasApp: (id) => apps.includes(id),
      can: (perm) => !!user?.permissions.includes(perm),
      allowed: (x) =>
        (!x.perm || !!user?.permissions.includes(x.perm)) &&
        (!x.app || (Array.isArray(x.app) ? x.app : [x.app]).some((a) => apps.includes(a))),
      refresh,
      async login(username, password) {
        const r = await api.post<{ user: Me }>('/auth/login', { username, password });
        setLocale(r.user.locale);
        await refresh();
      },
      async logout() {
        await api.post('/auth/logout').catch(() => undefined);
        qc.clear();
        setUser(null);
        setStatus('anonymous');
      },
    }),
    [status, info, user, company, lockDate, apps, refresh, qc, setLocale],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
