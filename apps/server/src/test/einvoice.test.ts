import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupCompany, type TestClient } from './helpers.js';
import { buildDocument, canonical, DEFAULT_SETTINGS, sha256 } from '../modules/einvoice/eta.js';

/**
 * A fake ETA (login, submissions, status, cancellation) and a fake signer, both on localhost.
 * The fake refuses any document whose receiver has no name, and marks "INV-00002" invalid later.
 */
function fakeEta() {
  const seen: { submissions: any[]; signed: string[]; cancels: string[]; tokens: number } = { submissions: [], signed: [], cancels: [], tokens: 0 };
  const status = new Map<string, string>();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = req.url ?? '';
    if (url === '/connect/token') {
      const form = new URLSearchParams(body);
      if (form.get('client_secret') !== 'secret') return send(400, { error: 'invalid_client' });
      seen.tokens++;
      return send(200, { access_token: 'tok', expires_in: 3600 });
    }
    if (url === '/sign') {
      const b = JSON.parse(body);
      seen.signed.push(b.hash);
      return send(200, { signature: `SIG-${b.hash.slice(0, 8)}` });
    }
    if (req.headers.authorization !== 'Bearer tok') return send(401, { message: 'no token' });
    if (url === '/api/v1/documentsubmissions' && req.method === 'POST') {
      const docs = JSON.parse(body).documents;
      seen.submissions.push(docs);
      const accepted: any[] = [];
      const rejected: any[] = [];
      for (const d of docs) {
        if (!d.receiver.name) rejected.push({ internalId: d.internalID, error: { message: 'Validation error', details: [{ message: 'Receiver name is required', target: 'receiver.name' }] } });
        else {
          const uuid = `UUID-${d.internalID}`;
          status.set(uuid, d.internalID === 'INV-00002' ? 'Invalid' : 'Valid');
          accepted.push({ uuid, longId: `LONG-${d.internalID}`, internalId: d.internalID });
        }
      }
      return send(202, { submissionId: `SUB-${seen.submissions.length}`, acceptedDocuments: accepted, rejectedDocuments: rejected });
    }
    const details = url.match(/^\/api\/v1\/documents\/([^/]+)\/details$/);
    if (details) {
      const s = status.get(decodeURIComponent(details[1]));
      if (!s) return send(404, { message: 'not found' });
      return send(200, {
        status: s,
        longId: 'LONG',
        validationResults: s === 'Invalid' ? { validationSteps: [{ status: 'Invalid', error: { error: 'Wrong totals', propertyPath: 'totalAmount', innerError: [] } }] } : { validationSteps: [] },
      });
    }
    const cancel = url.match(/^\/api\/v1\.0\/documents\/state\/([^/]+)\/state$/);
    if (cancel && req.method === 'PUT') {
      const uuid = decodeURIComponent(cancel[1]);
      seen.cancels.push(uuid);
      status.set(uuid, 'Cancelled');
      return send(200, {});
    }
    send(404, { message: 'no route ' + url });
  });
  return { server, seen };
}

