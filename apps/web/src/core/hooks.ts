import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useI18n } from './i18n';
import { useSession } from './session';
import { formatDate, formatMinor, parseDecimal, type MoneyOpts } from './format';

type Query = Record<string, string | number | boolean | null | undefined>;

/** GET with caching. Key = [path, query]. */
export function useApi<T>(path: string | null, query?: Query, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [path, query ?? {}],
    queryFn: () => api.get<T>(path!, query),
    enabled: path != null,
    ...opts,
  });
}

/**
 * A write. In accounting almost everything is connected (posting an invoice
 * changes balances, reports, the dashboard…), so every successful write
 * refreshes all cached reads.
 */
export function useApiMutation<TVars, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation<TResult, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries(),
  });
}

/** Money helpers bound to the company's currency scale and the UI locale. */
export function useMoney() {
  const { company } = useSession();
  const { locale } = useI18n();
  const scale = company?.moneyScale ?? 2;
  return {
    scale,
    currency: company?.baseCurrency ?? '',
    fmt: useCallback((v: number | null | undefined, o?: MoneyOpts) => formatMinor(v, scale, locale, o), [scale, locale]),
    parse: useCallback((s: string) => parseDecimal(s, scale), [scale]),
  };
}

export function useDate() {
  const { locale } = useI18n();
  return useCallback((iso: string | null | undefined, style?: 'short' | 'long') => formatDate(iso, locale, style), [locale]);
}

/** Turn any error into a translated, human sentence. */
export function useErrorText() {
  const { t, has } = useI18n();
  return useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        const vars = Object.fromEntries(
          Object.entries(err.details ?? {}).map(([k, v]) => [k, typeof v === 'object' ? '' : (v as string | number)]),
        );
        const key = `errors.${err.code}`;
        if (err.code === 'validation') {
          const issues = (err.details?.issues as { path: string; message: string }[] | undefined) ?? [];
          return issues.length ? `${t('errors.validation')}: ${issues.map((i) => i.path || i.message).join(', ')}` : t('errors.validation');
        }
        if (err.code === 'integrity') return t('errors.integrity', { message: err.message.replace(/^\w+:\s*/, '') });
        if (has(key)) return t(key, vars);
        return err.message || t('errors.generic');
      }
      return err instanceof Error ? err.message : t('errors.generic');
    },
    [t, has],
  );
}
