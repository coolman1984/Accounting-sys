import { z } from 'zod';
import type { AppModule } from '../../kernel/modules.js';
import { forbidden, notFound } from '../../kernel/errors.js';
import { addDays, daysBetween, today } from '../../kernel/dates.js';
import { paging, parse, zBp, zDate, zId, zOptId, zOptText } from '../../kernel/validate.js';
import type { SessionUser } from '../../kernel/modules.js';
import { DOC_KINDS, KIND_INFO, migrations, type DocKind } from './schema.js';
import type { DocSide } from '../../contracts/documents.js';
import { createDocuments, type DocumentsService } from './service.js';

const zLine = z.object({
  itemId: zOptId.transform((v) => v ?? null),
  description: zOptText(500),
  quantity: z.number().int().positive(),
  unitPrice: z.number().int().min(0),
  discountBp: zBp.default(0),
  accountId: zOptId.transform((v) => v ?? null),
  taxId: zOptId.transform((v) => v ?? null),
  warehouseId: zOptId.transform((v) => v ?? null),
  unitId: zOptId.transform((v) => v ?? null),
  ext: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? null),
  costCenterId: zOptId.transform((v) => v ?? null),
});

const zDoc = z.object({
  kind: z.enum(DOC_KINDS),
  partyId: zId,
  date: zDate,
  dueDate: zDate.nullish(),
  reference: zOptText(100),
  notes: zOptText(2000),
  taxInclusive: z.boolean().default(false),
  againstDocumentId: zOptId.transform((v) => v ?? null),
  warehouseId: zOptId.transform((v) => v ?? null),
  lines: z.array(zLine).min(1).max(500),
  post: z.boolean().default(false),
});

