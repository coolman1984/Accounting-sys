import { useMemo } from 'react';
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

function Routed() {
  const { status } = useSession();
  const router = useMemo(() => {
    const nav = webModules.flatMap((m) => m.nav ?? []);
    const commands = webModules.flatMap((m) => m.commands ?? []);
    const pages = webModules.flatMap((m) => m.routes);
    return createBrowserRouter([
      {
        element: <AppShell nav={nav} commands={commands} />,
        children: [...pages.map((p) => ({ path: p.path, element: p.element })), { path: '*', element: <NotFound /> }],
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


