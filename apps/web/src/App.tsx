import { useMemo, type ReactNode } from 'react';
import { ShieldX } from 'lucide-react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from './core/i18n';
import { ThemeProvider } from './core/theme';
import { SessionProvider, useSession } from './core/session';
import { ToastProvider } from './ui/Toast';
import { ConfirmProvider } from './ui/Dialog';
import { Loading, EmptyState } from './ui/Page';
import { AppShell } from './shell/AppShell';
import { LoginPage } from './modules/auth/Login';
import { SetupPage } from './modules/auth/Setup';
import { webModules } from './modules';
import { gateFor, type AppGate } from './core/registry';
import { useI18n } from './core/i18n';
import { ModulesProvider } from './core/slots';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page">
      <EmptyState title="404" text={t('errors.not_found')} />
    </div>
  );
}

/** Opening a page by its link still respects roles and apps — a clear message instead of an empty page. */
function Guard({ gate, children }: { gate: { perm?: string; app?: AppGate }; children: ReactNode }) {
  const { allowed } = useSession();
  const { t } = useI18n();
  if (allowed(gate)) return <>{children}</>;
  return (
    <div className="page">
      <EmptyState icon={<ShieldX size={22} />} title={t('shell.noAccess')} text={t('shell.noAccessText')} />
    </div>
  );
}

function Routed() {
  const { status } = useSession();
  const router = useMemo(() => {
    const nav = webModules.flatMap((m) => m.nav ?? []);
    const commands = webModules.flatMap((m) => m.commands ?? []);
    const pages = webModules.flatMap((m) => m.routes);
    const links = [...nav, ...webModules.flatMap((m) => m.reports ?? [])];
    return createBrowserRouter([
      {
        element: <AppShell nav={nav} commands={commands} />,
        children: [...pages.map((p) => ({ path: p.path, element: <Guard gate={gateFor(p, links)}>{p.element}</Guard> })), { path: '*', element: <NotFound /> }],
      },
    ]);
  }, []);

  if (status === 'loading') return <Loading />;
  if (status === 'setup') return <SetupPage />;
  if (status === 'anonymous') return <LoginPage />;
  return (
    <ModulesProvider modules={webModules}>
      <RouterProvider router={router} />
    </ModulesProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <SessionProvider>
            <ToastProvider>
              <ConfirmProvider>
                <Routed />
              </ConfirmProvider>
            </ToastProvider>
          </SessionProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}


