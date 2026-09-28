import { z } from 'zod';
import type { AppModule, ModuleContext } from '../../kernel/modules.js';
import { conflict, fail, notFound } from '../../kernel/errors.js';
import { nowIso, today } from '../../kernel/dates.js';
import { parse, zDate, zId } from '../../kernel/validate.js';
import { buildDocument, canonical, DEFAULT_SETTINGS, ENDPOINTS, settingsProblems, sha256, type EtaSettings, type Problem, type SourceDoc } from './eta.js';

/**
 * E-invoicing with the Egyptian Tax Authority.
 *
 * Posting a sales invoice or credit note queues it here (nothing leaves the building inside the
 * posting transaction). "Send" builds the ETA documents, has the taxpayer's signer sign them,
 * submits them, and "Refresh" asks the ETA for the result (valid / invalid / cancelled).
 */

type Status = 'pending' | 'submitted' | 'valid' | 'invalid' | 'rejected' | 'cancel_requested' | 'cancelled' | 'skipped';

interface Row {
  document_id: number;
  status: Status;
  uuid: string | null;
  long_id: string | null;
  submission_id: string | null;
  hash: string | null;
  problems: string | null;
  attempts: number;
  submitted_at: string | null;
  checked_at: string | null;
}

const zText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const zUrl = z
  .string()
  .trim()
  .max(300)
  .regex(/^https?:\/\/\S+$/)
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v.replace(/\/+$/, '') : null));
const zSettings = z.object({
  enabled: z.boolean(),
  environment: z.enum(['preprod', 'prod', 'custom']),
  apiUrl: zUrl,
  idUrl: zUrl,
  clientId: zText(200),
  /** Left empty = keep the stored secret. */
  clientSecret: zText(200),
  version: z.enum(['1.0', '0.9']),
  signerUrl: zUrl,
  rin: zText(20),
  issuerName: zText(200),
  branchId: z.string().trim().max(20).default('0'),
  activityCode: zText(10),
  governate: zText(100),
  regionCity: zText(100),
  street: zText(200),
  buildingNumber: zText(50),
  defaultCodeType: z.enum(['EGS', 'GS1']).default('EGS'),
  defaultItemCode: zText(100),
  defaultUnitType: z.string().trim().min(1).max(10).default('EA'),
  untaxedSubType: z.string().trim().min(1).max(10).default('V004'),
});
const zItemCode = z.object({ codeType: z.enum(['EGS', 'GS1']), itemCode: z.string().trim().min(1).max(100), unitType: zText(10) });
const zTaxCode = z.object({ taxType: z.string().trim().regex(/^T\d{1,2}$/), subType: z.string().trim().min(1).max(10) });
const zIds = z.object({ documentIds: z.array(zId).max(500).nullish() });

class EtaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function createEinvoice({ db, services }: ModuleContext) {
  const settings = (): EtaSettings => ({ ...DEFAULT_SETTINGS, ...JSON.parse(db.get<{ data: string }>('SELECT data FROM einvoice_settings WHERE id = 1')?.data ?? '{}') });
  const company = () => services.get('settings').company();
  const endpoints = (s: EtaSettings) => (s.environment === 'custom' ? { api: s.apiUrl ?? '', id: s.idUrl ?? '' } : ENDPOINTS[s.environment]);

