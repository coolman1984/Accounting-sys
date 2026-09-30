import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { setClock, type Clock } from './kernel/dates.js';
import { createKernel, type Kernel } from './kernel/kernel.js';
import { AppError } from './kernel/errors.js';
import { AppsError } from './kernel/apps.js';
import { z } from 'zod';
import { parse } from './kernel/validate.js';
import type { AppModule, Handler, RequestCtx, Router, SessionUser } from './kernel/modules.js';
import { SESSION_COOKIE } from './modules/system/index.js';
import { modules as defaultModules } from './modules/index.js';

export interface App {
  http: FastifyInstance;
  kernel: Kernel;
}

export interface AppOptions {
  /** The time every date and timestamp of the server reads; default real time (the scenario engine passes a controlled one). */
  clock?: Clock;
}

export async function buildApp(config: AppConfig, modules: AppModule[] = defaultModules, options: AppOptions = {}): Promise<App> {
  setClock(options.clock);
  const kernel = createKernel(config, modules);
  const http = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: 5 * 1024 * 1024,
  });
  await http.register(cookie);

  const access = kernel.services.get('access');
  const settings = kernel.services.get('settings');

  http.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppsError) {
      return reply.status(422).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    const msg = e.message ?? '';
    // Database-level guards (triggers / constraints) are the last line of defense.
    // Trigger messages are "<module>: reason" (RAISE(ABORT, …)); every module's, not a fixed list.
    const sqlite = e.code === 'ERR_SQLITE_ERROR';
    if (sqlite && (/^[a-z_]+: /.test(msg) || msg.includes('audit log'))) {
      return reply.status(409).send({ error: { code: 'integrity', message: msg, details: null } });
    }
    if (sqlite && msg.includes('UNIQUE constraint failed')) {
      return reply.status(409).send({ error: { code: 'duplicate', message: 'That value is already used by another record', details: null } });
    }
    if (msg.includes('FOREIGN KEY constraint failed')) {
      return reply.status(409).send({ error: { code: 'in_use', message: 'This record is referenced by other records', details: null } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'bad_request', message: msg, details: null } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Unexpected server error', details: null } });
  });

  const mount = (method: 'GET' | 'POST' | 'PUT' | 'DELETE') => (path: string, perm: string, handler: Handler) => {
    http.route({
      method,
      url: '/api' + path,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        let user: SessionUser | null = null;
        if (perm !== 'public') {
          user = access.authenticate(req.cookies[SESSION_COOKIE]);
          if (!user) throw new AppError('auth.required', 'Login required', 401);
          if (!access.can(user, perm)) throw new AppError('auth.forbidden', 'You do not have permission for this action', 403, { permission: perm });
          if (!settings.isSetupComplete()) throw new AppError('setup.required', 'Setup is not complete', 409);
        }
        const ctx: RequestCtx = {
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string | undefined>,
          body: req.body,
          user: user as SessionUser,
          req,
          reply,
        };
        const result = await handler(ctx);
        if (result === reply) return reply;
        return result ?? { ok: true };
      },
    });
  };

  // Machine endpoints (other applications): outside /api, never a session; the module checks the key.
  const machine: Router['machine'] = (method, path, _scope, handler) => {
    if (!path.startsWith('/eco/')) throw new Error(`Machine routes live under /eco/ (got ${path})`);
    http.route({
      method,
      url: path,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!settings.isSetupComplete()) throw new AppError('setup.required', 'Setup is not complete', 409);
        const result = await handler({
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string | undefined>,
          body: req.body,
          headers: req.headers,
          req,
          reply,
        });
        if (result === reply) return reply;
        return result ?? { ok: true };
      },
    });
  };

  const router: Router = { get: mount('GET'), post: mount('POST'), put: mount('PUT'), delete: mount('DELETE'), machine };
  for (const m of kernel.modules) m.routes?.(router, kernel);

  // ---- Apps: which features this installation uses (switchable, like Odoo apps).
  router.get('/system/apps', 'auth', () => kernel.apps.list());
  router.put('/system/apps', 'admin.settings.manage', ({ body, user }) => {
    const input = parse(z.object({ enabled: z.array(z.string()).max(50) }), body);
    const before = kernel.apps.list().filter((a) => a.enabled).map((a) => a.id);
    kernel.apps.setEnabled(input.enabled);
    const after = kernel.apps.list().filter((a) => a.enabled).map((a) => a.id);
    kernel.services.get('audit').log({ userId: user.id, action: 'update', entity: 'apps', summary: `${before.join(', ')} → ${after.join(', ')}` });
    return kernel.apps.list();
  });

  // ---- Health: every module checks its own data, separately, so a fault names its module.
  router.get('/system/health', 'admin.settings.read', () =>
    kernel.modules
      .filter((m) => m.health)
      .map((m) => {
        const started = performance.now();
        try {
          return { module: m.id, checks: m.health!(kernel), ms: Math.round(performance.now() - started) };
        } catch (e) {
          // One broken check never hides the others.
          return { module: m.id, checks: [], error: (e as Error).message, ms: Math.round(performance.now() - started) };
        }
      }),
  );

  http.get('/api/health', async () => ({ ok: true }));
  http.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/eco/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown endpoint', details: null } });
    }
    // A missing asset is a 404 — never the HTML shell, which browsers reject as a script.
    if (/^\/assets\//.test(req.url)) return reply.status(404).send('Not found');
    // Single-page app: unknown paths render index.html (never cached, so updates show at once).
    if (config.webDir && existsSync(config.webDir)) return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply.status(404).send('Web app not built. Run "npm run build" or use "npm run dev".');
  });

  if (config.webDir && existsSync(config.webDir)) {
    // wildcard: files are looked up per request, so a rebuilt web app is served without a restart.
    await http.register(fastifyStatic, {
      root: config.webDir,
      wildcard: true,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, path) => {
        // Hashed bundles never change; the HTML shell must always be revalidated.
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  http.addHook('onClose', async () => kernel.close());
  return { http, kernel };
}
