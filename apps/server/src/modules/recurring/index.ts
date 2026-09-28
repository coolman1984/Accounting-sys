import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { AppError, conflict, fail, forbidden, notFound } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { DocInput } from '../../contracts/documents.js';
import { dueDates, fillPlaceholders, occurrence, type Frequency } from './engine.js';

type Kind = 'sales_invoice' | 'purchase_bill' | 'journal';

interface Template {
  id: number;
  name: string;
  kind: Kind;
  payload: string;
  frequency: Frequency;
  interval: number;
  first_date: string;
  done_count: number;
  end_date: string | null;
  max_count: number | null;
  auto_post: number;
  is_active: number;
  last_date: string | null;
}

const zDocLine = z.object({
  itemId: zOptId.transform((v) => v ?? null),
  description: zOptText(500),
  quantity: z.number().int().positive(),
  unitPrice: z.number().int().min(0),
  discountBp: z.number().int().min(0).max(10000).default(0),
  accountId: zOptId.transform((v) => v ?? null),
  taxId: zOptId.transform((v) => v ?? null),
  unitId: zOptId.transform((v) => v ?? null),
  warehouseId: zOptId.transform((v) => v ?? null),
  costCenterId: zOptId.transform((v) => v ?? null),
});
const zDocPayload = z.object({
  partyId: zId,
  reference: zOptText(100),
  notes: zOptText(2000),
  taxInclusive: z.boolean().default(false),
  warehouseId: zOptId.transform((v) => v ?? null),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish().transform((v) => v ?? null),
  lines: z.array(zDocLine).min(1).max(200),
});
const zJournalPayload = z.object({
  reference: zOptText(100),
  memo: zOptText(500),
  lines: z
    .array(
      z.object({
        accountId: zId,
        debit: z.number().int().min(0),
        credit: z.number().int().min(0),
        description: zOptText(300),
        partyId: zOptId.transform((v) => v ?? null),
        costCenterId: zOptId.transform((v) => v ?? null),
      }),
    )
    .min(2)
    .max(200),
});
const zTemplate = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['sales_invoice', 'purchase_bill', 'journal']),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).default('monthly'),
  interval: z.number().int().min(1).max(24).default(1),
  firstDate: zDate,
  endDate: zDate.nullish().transform((v) => v ?? null),
  maxCount: z.number().int().min(1).max(1000).nullish().transform((v) => v ?? null),
  autoPost: z.boolean().default(false),
  isActive: z.boolean().default(true),
  payload: z.unknown(),
});
type TemplateInput = z.infer<typeof zTemplate>;

/** Thrown inside a transaction to roll a trial run back. */
class DryRun extends Error {}