export const documentsModule: AppModule = {
  id: 'documents',
  dependsOn: ['ledger', 'parties', 'catalog'],
  migrations,
  // The billing engine sells nothing by itself: AR registers the sales kinds, AP the purchase kinds,
  // each with its own permissions (ar.invoices.*, ap.bills.*…).
  permissions: [],
  health({ db }) {
    const over = db.get<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE amount_settled < 0 OR amount_settled > total")!.n;
    const drift = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM documents d
       WHERE d.amount_settled <> (SELECT COALESCE(SUM(amount), 0) FROM settlements s WHERE s.document_id = d.id)`,
    )!.n;
    const unposted = db.get<{ n: number }>("SELECT COUNT(*) n FROM documents WHERE status = 'posted' AND journal_entry_id IS NULL")!.n;
    return [
      { id: 'settled', ok: over === 0, details: { count: over } },
      { id: 'settlements', ok: drift === 0, details: { count: drift } },
      { id: 'journal', ok: unposted === 0, details: { count: unposted } },
    ];
  },

  setup(ctx) {
    ctx.services.provide('documents', createDocuments(ctx));
    ctx.events.on('system.setup', () => {
      const seq = ctx.services.get('sequences');
      for (const k of DOC_KINDS) seq.ensure(KIND_INFO[k].seq, KIND_INFO[k].prefix, 5);
    });
  },

  routes(r, { db, services }) {
    const docs = services.get('documents') as DocumentsService;

    /** Permission for an action on a kind, from the module that registered it (AR / AP). */
    const need = (user: SessionUser, kind: DocKind, action: 'read' | 'write' | 'post') => {
      const info = docs.kind(kind);
      if (!info) notFound('document_kind', kind);
      const perm = `${info!.perm}.${action}`;
      if (!user.permissions.has(perm)) forbidden(perm);
    };

    r.get('/documents', 'auth', ({ query, user }) => {
      const kind = parse(z.enum(DOC_KINDS), query.kind);
      need(user, kind, 'read');
      const { limit, offset } = paging(query);
      const where = ['d.kind = :kind'];
      const p: Record<string, string | number> = { kind };
      if (query.status) (where.push('d.status = :status'), (p.status = query.status));
      if (query.partyId) (where.push('d.party_id = :party'), (p.party = Number(query.partyId)));
      if (query.from) (where.push('d.date >= :from'), (p.from = query.from));
      if (query.to) (where.push('d.date <= :to'), (p.to = query.to));
      if (query.open === '1') where.push("d.status = 'posted' AND d.amount_settled < d.total");
      if (query.overdue === '1') {
        where.push("d.status = 'posted' AND d.amount_settled < d.total AND d.due_date < :today");
        p.today = today();
      }
      if (query.q) {
        where.push('(d.number LIKE :q OR d.reference LIKE :q OR pa.name LIKE :q)');
        p.q = `%${query.q}%`;
      }
      const w = 'WHERE ' + where.join(' AND ');
      const rows = db.all(
        `SELECT d.id, d.kind, d.number, d.date, d.due_date, d.reference, d.status, d.subtotal, d.tax_total, d.total,
                d.amount_settled, d.party_id, pa.name AS party_name
         FROM documents d JOIN parties pa ON pa.id = d.party_id
         ${w} ORDER BY d.date DESC, d.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit, offset },
      );
      const agg = db.get<{ n: number; total: number; outstanding: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN d.status = 'posted' THEN d.total END), 0) total,
                COALESCE(SUM(CASE WHEN d.status = 'posted' THEN d.total - d.amount_settled END), 0) outstanding
         FROM documents d JOIN parties pa ON pa.id = d.party_id ${w}`,
        p,
      )!;
      return { rows, total: agg.n, sums: { total: agg.total, outstanding: agg.outstanding } };
    });

    r.get('/documents/:id', 'auth', ({ params, user }) => {
      const d = docs.get(Number(params.id));
      need(user, d.kind, 'read');
      const party = services.get('parties').get(d.party_id);
      const lines = db.all(
        `SELECT l.*, a.code AS account_code, a.name_en AS account_name_en, a.name_ar AS account_name_ar,
                i.sku AS item_sku, i.unit AS base_unit, u.name_en AS unit_name_en, u.name_ar AS unit_name_ar, t.code AS tax_code
         FROM document_lines l
         JOIN accounts a ON a.id = l.account_id
         LEFT JOIN items i ON i.id = l.item_id
         LEFT JOIN item_units u ON u.id = l.unit_id
         LEFT JOIN taxes t ON t.id = l.tax_id
         WHERE l.document_id = ? ORDER BY l.line_no`,
        [d.id],
      ).map((l: any) => ({ ...l, ext: l.ext ? JSON.parse(l.ext) : null }));
      // Where the money came from (payments / credit notes applied to this document) …
      const settlements = db.all(
        'SELECT id, source_type, source_id, source_number, amount, date FROM settlements WHERE document_id = ? ORDER BY date, id',
        [d.id],
      );
      // … and, for a credit note, which documents it was applied to.
      const applied = db.all(
        `SELECT s.id, s.document_id, s.amount, s.date, x.number FROM settlements s JOIN documents x ON x.id = s.document_id
         WHERE s.source_type = 'credit' AND s.source_id = ?`,
        [d.id],
      );
      const je = (id: number | null) => (id ? db.get<{ number: string }>('SELECT number FROM journal_entries WHERE id = ?', [id])?.number : null);
      const against = d.against_document_id ? docs.get(d.against_document_id).number : null;
      return {
        ...d,
        party,
        lines,
        settlements,
        applied,
        against_number: against,
        journal_number: je(d.journal_entry_id),
        void_journal_number: je(d.void_entry_id),
      };
    });

    r.post('/documents', 'auth', ({ body, user }) => {
      const input = parse(zDoc, body);
      need(user, input.kind, 'write');
      if (input.post) need(user, input.kind, 'post');
      const id = db.tx(() => {
        const id = docs.create(input, user.id);
        if (input.post) docs.post(id, user.id);
        return id;
      });
      return { id };
    });

    r.put('/documents/:id', 'auth', ({ params, body, user }) => {
      const id = Number(params.id);
      const input = parse(zDoc, body);
      need(user, input.kind, 'write');
      if (input.post) need(user, input.kind, 'post');
      db.tx(() => {
        docs.update(id, input, user.id);
        if (input.post) docs.post(id, user.id);
      });
      return { id };
    });

    r.post('/documents/:id/post', 'auth', ({ params, user }) => {
      const d = docs.get(Number(params.id));
      need(user, d.kind, 'post');
      docs.post(d.id, user.id);
      return { ok: true };
    });

    r.post('/documents/:id/void', 'auth', ({ params, body, user }) => {
      const d = docs.get(Number(params.id));
      need(user, d.kind, 'post');
      const input = parse(z.object({ date: zDate.nullish() }), body ?? {});
      docs.void(d.id, input, user.id);
      return { ok: true };
    });

    // ------------------------------------------------------------ ageing & overview
    /** Reports of a side need the report permission its module registered (ar.reports.read / ap.reports.read). */
    const needSide = (user: SessionUser, side: DocSide) => {
      const info = docs.side(side);
      if (!info) notFound('document_side', side);
      if (!user.permissions.has(info!.reportPerm)) forbidden(info!.reportPerm);
    };

    r.get('/reports/aging', 'auth', ({ query, user }) => {
      const q = parse(z.object({ type: z.enum(['receivable', 'payable']).default('receivable'), asOf: zDate.default(today()) }), query);
      needSide(user, q.type === 'receivable' ? 'sales' : 'purchases');
      const kinds = q.type === 'receivable' ? ['sales_invoice', 'sales_credit'] : ['purchase_bill', 'purchase_credit'];
      // Sign so that a positive number is what the party owes us (receivable) / we owe them (payable).
      const docs = db.all<{ id: number; kind: string; party_id: number; number: string; date: string; due_date: string; outstanding: number }>(
        `SELECT d.id, d.kind, d.party_id, d.number, d.date, d.due_date,
                d.total - COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.document_id = d.id AND s.date <= :asOf), 0)
                        - (CASE WHEN d.kind IN ('sales_credit', 'purchase_credit')
                                THEN COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.source_type = 'credit' AND s.source_id = d.id AND s.date <= :asOf), 0)
                                ELSE 0 END) AS outstanding
         FROM documents d
         WHERE d.kind IN (${kinds.map((k) => `'${k}'`).join(',')}) AND d.date <= :asOf
           AND (d.status = 'posted' OR (d.status = 'void' AND substr(d.voided_at, 1, 10) > :asOf))`,
        { asOf: q.asOf },
      );
      const buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
      type B = (typeof buckets)[number];
      const bucketOf = (due: string): B => {
        const late = daysBetween(due, q.asOf);
        if (late <= 0) return 'current';
        if (late <= 30) return 'd1_30';
        if (late <= 60) return 'd31_60';
        if (late <= 90) return 'd61_90';
        return 'd90_plus';
      };
      const byParty = new Map<number, Record<B | 'documents' | 'unapplied' | 'total', number>>();
      const blank = () => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, documents: 0, unapplied: 0, total: 0 });
      const details: (typeof docs[number] & { bucket: B; days_overdue: number })[] = [];
      for (const d of docs) {
        if (d.outstanding === 0) continue;
        const sign = d.kind === 'sales_invoice' || d.kind === 'purchase_bill' ? 1 : -1;
        const amt = d.outstanding * sign;
        const b = sign === 1 ? bucketOf(d.due_date) : 'current';
        const row = byParty.get(d.party_id) ?? blank();
        row[b] += amt;
        row.documents += amt;
        byParty.set(d.party_id, row);
        details.push({ ...d, outstanding: amt, bucket: b, days_overdue: Math.max(0, daysBetween(d.due_date, q.asOf)) });
      }
      // Reconcile with the ledger: anything not explained by documents (payments on account, opening balances).
      const ledgerBal = db.all<{ party_id: number; bal: number }>(
        `SELECT l.party_id, SUM(${q.type === 'receivable' ? 'l.debit - l.credit' : 'l.credit - l.debit'}) AS bal
         FROM ledger l JOIN accounts a ON a.id = l.account_id
         WHERE a.subtype = :sub AND l.party_id IS NOT NULL AND l.date <= :asOf GROUP BY l.party_id`,
        { sub: q.type, asOf: q.asOf },
      );
      for (const lb of ledgerBal) {
        const row = byParty.get(lb.party_id) ?? blank();
        row.unapplied = lb.bal - row.documents;
        byParty.set(lb.party_id, row);
      }
      const names = services.get('parties').names([...byParty.keys()]);
      const rows = [...byParty.entries()]
        .map(([partyId, v]) => ({ party_id: partyId, party_name: names.get(partyId) ?? '', ...v, total: v.documents + v.unapplied }))
        .filter((x) => x.total !== 0 || x.documents !== 0)
        .sort((a, b) => b.total - a.total);
      const totals = blank();
      for (const x of rows) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += x[k];
      return { ...q, rows, totals, details };
    });

    /** Home-page figures for a side: overdue / due soon documents and the largest balances. */
    r.get('/documents/overview', 'auth', ({ query, user }) => {
      const side = parse(z.enum(['sales', 'purchases']), query.side) as DocSide;
      needSide(user, side);
      const t = today();
      const kind = side === 'sales' ? 'sales_invoice' : 'purchase_bill';
      const overdue = db.get<{ n: number; amount: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(total - amount_settled), 0) amount FROM documents
         WHERE kind = ? AND status = 'posted' AND amount_settled < total AND due_date < ?`,
        [kind, t],
      )!;
      const dueSoon = db.get<{ n: number; amount: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(total - amount_settled), 0) amount FROM documents
         WHERE kind = ? AND status = 'posted' AND amount_settled < total AND due_date BETWEEN ? AND ?`,
        [kind, t, addDays(t, 7)],
      )!;
      const drafts = db.get<{ n: number }>(`SELECT COUNT(*) n FROM documents WHERE status = 'draft' AND kind LIKE ?`, [side === 'sales' ? 'sales_%' : 'purchase_%'])!.n;
      const top = db.all(
        `SELECT l.party_id, p.name, SUM(${side === 'sales' ? 'l.debit - l.credit' : 'l.credit - l.debit'}) AS balance
         FROM ledger l JOIN accounts a ON a.id = l.account_id JOIN parties p ON p.id = l.party_id
         WHERE a.subtype = ? GROUP BY l.party_id HAVING balance > 0 ORDER BY balance DESC LIMIT 5`,
        [side === 'sales' ? 'receivable' : 'payable'],
      );
      return { side, overdue, dueSoon, drafts, top };
    });

    r.delete('/documents/:id', 'auth', ({ params, user }) => {
      const d = docs.get(Number(params.id));
      need(user, d.kind, 'write');
      docs.remove(d.id, user.id);
      return { ok: true };
    });
  },
};
