import { createHash } from 'node:crypto';

/**
 * Egyptian Tax Authority (ETA) e-invoice documents — pure building blocks.
 *
 * `buildDocument` turns a posted sales invoice or credit note into the ETA JSON (document type
 * version 1.0 or 0.9), and reports every problem that would make the ETA refuse it. `canonical`
 * is the ETA serialization that is hashed and signed (CAdES-BES) by the taxpayer's signer.
 */

export interface EtaSettings {
  enabled: boolean;
  environment: 'preprod' | 'prod' | 'custom';
  apiUrl: string | null;
  idUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  /** 1.0 needs a signature (the USB token); 0.9 is unsigned (pre-production testing only). */
  version: '1.0' | '0.9';
  /** A local service that signs a document hash with the taxpayer's token. */
  signerUrl: string | null;
  rin: string | null;
  issuerName: string | null;
  branchId: string;
  activityCode: string | null;
  governate: string | null;
  regionCity: string | null;
  street: string | null;
  buildingNumber: string | null;
  defaultCodeType: 'EGS' | 'GS1';
  defaultItemCode: string | null;
  defaultUnitType: string;
  /** The sub-type of lines that carry no tax (V004 = a non-taxable good or service). */
  untaxedSubType: string;
}

export const DEFAULT_SETTINGS: EtaSettings = {
  enabled: false,
  environment: 'preprod',
  apiUrl: null,
  idUrl: null,
  clientId: null,
  clientSecret: null,
  version: '1.0',
  signerUrl: null,
  rin: null,
  issuerName: null,
  branchId: '0',
  activityCode: null,
  governate: null,
  regionCity: null,
  street: null,
  buildingNumber: null,
  defaultCodeType: 'EGS',
  defaultItemCode: null,
  defaultUnitType: 'EA',
  untaxedSubType: 'V004',
};

export const ENDPOINTS = {
  preprod: { api: 'https://api.preprod.invoicing.eta.gov.eg', id: 'https://id.preprod.eta.gov.eg' },
  prod: { api: 'https://api.invoicing.eta.gov.eg', id: 'https://id.eta.gov.eg' },
} as const;

/** A problem, as a translation key with values (the English text is the fallback). */
export interface Problem {
  code: string;
  message: string;
  values?: Record<string, string | number>;
}

export interface SourceDoc {
  id: number;
  kind: 'sales_invoice' | 'sales_credit';
  number: string;
  date: string;
  postedAt: string | null;
  currency: string;
  /** × 1,000,000 */
  exchangeRate: number;
  reference: string | null;
  party: { name: string; taxNumber: string | null; country: string | null; city: string | null; address: string | null };
  /** The ETA uuid of the invoice a credit note corrects. */
  originalUuid: string | null;
  /** Whether the credit note was made against an invoice at all. */
  hasOriginal: boolean;
  lines: {
    description: string;
    itemCode: { codeType: string; itemCode: string; unitType: string | null } | null;
    sku: string | null;
    quantity: number;
    discount: number;
    net: number;
    tax: number;
    taxRateBp: number;
    taxCode: { taxType: string; subType: string } | null;
    hasTax: boolean;
  }[];
}

const EGYPT = new Set(['', 'EG', 'EGY', 'EGYPT', 'مصر']);
const PERSON_ID_LIMIT = 50_000;

/** Problems with the settings themselves (they block every document). */
export function settingsProblems(s: EtaSettings, baseCurrency: string): Problem[] {
  const out: Problem[] = [];
  const need = (v: string | null, field: string) => {
    if (!v || !v.trim()) out.push({ code: 'einvoice.p.setting', message: `Fill in: ${field}`, values: { field } });
  };
  if (baseCurrency !== 'EGP') out.push({ code: 'einvoice.p.currency', message: 'The company base currency must be EGP' });
  if (!s.rin || !/^\d{9}$/.test(s.rin)) out.push({ code: 'einvoice.p.rin', message: 'The tax registration number (RIN) must be 9 digits' });
  need(s.issuerName, 'issuerName');
  need(s.activityCode, 'activityCode');
  need(s.governate, 'governate');
  need(s.regionCity, 'regionCity');
  need(s.street, 'street');
  need(s.buildingNumber, 'buildingNumber');
  need(s.clientId, 'clientId');
  need(s.clientSecret, 'clientSecret');
  if (s.version === '1.0') need(s.signerUrl, 'signerUrl');
  if (s.version === '0.9' && s.environment === 'prod') out.push({ code: 'einvoice.p.unsigned', message: 'Unsigned documents (version 0.9) are accepted only in pre-production' });
  if (s.environment === 'custom') {
    need(s.apiUrl, 'apiUrl');
    need(s.idUrl, 'idUrl');
  }
  return out;
}