function createRecurring({ db, services }: ModuleContext) {
  const ledger = () => services.get('ledger');
  const access = () => services.get('access');
  const audit = () => services.get('audit');
  const template = (id: number) => db.get<Template>('SELECT * FROM recurring_templates WHERE id = ?', [id]) ?? notFound('recurring_template', id);

  /** The permissions making (and posting) a document of this kind needs. */
  function perms(kind: Kind, autoPost: boolean): string[] {
    if (kind === 'journal') return autoPost ? ['gl.journal.write', 'gl.journal.post'] : ['gl.journal.write'];
    if (!services.has('documents')) fail('recurring.unavailable', 'Invoices and bills are not installed');
    const info = services.get('documents').kind(kind);
    if (!info) fail('recurring.unavailable', 'This document type is not in use');
    return autoPost ? [`${info!.perm}.write`, `${info!.perm}.post`] : [`${info!.perm}.write`];
  }
  const assertCan = (userId: number | null, kind: Kind, autoPost: boolean) => {
    for (const p of perms(kind, autoPost)) if (!access().userCan(userId, p)) forbidden(p);
  };

  const parsePayload = (kind: Kind, raw: unknown) => (kind === 'journal' ? parse(zJournalPayload, raw) : parse(zDocPayload, raw));

  /** Make one occurrence: a document or a journal entry dated `date`, posted when the template says so. */
  function make(t: { kind: Kind; payload: unknown; auto_post: number | boolean; name: string }, date: string, userId: number | null): { documentId: number | null; entryId: number | null } {
    if (t.kind === 'journal') {
      const p = t.payload as z.infer<typeof zJournalPayload>;
      const entryId = ledger().createEntry(
        { date, reference: fillPlaceholders(p.reference, date), memo: fillPlaceholders(p.memo ?? t.name, date), lines: p.lines.map((l) => ({ ...l, description: fillPlaceholders(l.description, date) })) },
        { sourceType: 'manual', userId, post: !!t.auto_post },
      );
      return { documentId: null, entryId };
    }
    const p = t.payload as z.infer<typeof zDocPayload>;
    const docs = services.get('documents');
    const input: DocInput = {
      kind: t.kind,
      partyId: p.partyId,
      date,
      dueDate: null,
      reference: fillPlaceholders(p.reference, date),
      notes: fillPlaceholders(p.notes, date),
      taxInclusive: p.taxInclusive,
      warehouseId: p.warehouseId,
      currency: p.currency,
      lines: p.lines.map((l) => ({ ...l, description: fillPlaceholders(l.description, date) })),
    };
    const id = docs.create(input, userId);
    if (t.auto_post) docs.post(id, userId);
    return { documentId: id, entryId: null };
  }

  /** Validate a template by making its first occurrence inside a transaction that is rolled back. */
  function dryRun(input: TemplateInput, payload: unknown, userId: number | null) {
    try {
      db.tx(() => {
        make({ kind: input.kind, payload, auto_post: false, name: input.name }, input.firstDate, userId);
        throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
  }

  function write(id: number | null, raw: unknown, userId: number | null): number {
    const input = parse(zTemplate, raw);
    assertCan(userId, input.kind, input.autoPost);
    if (input.endDate && input.endDate < input.firstDate) fail('recurring.end_before', 'The end date is before the first date');
    const payload = parsePayload(input.kind, input.payload);
    if (input.kind === 'journal') {
      const lines = (payload as z.infer<typeof zJournalPayload>).lines;
      const dr = lines.reduce((s, l) => s + l.debit, 0);
      const cr = lines.reduce((s, l) => s + l.credit, 0);
      if (dr !== cr || dr === 0) fail('journal.unbalanced', 'Debits must equal credits', { debit: dr, credit: cr, difference: dr - cr });
    }
    dryRun(input, payload, userId);
    const row = {
      name: input.name,
      kind: input.kind,
      payload: JSON.stringify(payload),
      frequency: input.frequency,
      interval: input.interval,
      first_date: input.firstDate,
      end_date: input.endDate,
      max_count: input.maxCount,
      auto_post: input.autoPost ? 1 : 0,
      is_active: input.isActive ? 1 : 0,
      updated_at: nowIso(),
    };
    return db.tx(() => {
      let tid = id;
      if (tid == null) tid = db.insert('recurring_templates', { ...row, done_count: 0, created_by: userId, created_at: nowIso() });
      else {
        const cur = template(tid);
        // Once occurrences exist, the schedule's start and kind are history: change the rest only.
        if (cur.done_count > 0 && (cur.kind !== input.kind || cur.first_date !== input.firstDate || cur.frequency !== input.frequency || cur.interval !== input.interval)) {
          conflict('recurring.schedule_locked', 'Documents were already made — the type and schedule cannot change; end this template and start a new one');
        }
        db.update('recurring_templates', tid, row);
      }
      audit().log({ userId, action: id == null ? 'create' : 'update', entity: 'recurring_template', entityId: tid, summary: input.name });
      return tid;
    });
  }

  const nextDate = (t: Template) => {
    if (t.max_count != null && t.done_count >= t.max_count) return null;
    const d = occurrence(t.first_date, t.frequency, t.interval, t.done_count);
    return t.end_date && d > t.end_date ? null : d;
  };

  function due(upTo: string) {
    return db
      .all<Template>('SELECT * FROM recurring_templates WHERE is_active = 1 ORDER BY id')
      .map((t) => ({ t, dates: dueDates({ first: t.first_date, frequency: t.frequency, interval: t.interval, done: t.done_count, endDate: t.end_date, maxCount: t.max_count }, upTo) }))
      .filter((x) => x.dates.length > 0);
  }

  /** Make everything due up to `upTo`. A failing template stops at its first failure (nothing skipped); the others go on. */
  function generate(upTo: string, userId: number | null, onlyId: number | null) {
    const results: { templateId: number; name: string; date: string; ok: boolean; documentId: number | null; entryId: number | null; message: string | null }[] = [];
    for (const { t, dates } of due(upTo)) {
      if (onlyId && t.id !== onlyId) continue;
      for (const [i, date] of dates.entries()) {
        const n = t.done_count + i;
        try {
          assertCan(userId, t.kind, !!t.auto_post);
          const made = db.tx(() => {
            const m = make({ kind: t.kind, payload: JSON.parse(t.payload), auto_post: t.auto_post, name: t.name }, date, userId);
            db.insert('recurring_runs', { template_id: t.id, occurrence: n, date, status: t.auto_post ? 'posted' : 'created', document_id: m.documentId, entry_id: m.entryId, created_by: userId, created_at: nowIso() });
            db.run('UPDATE recurring_templates SET done_count = done_count + 1, last_date = ?, updated_at = ? WHERE id = ?', [date, nowIso(), t.id]);
            return m;
          });
          results.push({ templateId: t.id, name: t.name, date, ok: true, ...made, message: null });
        } catch (e) {
          const message = e instanceof AppError ? e.message : 'Unexpected error';
          const code = e instanceof AppError ? e.code : 'internal';
          db.insert('recurring_runs', { template_id: t.id, occurrence: n, date, status: 'failed', message: `${code}: ${message}`, created_by: userId, created_at: nowIso() });
          results.push({ templateId: t.id, name: t.name, date, ok: false, documentId: null, entryId: null, message });
          break;
        }
      }
    }
    if (results.length) audit().log({ userId, action: 'generate', entity: 'recurring', summary: `${results.filter((r) => r.ok).length} made, ${results.filter((r) => !r.ok).length} failed` });
    return results;
  }

  return { template, write, nextDate, due, generate, parsePayload };
}

export const recurringModule: AppModule = {
  id: 'recurring',
  dependsOn: ['ledger'],
  permissions: ['recurring.templates.read', 'recurring.templates.write'],
  apps: [{ id: 'recurring', order: 38, permissions: ['recurring'] }],
  migrations: [
    {
      id: '001_recurring',
      up: `
        CREATE TABLE recurring_templates (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('sales_invoice', 'purchase_bill', 'journal')),
          payload     TEXT NOT NULL,                     -- the document or entry to repeat (JSON)
          frequency   TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
          interval    INTEGER NOT NULL DEFAULT 1,
          first_date  TEXT NOT NULL,
          done_count  INTEGER NOT NULL DEFAULT 0,        -- occurrences made so far
          end_date    TEXT,
          max_count   INTEGER,
          auto_post   INTEGER NOT NULL DEFAULT 0,
          is_active   INTEGER NOT NULL DEFAULT 1,
          last_date   TEXT,
          created_by  INTEGER REFERENCES users(id),
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE recurring_runs (
          id          INTEGER PRIMARY KEY,
          template_id INTEGER NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE,
          occurrence  INTEGER NOT NULL,
          date        TEXT NOT NULL,
          status      TEXT NOT NULL CHECK (status IN ('created', 'posted', 'failed')),
          document_id INTEGER,
          entry_id    INTEGER REFERENCES journal_entries(id),
          message     TEXT,
          created_by  INTEGER REFERENCES users(id),
          created_at  TEXT NOT NULL
        );
        CREATE INDEX recurring_runs_template ON recurring_runs(template_id, id);
      `,
    },
  ],

  routes(r, ctx) {
    const { db } = ctx;
    const rec = createRecurring(ctx);
    const audit = ctx.services.get('audit');

    r.get('/recurring', 'recurring.templates.read', () =>
      db
        .all<Template & { last_status: string | null; last_message: string | null }>(
          `SELECT t.*, (SELECT status FROM recurring_runs x WHERE x.template_id = t.id ORDER BY x.id DESC LIMIT 1) AS last_status,
                  (SELECT message FROM recurring_runs x WHERE x.template_id = t.id ORDER BY x.id DESC LIMIT 1) AS last_message
           FROM recurring_templates t ORDER BY t.is_active DESC, t.name`,
        )
        .map((t) => ({ ...t, payload: JSON.parse(t.payload), next_date: t.is_active ? rec.nextDate(t) : null })),
    );
    r.get('/recurring/due', 'recurring.templates.read', ({ query }) => {
      const upTo = parse(z.object({ upTo: zDate.default(today()) }), query).upTo;
      return rec.due(upTo).map(({ t, dates }) => ({ id: t.id, name: t.name, kind: t.kind, dates }));
    });
    // A draft made from a template may since have been deleted: show the run without its number.
    const numberOf = (docs: ReturnType<typeof ctx.services.get<'documents'>>, id: number) => {
      try {
        return docs.get(id).number;
      } catch {
        return null;
      }
    };
    r.get('/recurring/:id', 'recurring.templates.read', ({ params }) => {
      const t = rec.template(Number(params.id));
      const docs = ctx.services.has('documents') ? ctx.services.get('documents') : null;
      const runs = db
        .all<{ document_id: number | null }>(
          `SELECT x.*, e.number AS entry_number FROM recurring_runs x LEFT JOIN journal_entries e ON e.id = x.entry_id
           WHERE x.template_id = ? ORDER BY x.id DESC LIMIT 200`,
          [t.id],
        )
        .map((x) => ({ ...x, document_number: x.document_id && docs ? numberOf(docs, x.document_id) : null }));
      return { ...t, payload: JSON.parse(t.payload), next_date: t.is_active ? rec.nextDate(t) : null, runs };
    });
    r.post('/recurring', 'recurring.templates.write', ({ body, user }) => ({ id: rec.write(null, body, user.id) }));
    r.put('/recurring/:id', 'recurring.templates.write', ({ params, body, user }) => {
      rec.template(Number(params.id));
      return { id: rec.write(Number(params.id), body, user.id) };
    });
    r.delete('/recurring/:id', 'recurring.templates.write', ({ params, user }) => {
      const t = rec.template(Number(params.id));
      if (t.done_count > 0) conflict('recurring.has_runs', 'Documents were made from this template — pause it instead');
      db.tx(() => {
        db.run('DELETE FROM recurring_templates WHERE id = ?', [t.id]);
        audit.log({ userId: user.id, action: 'delete', entity: 'recurring_template', entityId: t.id, summary: t.name });
      });
      return { ok: true };
    });
    r.post('/recurring/generate', 'recurring.templates.write', ({ body, user }) => {
      const q = parse(z.object({ upTo: zDate.default(today()), templateId: zOptId.transform((v) => v ?? null) }), body ?? {});
      if (q.upTo > today()) fail('recurring.future', 'Documents can be made up to today');
      return { results: rec.generate(q.upTo, user.id, q.templateId) };
    });
  },
};