  /** What the ETA needs of one posted document, read from the documents, parties and catalog tables. */
  function source(id: number): SourceDoc {
    const d = db.get<{ id: number; kind: SourceDoc['kind']; number: string; date: string; posted_at: string | null; currency: string; exchange_rate: number; reference: string | null; against_document_id: number | null; name: string; tax_number: string | null; country: string | null; city: string | null; address: string | null }>(
      `SELECT d.id, d.kind, d.number, d.date, d.posted_at, d.currency, d.exchange_rate, d.reference, d.against_document_id, p.name, p.tax_number, p.country, p.city, p.address
         FROM documents d JOIN parties p ON p.id = d.party_id WHERE d.id = ?`,
      [id],
    );
    if (!d) notFound('document');
    const lines = db.all<{ description: string; item_id: number | null; sku: string | null; quantity: number; discount: number; net: number; tax: number; tax_rate_bp: number; tax_id: number | null }>(
      `SELECT l.description, l.item_id, i.sku, l.quantity, l.discount, l.net, l.tax, l.tax_rate_bp, l.tax_id
         FROM document_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.document_id = ? ORDER BY l.line_no`,
      [id],
    );
    const itemCode = (itemId: number | null) =>
      itemId == null ? null : (db.get<{ codeType: string; itemCode: string; unitType: string | null }>('SELECT code_type codeType, item_code itemCode, unit_type unitType FROM einvoice_item_codes WHERE item_id = ?', [itemId]) ?? null);
    const taxCode = (taxId: number | null, rateBp: number) => {
      if (taxId == null) return null;
      const m = db.get<{ taxType: string; subType: string }>('SELECT tax_type taxType, sub_type subType FROM einvoice_tax_codes WHERE tax_id = ?', [taxId]);
      // Egypt's standard 14% VAT is T1 / V009 unless mapped otherwise.
      return m ?? (rateBp === 1400 ? { taxType: 'T1', subType: 'V009' } : null);
    };
    return {
      id: d!.id,
      kind: d!.kind,
      number: d!.number,
      date: d!.date,
      postedAt: d!.posted_at,
      currency: d!.currency,
      exchangeRate: d!.exchange_rate,
      reference: d!.reference,
      party: { name: d!.name, taxNumber: d!.tax_number, country: d!.country, city: d!.city, address: d!.address },
      hasOriginal: d!.against_document_id != null,
      originalUuid: d!.against_document_id ? (db.get<{ uuid: string }>("SELECT uuid FROM einvoice_documents WHERE document_id = ? AND status IN ('valid', 'submitted')", [d!.against_document_id])?.uuid ?? null) : null,
      lines: lines.map((l) => ({
        description: l.description,
        itemCode: itemCode(l.item_id),
        sku: l.sku,
        quantity: l.quantity,
        discount: l.discount,
        net: l.net,
        tax: l.tax,
        taxRateBp: l.tax_rate_bp,
        taxCode: taxCode(l.tax_id, l.tax_rate_bp),
        hasTax: l.tax_id != null && l.tax !== 0,
      })),
    };
  }

  const build = (id: number) => {
    const s = settings();
    const built = buildDocument(source(id), s, company().moneyScale, today());
    return { ...built, problems: [...settingsProblems(s, company().baseCurrency), ...built.problems] };
  };

  const row = (id: number) => db.get<Row>('SELECT * FROM einvoice_documents WHERE document_id = ?', [id]);
  const setRow = (id: number, patch: Partial<Row>) => {
    const keys = Object.keys(patch);
    db.run(`UPDATE einvoice_documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE document_id = ?`, [...keys.map((k) => ((patch as Record<string, unknown>)[k] ?? null) as string | number | null), nowIso(), id]);
  };
  const problemsJson = (p: Problem[]) => (p.length ? JSON.stringify(p) : null);

  function enqueue(documentId: number) {
    db.run("INSERT INTO einvoice_documents (document_id, status, attempts, created_at, updated_at) VALUES (?, 'pending', 0, ?, ?) ON CONFLICT(document_id) DO NOTHING", [documentId, nowIso(), nowIso()]);
  }

  // --- the ETA web service -------------------------------------------------------------------
  let token: { value: string; until: number; key: string } | null = null;
  const timeout = () => AbortSignal.timeout(30_000);

