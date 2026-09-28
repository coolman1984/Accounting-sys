import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { today } from '../../kernel/dates.js';
import { parse, zDate, zId } from '../../kernel/validate.js';
import { documentChecks, runChecks } from './checks.js';

/**
 * The advisor: a senior accountant looking over the books every day. It checks them against
 * Egyptian tax and company law and the Egyptian Accounting Standards, and says — in plain words,
 * with the rule behind it — what needs attention and how to fix it. It never changes anything.
 */
export const advisorModule: AppModule = {
  id: 'advisor',
  dependsOn: ['ledger'],
  permissions: ['advisor.findings.read'],
  apps: [{ id: 'advisor', order: 16, permissions: ['advisor'] }],
  routes(r, ctx) {
    r.get('/advisor', 'advisor.findings.read', ({ query }) => {
      const q = parse(z.object({ asOf: zDate.default(today()) }), query);
      return { asOf: q.asOf, findings: runChecks(ctx, q.asOf) };
    });
    /** Advice on one invoice or bill (shown on the document). */
    r.get('/advisor/documents/:id', 'advisor.findings.read', ({ params }) => {
      if (!ctx.services.has('documents')) return [];
      return documentChecks(ctx, parse(zId, Number(params.id)));
    });
  },
};