/** Minor units → an ETA amount (a number with at most 5 decimals). */
const amt = (minor: number, scale: number) => Number((minor / 10 ** scale).toFixed(Math.min(scale, 5)));
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** The ETA document for a posted sales invoice or credit note, with every problem found. */
export function buildDocument(doc: SourceDoc, s: EtaSettings, scale: number, today: string): { document: Record<string, unknown>; problems: Problem[] } {
  const problems: Problem[] = [];
  const foreign = doc.currency !== 'EGP';
  const toEgp = (minor: number) => (foreign ? Math.round((minor * doc.exchangeRate) / 1e6) : minor);

  // Receiver: F (foreign), B (business with a tax number) or P (person).
  const country = (doc.party.country ?? '').trim().toUpperCase();
  const isForeign = !EGYPT.has(country);
  const taxId = (doc.party.taxNumber ?? '').replace(/[\s-]/g, '');
  const type = isForeign ? 'F' : /^\d{9}$/.test(taxId) ? 'B' : 'P';
  if (isForeign && !/^[A-Z]{2}$/.test(country)) problems.push({ code: 'einvoice.p.country', message: `The customer's country must be a 2-letter code (found "${doc.party.country}")`, values: { country: doc.party.country ?? '' } });
  if (type === 'B' && (!doc.party.city || !doc.party.address)) problems.push({ code: 'einvoice.p.receiver_address', message: 'A business customer needs a city and an address' });
  if (type === 'P' && taxId && !/^\d{14}$/.test(taxId)) problems.push({ code: 'einvoice.p.receiver_id', message: 'The customer tax number must be 9 digits (company) or a 14-digit national ID (person)' });

  const lines = doc.lines.map((l, i) => {
    const code = l.itemCode ?? (s.defaultItemCode ? { codeType: s.defaultCodeType, itemCode: s.defaultItemCode, unitType: null } : null);
    if (!code) problems.push({ code: 'einvoice.p.item_code', message: `Line ${i + 1} (${l.description}) has no ETA item code`, values: { line: i + 1, description: l.description } });
    const tax = l.hasTax ? l.taxCode : { taxType: 'T1', subType: s.untaxedSubType };
    if (!tax) problems.push({ code: 'einvoice.p.tax_code', message: `Line ${i + 1} uses a tax with no ETA tax type`, values: { line: i + 1 } });
    const net = toEgp(l.net);
    const discount = toEgp(l.discount);
    const taxAmt = toEgp(l.tax);
    const sales = net + discount;
    const qty = l.quantity / 1000;
    const unitEgp = round5(amt(sales, scale) / qty);
    const unitValue: Record<string, unknown> = { currencySold: doc.currency, amountEGP: unitEgp };
    if (foreign) {
      unitValue.amountSold = round5(amt(l.net + l.discount, scale) / qty);
      unitValue.currencyExchangeRate = round5(doc.exchangeRate / 1e6);
    }
    return {
      taxType: tax?.taxType ?? 'T1',
      tax: taxAmt,
      line: {
        description: l.description,
        itemType: code?.codeType ?? s.defaultCodeType,
        itemCode: code?.itemCode ?? '',
        unitType: code?.unitType || s.defaultUnitType,
        quantity: qty,
        internalCode: l.sku ?? String(i + 1),
        salesTotal: amt(sales, scale),
        total: amt(net + taxAmt, scale),
        valueDifference: 0,
        totalTaxableFees: 0,
        netTotal: amt(net, scale),
        itemsDiscount: 0,
        unitValue,
        discount: { rate: sales ? round5((discount / sales) * 100) : 0, amount: amt(discount, scale) },
        taxableItems: [{ taxType: tax?.taxType ?? 'T1', amount: amt(taxAmt, scale), subType: tax?.subType ?? s.untaxedSubType, rate: l.hasTax ? l.taxRateBp / 100 : 0 }],
      },
      net,
      discount,
    };
  });

  const sum = (f: (x: (typeof lines)[number]) => number) => lines.reduce((a, x) => a + f(x), 0);
  const net = sum((x) => x.net);
  const discount = sum((x) => x.discount);
  const tax = sum((x) => x.tax);
  const byType = new Map<string, number>();
  for (const x of lines) byType.set(x.taxType, (byType.get(x.taxType) ?? 0) + x.tax);
  if (type === 'P' && !taxId && net + tax >= PERSON_ID_LIMIT * 10 ** scale) {
    problems.push({ code: 'einvoice.p.person_id', message: `An individual buying for ${PERSON_ID_LIMIT} EGP or more needs a national ID`, values: { limit: PERSON_ID_LIMIT } });
  }
  if (doc.kind === 'sales_credit' && !doc.originalUuid) {
    problems.push(
      doc.hasOriginal
        ? { code: 'einvoice.p.original', message: 'The original invoice was not accepted by the ETA yet' }
        : { code: 'einvoice.p.no_original', message: 'A credit note sent to the ETA must be made against an invoice' },
    );
  }
  if (doc.date > today) problems.push({ code: 'einvoice.p.future', message: 'A document dated in the future cannot be sent yet' });

  const issued = doc.postedAt && doc.postedAt.slice(0, 10) === doc.date ? `${doc.postedAt.slice(0, 19)}Z` : `${doc.date}T00:00:00Z`;
  const document: Record<string, unknown> = {
    issuer: {
      address: { branchID: s.branchId || '0', country: 'EG', governate: s.governate ?? '', regionCity: s.regionCity ?? '', street: s.street ?? '', buildingNumber: s.buildingNumber ?? '' },
      type: 'B',
      id: s.rin ?? '',
      name: s.issuerName ?? '',
    },
    receiver: {
      address: { country: isForeign ? country : 'EG', governate: doc.party.city ?? '', regionCity: doc.party.city ?? '', street: doc.party.address ?? '', buildingNumber: '0' },
      type,
      id: type === 'P' && !taxId ? '' : taxId,
      name: doc.party.name,
    },
    documentType: doc.kind === 'sales_credit' ? 'C' : 'I',
    documentTypeVersion: s.version,
    dateTimeIssued: issued,
    taxpayerActivityCode: s.activityCode ?? '',
    internalID: doc.number,
  };
  if (doc.reference) document.purchaseOrderReference = doc.reference;
  if (doc.kind === 'sales_credit') document.references = doc.originalUuid ? [doc.originalUuid] : [];
  Object.assign(document, {
    invoiceLines: lines.map((x) => x.line),
    totalDiscountAmount: amt(discount, scale),
    totalSalesAmount: amt(net + discount, scale),
    netAmount: amt(net, scale),
    taxTotals: [...byType].map(([taxType, amount]) => ({ taxType, amount: amt(amount, scale) })),
    totalAmount: amt(net + tax, scale),
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
  });
  return { document, problems };
}

/**
 * The ETA canonical form: every property name in upper case and quotes followed by its value; an
 * array repeats its property name before each element. Values are written as they appear in the JSON.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (Array.isArray(value)) return value.map((v) => canonical(v)).join('');
  if (typeof value === 'object') {
    let out = '';
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const name = `"${k.toUpperCase()}"`;
      out += Array.isArray(v) ? name + v.map((e) => name + canonical(e)).join('') : name + canonical(v);
    }
    return out;
  }
  return `"${String(value)}"`;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
