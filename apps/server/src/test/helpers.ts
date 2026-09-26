import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';

export interface TestClient {
  app: App;
  cookie: string;
  get<T = any>(url: string): Promise<T>;
  post<T = any>(url: string, body?: unknown): Promise<T>;
  put<T = any>(url: string, body?: unknown): Promise<T>;
  del<T = any>(url: string): Promise<T>;
  /** Same as the verbs above but returns status + body without throwing. */
  raw(method: string, url: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any }>;
  login(username: string, password: string): Promise<string>;
  close(): Promise<void>;
}

export const FY_START = '2026-01-01';

/** A fresh, fully set-up company in an in-memory database. */
export async function setupCompany(opts: { vatRateBp?: number | null } = {}): Promise<TestClient> {
  const app = await buildApp(loadConfig({ dbFile: ':memory:', dataDir: '/tmp/mizan-test', logLevel: 'silent', webDir: null }));
  const raw = async (method: string, url: string, body?: unknown, cookie?: string) => {
    const res = await app.http.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: cookie ? { cookie } : {},
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
  const setup = await raw('POST', '/api/setup', {
    company: { name: 'Test Co', baseCurrency: 'EGP', moneyScale: 2 },
    fiscalYearStart: FY_START,
    admin: { username: 'admin', displayName: 'Admin', password: 'password123' },
    locale: 'en',
    seedChartOfAccounts: true,
    vatRateBp: opts.vatRateBp === undefined ? 1400 : opts.vatRateBp,
  });
  if (setup.status !== 200) throw new Error('setup failed: ' + JSON.stringify(setup.body));

  const client: TestClient = {
    app,
    cookie: '',
    async login(username, password) {
      const res = await app.http.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
      if (res.statusCode !== 200) throw new Error('login failed ' + res.body);
      const c = res.cookies.find((x) => x.name === 'mizan_sid')!;
      return `mizan_sid=${c.value}`;
    },
    raw: (m, u, b, c) => raw(m, u, b, c ?? client.cookie),
    async get(url) {
      return ok(await raw('GET', url, undefined, client.cookie), 'GET', url);
    },
    async post(url, body = {}) {
      return ok(await raw('POST', url, body, client.cookie), 'POST', url);
    },
    async put(url, body = {}) {
      return ok(await raw('PUT', url, body, client.cookie), 'PUT', url);
    },
    async del(url) {
      return ok(await raw('DELETE', url, undefined, client.cookie), 'DELETE', url);
    },
    close: () => app.http.close(),
  };
  client.cookie = await client.login('admin', 'password123');
  return client;
}

function ok(res: { status: number; body: any }, method: string, url: string) {
  if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Look up an account id by code. */
export async function acc(c: TestClient, code: string): Promise<number> {
  const list = await c.get<{ id: number; code: string }[]>('/api/accounts');
  const a = list.find((x) => x.code === code);
  if (!a) throw new Error('no account ' + code);
  return a.id;
}