  async function http(url: string, init: RequestInit, what: string): Promise<any> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: timeout() });
    } catch (e) {
      throw new EtaError('einvoice.unreachable', `${what}: could not connect (${(e as Error).message})`);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text.slice(0, 300) };
    }
    if (!res.ok && res.status !== 202) {
      const msg = body?.error?.message ?? body?.error_description ?? body?.error ?? body?.message ?? res.statusText;
      throw new EtaError('einvoice.refused', `${what}: ${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return body;
  }

  async function accessToken(s: EtaSettings): Promise<string> {
    const key = `${endpoints(s).id}|${s.clientId}|${s.clientSecret}`;
    if (token && token.key === key && token.until > Date.now()) return token.value;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId ?? '', client_secret: s.clientSecret ?? '', scope: 'InvoicingAPI' });
    const b = await http(`${endpoints(s).id}/connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 'Login to the ETA');
    if (!b?.access_token) throw new EtaError('einvoice.refused', 'Login to the ETA: no access token returned');
    token = { value: b.access_token, until: Date.now() + Math.max(60, (b.expires_in ?? 3600) - 60) * 1000, key };
    return token.value;
  }
  const api = async (s: EtaSettings, path: string, init: RequestInit, what: string) =>
    http(`${endpoints(s).api}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await accessToken(s)}`, 'content-type': 'application/json' } }, what);

  async function sign(s: EtaSettings, document: Record<string, unknown>, hash: string, text: string): Promise<string> {
    const b = await http(s.signerUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash, canonical: text, document }) }, 'The signer');
    if (!b?.signature || typeof b.signature !== 'string') throw new EtaError('einvoice.signer', 'The signer returned no signature');
    return b.signature;
  }

  // One send / refresh at a time: they wait on the network between database steps.
  let busy = false;
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) conflict('einvoice.busy', 'Another send or refresh is running — try again in a moment');
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  const ready = (s: EtaSettings) => {
    if (!s.enabled) fail('einvoice.disabled', 'E-invoicing is switched off in its settings');
    const p = settingsProblems(s, company().baseCurrency);
    if (p.length) fail('einvoice.not_ready', p[0].message);
  };

  /** Build, sign and submit the chosen pending documents (or all of them). */
  async function submit(ids: number[] | null) {
    return exclusive(async () => {
      const s = settings();
      ready(s);
      const candidates = db
        .all<{ document_id: number }>("SELECT document_id FROM einvoice_documents WHERE status IN ('pending', 'invalid', 'rejected') ORDER BY document_id")
        .map((r) => r.document_id)
        .filter((id) => !ids || ids.includes(id))
        // The ETA takes at most 100 documents per submission; credit notes wait for their invoice.
        .slice(0, 100);
      const results: { documentId: number; status: Status | 'not_ready' | 'error'; message?: string }[] = [];
      const batch: { id: number; doc: Record<string, unknown>; hash: string }[] = [];
      for (const id of candidates) {
        const { document, problems } = build(id);
        if (problems.length) {
          setRow(id, { problems: problemsJson(problems) });
          results.push({ documentId: id, status: 'not_ready', message: problems[0].message });
          continue;
        }
        const text = canonical(document);
        const hash = sha256(text);
        try {
          if (s.version === '1.0') document.signatures = [{ signatureType: 'I', value: await sign(s, document, hash, text) }];
        } catch (e) {
          setRow(id, { problems: problemsJson([{ code: (e as EtaError).code ?? 'einvoice.signer', message: (e as Error).message }]) });
          results.push({ documentId: id, status: 'error', message: (e as Error).message });
          continue;
        }
        batch.push({ id, doc: document, hash });
      }
      if (!batch.length) return { submissionId: null, results };
      const res = await api(s, '/api/v1/documentsubmissions', { method: 'POST', body: JSON.stringify({ documents: batch.map((b) => b.doc) }) }, 'Submit to the ETA');
      const byInternal = new Map(batch.map((b) => [String(b.doc.internalID), b]));
      const now = nowIso();
      db.tx(() => {
        for (const a of res?.acceptedDocuments ?? []) {
          const b = byInternal.get(String(a.internalId));
          if (!b) continue;
          byInternal.delete(String(a.internalId));
          setRow(b.id, { status: 'submitted', uuid: a.uuid, long_id: a.longId ?? null, submission_id: res.submissionId ?? null, hash: b.hash, problems: null, submitted_at: now, attempts: (row(b.id)?.attempts ?? 0) + 1 });
          results.push({ documentId: b.id, status: 'submitted' });
        }
        for (const r of res?.rejectedDocuments ?? []) {
          const b = byInternal.get(String(r.internalId));
          if (!b) continue;
          byInternal.delete(String(r.internalId));
          // The details say what is wrong; the top message is only "Validation error" when details exist.
          const details: Problem[] = (r.error?.details?.length ? r.error.details : [r.error])
            .filter((x: any) => x?.message)
            .map((x: any) => ({ code: 'einvoice.p.eta', message: `${x.message}${x.target ? ` (${x.target})` : ''}` }));
          setRow(b.id, { status: 'rejected', problems: problemsJson(details.length ? details : [{ code: 'einvoice.p.eta', message: 'Rejected by the ETA' }]), attempts: (row(b.id)?.attempts ?? 0) + 1 });
          results.push({ documentId: b.id, status: 'rejected', message: details[0]?.message });
        }
        // Neither accepted nor rejected: leave it pending, it will be sent again.
        for (const b of byInternal.values()) results.push({ documentId: b.id, status: 'error', message: 'The ETA did not answer for this document' });
      });
      return { submissionId: res?.submissionId ?? null, results };
    });
  }

  const ETA_STATUS: Record<string, Status> = { valid: 'valid', invalid: 'invalid', cancelled: 'cancelled', rejected: 'invalid', submitted: 'submitted' };

  /** Ask the ETA for the result of submitted documents (and cancellations asked for). */
  async function refresh(ids: number[] | null) {
    return exclusive(async () => {
      const s = settings();
      ready(s);
      const rows = db
        .all<Row>("SELECT * FROM einvoice_documents WHERE status IN ('submitted', 'cancel_requested', 'valid') AND uuid IS NOT NULL ORDER BY document_id")
        // Accepted documents are watched for 10 days: the buyer may still reject them, or they may be cancelled on the portal.
        .filter((r) => (ids ? ids.includes(r.document_id) : r.status !== 'valid' || (r.submitted_at ?? '') >= new Date(Date.now() - 10 * 86_400_000).toISOString()))
        .slice(0, 200);
      const results: { documentId: number; status: Status; message?: string }[] = [];
      for (const r of rows) {
        let b: any;
        try {
          b = await api(s, `/api/v1/documents/${encodeURIComponent(r.uuid!)}/details`, { method: 'GET' }, 'Read the ETA status');
        } catch (e) {
          results.push({ documentId: r.document_id, status: r.status, message: (e as Error).message });
          continue;
        }
        const eta = String(b?.status ?? '').toLowerCase();
        let next = ETA_STATUS[eta] ?? r.status;
        // A cancellation stays "requested" until the ETA says it is cancelled (the buyer may decline it).
        if (r.status === 'cancel_requested' && next === 'valid') next = 'cancel_requested';
        const steps: Problem[] = (b?.validationResults?.validationSteps ?? [])
          .filter((v: any) => String(v?.status).toLowerCase() === 'invalid')
          .flatMap((v: any) => [v.error, ...(v.error?.innerError ?? [])].filter((x: any) => x?.error || x?.errorCode))
          .map((x: any) => ({ code: 'einvoice.p.eta', message: `${x.error ?? x.errorCode}${x.propertyPath ? ` (${x.propertyPath})` : ''}` }));
        setRow(r.document_id, { status: next, long_id: b?.longId ?? r.long_id, checked_at: nowIso(), problems: next === 'invalid' ? problemsJson(steps.length ? steps : [{ code: 'einvoice.p.eta', message: 'Invalid' }]) : null });
        results.push({ documentId: r.document_id, status: next });
      }
      return { results };
    });
  }

  async function cancel(id: number, reason: string) {
    return exclusive(async () => {
      const s = settings();
      ready(s);
      const r = row(id);
      if (!r) notFound('e-invoice');
      if (r!.status !== 'valid' && r!.status !== 'submitted') conflict('einvoice.not_cancellable', 'Only a document the ETA accepted can be cancelled');
      await api(s, `/api/v1.0/documents/state/${encodeURIComponent(r!.uuid!)}/state`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled', reason }) }, 'Cancel at the ETA');
      setRow(id, { status: 'cancel_requested' });
      return { status: 'cancel_requested' as Status };
    });
  }

  return { settings, build, row, enqueue, submit, refresh, cancel, accessToken, endpoints };
}