describe('e-invoicing (Egyptian Tax Authority)', () => {
  let c: TestClient;
  let eta: ReturnType<typeof fakeEta>;
  let base: string;
  let customer: number, business: number, vat: number, item: number;
  const K = 100;
  const settings = () => ({
    enabled: true,
    environment: 'custom',
    apiUrl: base,
    idUrl: base,
    clientId: 'client',
    clientSecret: 'secret',
    version: '1.0',
    signerUrl: `${base}/sign`,
    rin: '123456789',
    issuerName: 'Test Co',
    branchId: '0',
    activityCode: '4620',
    governate: 'Cairo',
    regionCity: 'Nasr City',
    street: '1 Tahrir St',
    buildingNumber: '1',
    defaultCodeType: 'EGS',
    defaultItemCode: null,
    defaultUnitType: 'EA',
    untaxedSubType: 'V004',
  });

  before(async () => {
    eta = fakeEta();
    await new Promise<void>((ok) => eta.server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(eta.server.address() as AddressInfo).port}`;
    c = await setupCompany();
    vat = (await c.get('/api/taxes')).find((t: any) => t.code === 'VAT').id;
    business = (await c.post('/api/parties', { kind: 'customer', name: 'Nile Hotels', taxNumber: '987-654-321', city: 'Giza', address: '5 Pyramids Rd' })).id;
    customer = (await c.post('/api/parties', { kind: 'customer', name: 'Ahmed Ali' })).id;
    item = (await c.post('/api/items', { sku: 'CH-1', nameEn: 'Chair', nameAr: 'كرسي', kind: 'service', salePrice: 1000 * K })).id;
  });
  after(async () => {
    await c.close();
    eta.server.close();
  });

  test('canonical form: upper-case names in quotes, array names before each element', () => {
    assert.equal(canonical({ a: 'x', lines: [{ q: 1 }, { q: 2.5 }], n: { b: null } }), '"A""x""LINES""LINES""Q""1""LINES""Q""2.5""N""B"""');
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('the document: amounts in pounds, 14% VAT as T1/V009, a person below the ID limit', () => {
    const { document, problems } = buildDocument(
      {
        id: 1, kind: 'sales_invoice', number: 'INV-1', date: '2026-03-01', postedAt: '2026-03-01T10:20:30.000Z', currency: 'EGP', exchangeRate: 1_000_000, reference: null, originalUuid: null, hasOriginal: false,
        party: { name: 'Ahmed', taxNumber: null, country: null, city: null, address: null },
        lines: [{ description: 'Chair', itemCode: { codeType: 'EGS', itemCode: 'EG-123-1', unitType: null }, sku: 'CH-1', quantity: 2500, discount: 25_000, net: 225_000, tax: 31_500, taxRateBp: 1400, taxCode: { taxType: 'T1', subType: 'V009' }, hasTax: true }],
      },
      { ...DEFAULT_SETTINGS, ...(settings() as any) },
      2,
      '2026-03-01',
    );
    assert.deepEqual(problems, []);
    const line = (document.invoiceLines as any[])[0];
    assert.deepEqual([line.quantity, line.salesTotal, line.discount.amount, line.netTotal, line.total, line.unitValue.amountEGP], [2.5, 2500, 250, 2250, 2565, 1000]);
    assert.deepEqual(line.taxableItems, [{ taxType: 'T1', amount: 315, subType: 'V009', rate: 14 }]);
    assert.deepEqual([document.totalAmount, (document.receiver as any).type, document.dateTimeIssued], [2565, 'P', '2026-03-01T10:20:30Z']);
  });

  test('posting queues nothing while switched off; settings keep the secret hidden', async () => {
    await c.post('/api/documents', { kind: 'sales_invoice', partyId: business, date: '2026-02-01', post: true, lines: [{ description: 'Before', quantity: 1000, unitPrice: 10 * K }] });
    assert.equal((await c.get('/api/einvoice/documents')).rows.length, 0);
    await c.put('/api/einvoice/settings', settings());
    const s = await c.get('/api/einvoice/settings');
    assert.deepEqual([s.clientSecret, s.hasSecret, s.problems.length], [null, true, 0]);
    await c.put('/api/einvoice/settings', { ...settings(), clientSecret: '' });
    assert.equal((await c.get('/api/einvoice/settings')).hasSecret, true, 'an empty secret keeps the stored one');
    assert.deepEqual(await c.post('/api/einvoice/test'), { ok: true });
    const q = await c.post('/api/einvoice/queue', { from: '2026-01-01' });
    assert.equal(q.queued, 1, 'documents posted before can be queued');
  });

  test('missing item codes are reported, then sent, signed, accepted and checked', async () => {
    const inv = await c.post('/api/documents', {
      kind: 'sales_invoice', partyId: business, date: '2026-03-01', post: true,
      lines: [{ itemId: item, description: 'Chair', quantity: 2000, unitPrice: 1000 * K, taxId: vat }],
    });
    const view = await c.get(`/api/einvoice/documents/${inv.id}`);
    assert.equal(view.row.status, 'pending');
    assert.ok(view.problems.some((p: any) => p.code === 'einvoice.p.item_code'));
    const first = await c.post('/api/einvoice/submit', { documentIds: [inv.id] });
    assert.equal(first.results[0].status, 'not_ready');
    assert.equal(eta.seen.submissions.length, 0);

    await c.put(`/api/einvoice/codes/items/${item}`, { codeType: 'EGS', itemCode: 'EG-123456789-1', unitType: 'EA' });
    await c.put('/api/einvoice/settings', { ...settings(), defaultItemCode: 'EG-123456789-99' });
    const sent = await c.post('/api/einvoice/submit', {});
    assert.deepEqual(sent.results.map((r: any) => r.status).sort(), ['submitted', 'submitted']);
    const doc = eta.seen.submissions[0].find((d: any) => d.internalID === 'INV-00002');
    assert.equal(doc.receiver.id, '987654321');
    assert.equal(doc.receiver.type, 'B');
    assert.equal(doc.totalAmount, 2280);
    assert.equal(doc.signatures[0].value, `SIG-${eta.seen.signed[1].slice(0, 8)}`);
    const { signatures, ...unsigned } = doc;
    void signatures;
    assert.equal(sha256(canonical(unsigned)), eta.seen.signed[1], 'the signer signed the canonical form of what was sent');

    const checked = await c.post('/api/einvoice/refresh', {});
    const byId = Object.fromEntries(checked.results.map((r: any) => [r.documentId, r.status]));
    assert.equal(byId[inv.id], 'invalid');
    const v = await c.get(`/api/einvoice/documents/${inv.id}`);
    assert.match(v.row.problems[0].message, /Wrong totals/);
    assert.equal((await c.post('/api/einvoice/submit', {})).results.length, 1, 'an invalid document can be sent again');
  });

  test('a credit note needs its accepted invoice; cancel and void', async () => {
    const inv = await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-04-01', post: true, lines: [{ description: 'Service', quantity: 1000, unitPrice: 500 * K }] });
    const cn = await c.post('/api/documents', { kind: 'sales_credit', partyId: customer, date: '2026-04-02', againstDocumentId: inv.id, post: true, lines: [{ description: 'Back', quantity: 1000, unitPrice: 100 * K }] });
    const early = await c.post('/api/einvoice/submit', { documentIds: [cn.id] });
    assert.equal(early.results[0].status, 'not_ready');
    await c.post('/api/einvoice/submit', { documentIds: [inv.id] });
    await c.post('/api/einvoice/refresh', { documentIds: [inv.id] });
    assert.equal((await c.get(`/api/einvoice/documents/${inv.id}`)).row.status, 'valid');
    await c.post('/api/einvoice/submit', { documentIds: [cn.id] });
    const credit = eta.seen.submissions.at(-1)[0];
    assert.deepEqual([credit.documentType, credit.references], ['C', [`UUID-${(await c.get(`/api/documents/${inv.id}`)).number}`]]);

    const bad = await c.raw('POST', `/api/einvoice/documents/${cn.id}/cancel`, { reason: 'x' });
    assert.equal(bad.status, 400);
    await c.post(`/api/einvoice/documents/${cn.id}/cancel`, { reason: 'Issued by mistake' });
    await c.post('/api/einvoice/refresh', {});
    assert.equal((await c.get(`/api/einvoice/documents/${cn.id}`)).row.status, 'cancelled');

    const loose = await c.post('/api/documents', { kind: 'sales_credit', partyId: customer, date: '2026-04-02', post: true, lines: [{ description: 'Goodwill', quantity: 1000, unitPrice: 10 * K }] });
    assert.ok((await c.get(`/api/einvoice/documents/${loose.id}`)).problems.some((p: any) => p.code === 'einvoice.p.no_original'));
    const future = await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2099-01-01', post: true, lines: [{ description: 'Later', quantity: 1000, unitPrice: 10 * K }] }).catch(() => null);
    if (future) assert.ok((await c.get(`/api/einvoice/documents/${future.id}`)).problems.some((p: any) => p.code === 'einvoice.p.future'));
    const draft = await c.post('/api/documents', { kind: 'sales_invoice', partyId: customer, date: '2026-04-03', post: true, lines: [{ description: 'Oops', quantity: 1000, unitPrice: 5 * K }] });
    await c.post(`/api/documents/${draft.id}/void`, {});
    assert.equal((await c.get(`/api/einvoice/documents/${draft.id}`)).row.status, 'skipped', 'a voided document never sent is not sent');
  });

  test('wrong credentials are reported, and a viewer cannot send', async () => {
    await c.put('/api/einvoice/settings', { ...settings(), clientSecret: 'wrong' });
    const t = await c.post('/api/einvoice/test');
    assert.equal(t.ok, false);
    assert.match(t.message, /invalid_client/);
    await c.put('/api/einvoice/settings', settings());
    await c.post('/api/users', { username: 'viewer3', displayName: 'Viewer', password: 'password123', role: 'viewer' });
    const cookie = await c.login('viewer3', 'password123');
    assert.equal((await c.raw('POST', '/api/einvoice/submit', {}, cookie)).status, 403);
  });
});
