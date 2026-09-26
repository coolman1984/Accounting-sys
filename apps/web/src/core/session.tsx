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
}

interface SessionValue {
  status: 'loading' | 'setup' | 'anonymous' | 'ready';
  info: SystemInfo | null;
  user: Me | null;
  company: Company | null;
  lockDate: string | null;
  can(perm: string): boolean;
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
  const [status, setStatus] = useState<SessionValue['status']>('loading');

  const refresh = useCallback(async () => {
    const i = await api.get<SystemInfo>('/system/info').catch(() => null);
    setInfo(i);
    if (i && !i.setupComplete) {
      setStatus('setup');
      return;
    }
    try {
      const me = await api.get<{ user: Me; company: Company; lockDate: string | null }>('/auth/me');
      setUser(me.user);
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
      can: (perm) => !!user?.permissions.includes(perm),
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
    [status, info, user, company, lockDate, refresh, qc, setLocale],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
