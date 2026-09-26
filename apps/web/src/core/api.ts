/** Minimal JSON client for the Mizan server. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Listeners notified when the server says our session is gone. */
const unauthorized = new Set<() => void>();
export const onUnauthorized = (fn: () => void) => {
  unauthorized.add(fn);
  return () => {
    unauthorized.delete(fn);
  };
};

export async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(query)}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 'Network error', 0);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && path !== '/auth/login') unauthorized.forEach((fn) => fn());
    throw new ApiError(e.code ?? 'generic', e.message ?? res.statusText, res.status, e.details ?? null);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