const SALES = new Set(['sales_invoice', 'sales_credit']);

export const einvoiceModule: AppModule = {
  id: 'einvoice',
  dependsOn: ['ledger', 'parties', 'catalog', 'documents'],
  permissions: ['einvoice.documents.read', 'einvoice.documents.post', 'einvoice.settings.manage'],
  apps: [{ id: 'einvoice', order: 36, requires: ['ar'], permissions: ['einvoice'] }],
  roles: [{ id: 'einvoice_clerk', permissions: ['einvoice.documents.*', 'ar.invoices.read', 'ar.customers.read'] }],
  migrations: [
    {
      id: '001_einvoice',
      up: `
        CREATE TABLE einvoice_settings (
          id   INTEGER PRIMARY KEY CHECK (id = 1),
          data TEXT NOT NULL
        );
        CREATE TABLE einvoice_item_codes (
          item_id   INTEGER PRIMARY KEY REFERENCES items(id),
          code_type TEXT NOT NULL CHECK (code_type IN ('EGS', 'GS1')),
          item_code TEXT NOT NULL,
          unit_type TEXT
        );
        CREATE TABLE einvoice_tax_codes (
          tax_id   INTEGER PRIMARY KEY REFERENCES taxes(id),
          tax_type TEXT NOT NULL,
          sub_type TEXT NOT NULL
        );
        -- One row per posted sales invoice / credit note sent (or to be sent) to the ETA.
        CREATE TABLE einvoice_documents (
          document_id   INTEGER PRIMARY KEY REFERENCES documents(id),
          status        TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'valid', 'invalid', 'rejected', 'cancel_requested', 'cancelled', 'skipped')),
          uuid          TEXT UNIQUE,
          long_id       TEXT,
          submission_id TEXT,
          hash          TEXT,
          problems      TEXT,                     -- JSON [{code, message, values}]
          attempts      INTEGER NOT NULL DEFAULT 0,
          submitted_at  TEXT,
          checked_at    TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE INDEX einvoice_documents_status ON einvoice_documents(status);
      `,
    },
  ],
  health({ db }) {
    const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM einvoice_documents WHERE status IN ('invalid', 'rejected')")!.n;
    return [{ id: 'refused', ok: n === 0, details: { count: n }, severity: 'warning' }];
  },
  setup(ctx) {
    const ei = createEinvoice(ctx);
    const on = () => ctx.apps.isEnabled('einvoice') && ei.settings().enabled;
    ctx.events.on('document.posted', (e) => {
      if (SALES.has(e.kind) && on()) ei.enqueue(e.documentId);
    });
    ctx.events.on('document.voided', (e) => {
      const r = ei.row(e.documentId);
      // Never sent: nothing to tell the ETA. Sent: it must be cancelled at the ETA too.
      if (r?.status === 'pending' || r?.status === 'rejected') ctx.db.run("UPDATE einvoice_documents SET status = 'skipped', updated_at = ? WHERE document_id = ?", [nowIso(), e.documentId]);
    });
  },
  routes(r, ctx) {
    // Its own instance: the event listeners above need none of the connection state kept here.
    const ei = createEinvoice(ctx);
    const { db } = ctx;
    const audit = (userId: number, action: string, summary: string) => ctx.services.get('audit').log({ userId, action, entity: 'einvoice', summary });

    r.get('/einvoice/settings', 'einvoice.settings.manage', () => {
      const s = ei.settings();
      return { ...s, clientSecret: null, hasSecret: !!s.clientSecret, problems: settingsProblems(s, ctx.services.get('settings').company().baseCurrency) };
    });
    r.put('/einvoice/settings', 'einvoice.settings.manage', ({ body, user }) => {
      const input = parse(zSettings, body);
      const old = ei.settings();
      const next = { ...input, clientSecret: input.clientSecret ?? old.clientSecret };
      db.run('INSERT INTO einvoice_settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', [JSON.stringify(next)]);
      audit(user.id, 'update', 'e-invoice settings');
      return { ok: true };
    });
    r.post('/einvoice/test', 'einvoice.settings.manage', async () => {
      const s = ei.settings();
      try {
        await ei.accessToken(s);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    });

    r.get('/einvoice/codes', 'einvoice.settings.manage', () => ({
      items: db.all(
        `SELECT i.id, i.sku, i.name_en, i.name_ar, i.unit, c.code_type, c.item_code, c.unit_type FROM items i LEFT JOIN einvoice_item_codes c ON c.item_id = i.id WHERE i.is_active = 1 ORDER BY i.sku`,
      ),
      taxes: db.all(`SELECT t.id, t.code, t.name_en, t.name_ar, t.rate_bp, c.tax_type, c.sub_type FROM taxes t LEFT JOIN einvoice_tax_codes c ON c.tax_id = t.id ORDER BY t.code`),
    }));
    r.put('/einvoice/codes/items/:id', 'einvoice.settings.manage', ({ params, body }) => {
      const id = parse(zId, Number(params.id));
      if (!db.get('SELECT 1 FROM items WHERE id = ?', [id])) notFound('item');
      const c = parse(zItemCode.nullable(), body ?? null);
      if (!c) db.run('DELETE FROM einvoice_item_codes WHERE item_id = ?', [id]);
      else
        db.run('INSERT INTO einvoice_item_codes (item_id, code_type, item_code, unit_type) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET code_type = excluded.code_type, item_code = excluded.item_code, unit_type = excluded.unit_type', [
          id,
          c.codeType,
          c.itemCode,
          c.unitType,
        ]);
      return { ok: true };
    });
    r.put('/einvoice/codes/taxes/:id', 'einvoice.settings.manage', ({ params, body }) => {
      const id = parse(zId, Number(params.id));
      if (!db.get('SELECT 1 FROM taxes WHERE id = ?', [id])) notFound('tax');
      const c = parse(zTaxCode.nullable(), body ?? null);
      if (!c) db.run('DELETE FROM einvoice_tax_codes WHERE tax_id = ?', [id]);
      else db.run('INSERT INTO einvoice_tax_codes (tax_id, tax_type, sub_type) VALUES (?, ?, ?) ON CONFLICT(tax_id) DO UPDATE SET tax_type = excluded.tax_type, sub_type = excluded.sub_type', [id, c.taxType, c.subType]);
      return { ok: true };
    });

    r.get('/einvoice/documents', 'einvoice.documents.read', ({ query }) => {
      const status = query.status && query.status !== 'all' ? query.status : null;
      const rows = db.all<Row & { number: string; kind: string; date: string; total: number; currency: string; party_name: string }>(
        `SELECT e.*, d.number, d.kind, d.date, d.total, d.currency, p.name party_name
           FROM einvoice_documents e JOIN documents d ON d.id = e.document_id JOIN parties p ON p.id = d.party_id
          WHERE (? IS NULL OR e.status = ?) ORDER BY d.date DESC, e.document_id DESC LIMIT 1000`,
        [status, status],
      );
      const counts = Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM einvoice_documents GROUP BY status').map((x) => [x.status, x.n]));
      return { rows: rows.map((x) => ({ ...x, problems: x.problems ? JSON.parse(x.problems) : [] })), counts, enabled: ei.settings().enabled };
    });
    /** One document: its ETA state and, before it is accepted, what is still missing. */
    r.get('/einvoice/documents/:id', 'einvoice.documents.read', ({ params }) => {
      const id = parse(zId, Number(params.id));
      const d = db.get<{ kind: string; status: string }>('SELECT kind, status FROM documents WHERE id = ?', [id]);
      if (!d) notFound('document');
      const row = ei.row(id);
      const eligible = SALES.has(d!.kind) && d!.status === 'posted';
      const check = eligible && (!row || ['pending', 'invalid', 'rejected'].includes(row.status)) ? ei.build(id) : null;
      const s = ei.settings();
      const portal = s.environment === 'prod' ? 'https://invoicing.eta.gov.eg' : 'https://preprod.invoicing.eta.gov.eg';
      return {
        eligible,
        enabled: s.enabled,
        row: row ? { ...row, problems: row.problems ? JSON.parse(row.problems) : [] } : null,
        problems: check?.problems ?? [],
        document: check?.document ?? null,
        link: row?.uuid && row.long_id ? `${portal}/print/documents/${row.uuid}/share/${row.long_id}` : null,
      };
    });
    /** Queue posted sales documents from a date (e.g. those posted before e-invoicing was switched on). */
    r.post('/einvoice/queue', 'einvoice.documents.post', ({ body, user }) => {
      const q = parse(z.object({ from: zDate, to: zDate.nullish() }), body);
      const ids = db
        .all<{ id: number }>(
          `SELECT d.id FROM documents d WHERE d.kind IN ('sales_invoice', 'sales_credit') AND d.status = 'posted' AND d.date >= ? AND (? IS NULL OR d.date <= ?)
             AND NOT EXISTS (SELECT 1 FROM einvoice_documents e WHERE e.document_id = d.id) ORDER BY d.date, d.id`,
          [q.from, q.to ?? null, q.to ?? null],
        )
        .map((x) => x.id);
      db.tx(() => ids.forEach((id) => ei.enqueue(id)));
      if (ids.length) audit(user.id, 'queue', `${ids.length} documents from ${q.from}`);
      return { queued: ids.length };
    });
    r.post('/einvoice/submit', 'einvoice.documents.post', async ({ body, user }) => {
      const q = parse(zIds, body ?? {});
      const res = await ei.submit(q.documentIds ?? null);
      if (res.results.length) audit(user.id, 'submit', `${res.results.filter((x) => x.status === 'submitted').length} of ${res.results.length} documents submitted`);
      return res;
    });
    r.post('/einvoice/refresh', 'einvoice.documents.post', async ({ body }) => {
      const q = parse(zIds, body ?? {});
      return ei.refresh(q.documentIds ?? null);
    });
    r.post('/einvoice/documents/:id/cancel', 'einvoice.documents.post', async ({ params, body, user }) => {
      const id = parse(zId, Number(params.id));
      const q = parse(z.object({ reason: z.string().trim().min(3).max(500) }), body);
      const res = await ei.cancel(id, q.reason);
      audit(user.id, 'cancel', `document ${id}: ${q.reason}`);
      return res;
    });
    /** Skip a document the ETA must never see (e.g. an export sold before registration). */
    r.post('/einvoice/documents/:id/skip', 'einvoice.documents.post', ({ params, user }) => {
      const id = parse(zId, Number(params.id));
      const row = ei.row(id);
      if (!row) notFound('e-invoice');
      if (!['pending', 'invalid', 'rejected'].includes(row!.status)) conflict('einvoice.not_skippable', 'Only a document not accepted by the ETA can be skipped');
      db.run("UPDATE einvoice_documents SET status = 'skipped', updated_at = ? WHERE document_id = ?", [nowIso(), id]);
      audit(user.id, 'skip', `document ${id}`);
      return { ok: true };
    });
  },
};
