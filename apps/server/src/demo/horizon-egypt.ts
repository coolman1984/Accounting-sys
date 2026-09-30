import type { App } from '../app.js';

/**
 * Demo company: a consumer-electronics factory modelled on Horizon Electronics Egypt (Kom Abu Radi
 * industrial zone, El Wasta, Beni Suef): TVs 43/55/65", Galaxy A phones for the local market, education
 * tablets, 85 % of TVs exported. Nine months of 2026 (January – 25 September) built through the app's own
 * HTTP API, so every number comes from the real engine.
 *
 * The public facts (products, export share, a government tablet programme, the site) come from press
 * reports — see docs/research/DEMO-HORIZON-EGYPT.md. Every amount, quantity, price, person and local
 * company here is illustrative: they are realistic in size, not real records.
 */

export const DEMO_ADMIN = { username: 'admin', password: 'Horizon@2026', displayName: 'Finance Manager' };
export const DEMO_TO = '2026-09-25';

const K = 100; // piastres in a pound (money scale 2)
const Q = 1000; // quantities are stored × 1000
const E = (pounds: number) => Math.round(pounds * K);
const U = E; // US cents
const R6 = (rate: number) => Math.round(rate * 1_000_000);

/** USD → EGP, a few points a month (shaped on the 2026 market; illustrative). */
const USD_RATES: [string, number][] = [
  ['2026-01-01', 50.6], ['2026-01-15', 50.45], ['2026-01-31', 50.7],
  ['2026-02-01', 50.7], ['2026-02-15', 50.95], ['2026-02-28', 51.2],
  ['2026-03-01', 51.2], ['2026-03-15', 51.9], ['2026-03-31', 52.8],
  ['2026-04-01', 52.8], ['2026-04-15', 54.1], ['2026-04-30', 53.6],
  ['2026-05-01', 53.6], ['2026-05-15', 52.9], ['2026-05-31', 52.4],
  ['2026-06-01', 52.4], ['2026-06-15', 51.95], ['2026-06-30', 51.6],
  ['2026-07-01', 51.6], ['2026-07-15', 51.3], ['2026-07-31', 51.05],
  ['2026-08-01', 51.05], ['2026-08-15', 50.85], ['2026-08-31', 51.3],
  ['2026-09-01', 51.3], ['2026-09-15', 51.75], ['2026-09-25', 51.8],
];
const usdOn = (date: string) => USD_RATES.filter(([d]) => d <= date).at(-1)![1];

/** Small deterministic random numbers, so every run builds the same company. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------ client

interface Client {
  get<T = any>(url: string): Promise<T>;
  post<T = any>(url: string, body?: unknown): Promise<T>;
  put<T = any>(url: string, body?: unknown): Promise<T>;
}

async function connect(app: App): Promise<Client> {
  const call = async (method: string, url: string, body: unknown, cookie: string) => {
    const res = await app.http.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: cookie ? { cookie } : {} });
    const parsed = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}\n${JSON.stringify(body)?.slice(0, 600)}`);
    return { parsed, res };
  };
  await call('POST', '/api/setup', {
    company: {
      name: 'Horizon Electronics Egypt — Beni Suef Factory (demo)',
      legalName: 'Horizon Electronics Egypt S.A.E. (sample data)',
      address: 'Kom Abu Radi Industrial Zone, El Wasta, Beni Suef, Egypt',
      baseCurrency: 'EGP',
      moneyScale: 2,
    },
    fiscalYearStart: '2026-01-01',
    admin: DEMO_ADMIN,
    locale: 'en',
    seedChartOfAccounts: true,
    vatRateBp: 1400,
  }, '');
  const login = await call('POST', '/api/auth/login', { username: DEMO_ADMIN.username, password: DEMO_ADMIN.password }, '');
  const sid = login.res.cookies.find((x) => x.name === 'mizan_sid')!;
  const cookie = `mizan_sid=${sid.value}`;
  return {
    get: async (url) => (await call('GET', url, undefined, cookie)).parsed,
    post: async (url, body = {}) => (await call('POST', url, body, cookie)).parsed,
    put: async (url, body = {}) => (await call('PUT', url, body, cookie)).parsed,
  };
}

// ------------------------------------------------------------------------------------------------ plan

type ProductKey = 'TV43' | 'TV55' | 'TV65' | 'TAB' | 'PHONE';
const MONTHS = 9;
/** Units produced a month: the World Cup (June–July 2026) lifts TVs in May–June; tablets follow the school year. */
const PRODUCTION: Record<ProductKey, number[]> = {
  TV43: [3600, 3900, 3500, 3700, 4500, 4600, 3800, 3600, 3900],
  TV55: [5200, 5600, 5000, 5400, 6800, 7000, 5600, 5200, 5800],
  TV65: [2000, 2300, 2100, 2300, 3200, 3400, 2400, 2200, 2500],
  TAB: [22000, 22000, 15000, 8000, 5000, 3000, 3000, 26000, 30000],
  PHONE: [24000, 26000, 30000, 22000, 23000, 24000, 25000, 26000, 27000],
};

interface Material { sku: string; en: string; ar: string; usd?: number; egp?: number; cat: string; supplier: string }
const MATERIALS: Material[] = [
  { sku: 'RM-OC43', en: 'Open-cell panel 43" UHD', ar: 'لوحة عرض مفتوحة 43 بوصة', usd: 105, cat: 'panels', supplier: 'HQ' },
  { sku: 'RM-OC55', en: 'Open-cell panel 55" UHD', ar: 'لوحة عرض مفتوحة 55 بوصة', usd: 185, cat: 'panels', supplier: 'HQ' },
  { sku: 'RM-OC65', en: 'Open-cell panel 65" UHD', ar: 'لوحة عرض مفتوحة 65 بوصة', usd: 290, cat: 'panels', supplier: 'HQ' },
  { sku: 'RM-TVMB', en: 'TV main board (Tizen SoC)', ar: 'اللوحة الأم للتلفزيون', usd: 32, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-PSU', en: 'TV power supply board', ar: 'لوحة مزود الطاقة للتلفزيون', usd: 12, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-BLU', en: 'LED backlight kit', ar: 'طقم إضاءة خلفية LED', usd: 18, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-RMT', en: 'Smart remote control', ar: 'ريموت كنترول ذكي', usd: 2.1, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-TPCBA', en: 'Tablet main PCBA', ar: 'اللوحة الإلكترونية للتابلت', usd: 58, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-TLCD', en: 'Tablet display 10.4"', ar: 'شاشة تابلت 10.4 بوصة', usd: 21, cat: 'panels', supplier: 'HQ' },
  { sku: 'RM-TBAT', en: 'Tablet battery 7,040 mAh', ar: 'بطارية تابلت 7040 مللي أمبير', usd: 7.5, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-MPCBA', en: 'Phone main PCBA (Galaxy A)', ar: 'اللوحة الإلكترونية للهاتف', usd: 62, cat: 'electronics', supplier: 'HQ' },
  { sku: 'RM-MDSP', en: 'Phone display 6.7" AMOLED', ar: 'شاشة هاتف 6.7 بوصة', usd: 14, cat: 'panels', supplier: 'HQ' },
  { sku: 'RM-MBAT', en: 'Phone battery 5,000 mAh', ar: 'بطارية هاتف 5000 مللي أمبير', usd: 3.2, cat: 'electronics', supplier: 'HQ' },
  { sku: 'PK-C43', en: 'Carton box 43"', ar: 'كرتونة تلفزيون 43', egp: 120, cat: 'packaging', supplier: 'CARTON' },
  { sku: 'PK-C55', en: 'Carton box 55"', ar: 'كرتونة تلفزيون 55', egp: 180, cat: 'packaging', supplier: 'CARTON' },
  { sku: 'PK-C65', en: 'Carton box 65"', ar: 'كرتونة تلفزيون 65', egp: 240, cat: 'packaging', supplier: 'CARTON' },
  { sku: 'PK-EPS', en: 'EPS foam protection set', ar: 'طقم فوم حماية', egp: 85, cat: 'packaging', supplier: 'FOAM' },
  { sku: 'PK-GIFT', en: 'Printed gift box (phone / tablet)', ar: 'علبة مطبوعة (هاتف / تابلت)', egp: 11, cat: 'packaging', supplier: 'CARTON' },
  { sku: 'RM-STAND', en: 'TV stand set (injection moulded)', ar: 'طقم قاعدة تلفزيون بلاستيك', egp: 110, cat: 'mechanical', supplier: 'PLASTIC' },
  { sku: 'RM-SCRW', en: 'Screws & fixings kit', ar: 'طقم مسامير وتثبيت', egp: 6, cat: 'mechanical', supplier: 'PLASTIC' },
];

interface Product {
  key: ProductKey; sku: string; en: string; ar: string; cat: string; local: number; exportUsd: number | null;
  bom: [string, number][]; hours: number; exportShare: number; cc: string;
}
const PRODUCTS: Product[] = [
  { key: 'TV43', sku: 'FG-HZ43', en: 'Horizon 43" Crystal UHD TV', ar: 'تلفزيون هورايزن 43 بوصة كريستال UHD', cat: 'tv', local: 12_900, exportUsd: 235,
    bom: [['RM-OC43', 1], ['RM-TVMB', 1], ['RM-PSU', 1], ['RM-BLU', 1], ['RM-RMT', 1], ['PK-C43', 1], ['PK-EPS', 1], ['RM-STAND', 1], ['RM-SCRW', 1]], hours: 2.6, exportShare: 0.85, cc: 'PRD-TV' },
  { key: 'TV55', sku: 'FG-HZ55', en: 'Horizon 55" Crystal UHD TV', ar: 'تلفزيون هورايزن 55 بوصة كريستال UHD', cat: 'tv', local: 18_900, exportUsd: 345,
    bom: [['RM-OC55', 1], ['RM-TVMB', 1], ['RM-PSU', 1], ['RM-BLU', 1], ['RM-RMT', 1], ['PK-C55', 1], ['PK-EPS', 1], ['RM-STAND', 1], ['RM-SCRW', 1]], hours: 3.0, exportShare: 0.85, cc: 'PRD-TV' },
  { key: 'TV65', sku: 'FG-HZ65', en: 'Horizon 65" Crystal UHD TV', ar: 'تلفزيون هورايزن 65 بوصة كريستال UHD', cat: 'tv', local: 26_900, exportUsd: 480,
    bom: [['RM-OC65', 1], ['RM-TVMB', 1], ['RM-PSU', 1], ['RM-BLU', 1], ['RM-RMT', 1], ['PK-C65', 1], ['PK-EPS', 1], ['RM-STAND', 1], ['RM-SCRW', 1]], hours: 3.6, exportShare: 0.85, cc: 'PRD-TV' },
  { key: 'TAB', sku: 'FG-SMX216', en: 'Galaxy Tab A9+ (education edition)', ar: 'جالاكسي تاب A9+ (إصدار التعليم)', cat: 'tab', local: 7_300, exportUsd: null,
    bom: [['RM-TPCBA', 1], ['RM-TLCD', 1], ['RM-TBAT', 1], ['PK-GIFT', 1]], hours: 2.2, exportShare: 0, cc: 'PRD-TAB' },
  { key: 'PHONE', sku: 'FG-SMA165', en: 'Galaxy A16 smartphone', ar: 'هاتف جالاكسي A16', cat: 'phone', local: 6_300, exportUsd: null,
    bom: [['RM-MPCBA', 1], ['RM-MDSP', 1], ['RM-MBAT', 1], ['PK-GIFT', 1]], hours: 2.4, exportShare: 0, cc: 'PRD-MOB' },
];
/** Government price for the education tablets (a tender price, below the retail distributor price). */
const TABLET_TENDER_PRICE = 6_450;

const COST_CENTERS: [string, string, string][] = [
  ['PRD-TV', 'Production — TV lines', 'الإنتاج — خطوط التلفزيون'],
  ['PRD-MOB', 'Production — Mobile line', 'الإنتاج — خط الموبايل'],
  ['PRD-TAB', 'Production — Tablet line', 'الإنتاج — خط التابلت'],
  ['QA', 'Quality assurance', 'ضبط الجودة'],
  ['SCM', 'Warehouse & logistics', 'المخازن والإمداد'],
  ['SLS-LOC', 'Local sales', 'المبيعات المحلية'],
  ['SLS-EXP', 'Export sales', 'مبيعات التصدير'],
  ['ADMIN', 'Administration & finance', 'الإدارة والمالية'],
];

interface Customer { code: string; name: string; alt: string; city: string; country: string; usd: boolean; terms: number; wht: boolean; cheques: boolean; tin: string; share: number }
/** Local customers are invented names; the export buyers are sister sales companies of the group. */
const CUSTOMERS: Customer[] = [
  { code: 'C-DELTA', name: 'Delta Electronics Trading', alt: 'دلتا لتجارة الإلكترونيات', city: 'Cairo', country: 'Egypt', usd: false, terms: 45, wht: true, cheques: false, tin: '205-118-447', share: 0.24 },
  { code: 'C-NILE', name: 'Nile Home Appliances Co.', alt: 'النيل للأجهزة المنزلية', city: 'Alexandria', country: 'Egypt', usd: false, terms: 45, wht: true, cheques: true, tin: '311-402-958', share: 0.2 },
  { code: 'C-PYR', name: 'Pyramids Retail Group', alt: 'مجموعة الأهرام للتجزئة', city: 'Giza', country: 'Egypt', usd: false, terms: 30, wht: true, cheques: false, tin: '417-220-301', share: 0.18 },
  { code: 'C-UPPER', name: 'Upper Egypt Distribution Co.', alt: 'الصعيد للتوزيع', city: 'Assiut', country: 'Egypt', usd: false, terms: 60, wht: true, cheques: true, tin: '520-913-664', share: 0.14 },
  { code: 'C-CANAL', name: 'Canal Electronics', alt: 'القناة للإلكترونيات', city: 'Ismailia', country: 'Egypt', usd: false, terms: 45, wht: false, cheques: false, tin: '608-745-112', share: 0.12 },
  { code: 'C-MEGA', name: 'Mega Store Egypt', alt: 'ميجا ستور مصر', city: 'Cairo', country: 'Egypt', usd: false, terms: 30, wht: true, cheques: false, tin: '719-006-835', share: 0.12 },
  { code: 'C-EDU', name: 'Education Tablet Programme (government buyer)', alt: 'مشروع التابلت التعليمي (جهة حكومية)', city: 'Cairo', country: 'Egypt', usd: false, terms: 60, wht: true, cheques: false, tin: '100-000-117', share: 0 },
  { code: 'X-SGE', name: 'Horizon Gulf Electronics (Dubai)', alt: 'هورايزن الخليج للإلكترونيات (دبي)', city: 'Dubai', country: 'UAE', usd: true, terms: 60, wht: false, cheques: false, tin: 'TRN 100354672900003', share: 0.34 },
  { code: 'X-SSA', name: 'Horizon Electronics Saudi Arabia', alt: 'هورايزن إلكترونيكس السعودية', city: 'Riyadh', country: 'Saudi Arabia', usd: true, terms: 60, wht: false, cheques: false, tin: 'VAT 300418265700003', share: 0.26 },
  { code: 'X-SSAF', name: 'Horizon Electronics South Africa', alt: 'هورايزن إلكترونيكس جنوب أفريقيا', city: 'Johannesburg', country: 'South Africa', usd: true, terms: 60, wht: false, cheques: false, tin: 'VAT 4290173548', share: 0.16 },
  { code: 'X-SEWA', name: 'Horizon Electronics West Africa', alt: 'هورايزن إلكترونيكس غرب أفريقيا', city: 'Lagos', country: 'Nigeria', usd: true, terms: 60, wht: false, cheques: false, tin: 'TIN 02718845-0001', share: 0.14 },
  { code: 'X-SELV', name: 'Horizon Electronics Levant', alt: 'هورايزن إلكترونيكس المشرق', city: 'Amman', country: 'Jordan', usd: true, terms: 60, wht: false, cheques: false, tin: 'TIN 013372291', share: 0.1 },
];

interface Supplier { code: string; name: string; alt: string; city: string; country: string; usd: boolean; terms: number; wht: 'supplies' | 'services' | 'contracting' | null; tin: string }
const SUPPLIERS: Supplier[] = [
  { code: 'HQ', name: 'Horizon Electronics Co., Ltd. (Suwon HQ)', alt: 'هورايزن إلكترونيكس — المقر الرئيسي (سوون)', city: 'Suwon', country: 'South Korea', usd: true, terms: 90, wht: null, tin: '' },
  { code: 'CARTON', name: 'Beni Suef Packaging Industries', alt: 'بني سويف لصناعات التعبئة والتغليف', city: 'Beni Suef', country: 'Egypt', usd: false, terms: 30, wht: 'supplies', tin: '231-554-908' },
  { code: 'FOAM', name: 'Egypt Foam Industries', alt: 'مصر لصناعات الفوم', city: '10th of Ramadan', country: 'Egypt', usd: false, terms: 30, wht: 'supplies', tin: '244-870-315' },
  { code: 'PLASTIC', name: 'Delta Plastics Injection', alt: 'الدلتا لحقن البلاستيك', city: 'Sadat City', country: 'Egypt', usd: false, terms: 45, wht: 'supplies', tin: '258-331-770' },
  { code: 'MANPOWER', name: 'Nile Manpower Services', alt: 'النيل لتوريد العمالة', city: 'Beni Suef', country: 'Egypt', usd: false, terms: 15, wht: 'services', tin: '262-119-043' },
  { code: 'POWER', name: 'Middle Egypt Electricity Distribution Co.', alt: 'شركة مصر الوسطى لتوزيع الكهرباء', city: 'Beni Suef', country: 'Egypt', usd: false, terms: 10, wht: null, tin: '200-190-520' },
  { code: 'LOGI', name: 'Upper Egypt Transport & Logistics', alt: 'الصعيد للنقل والخدمات اللوجستية', city: 'Beni Suef', country: 'Egypt', usd: false, terms: 30, wht: 'services', tin: '275-640-219' },
  { code: 'FWD', name: 'Alex Port Clearing & Forwarding', alt: 'ميناء الإسكندرية للتخليص والشحن', city: 'Alexandria', country: 'Egypt', usd: false, terms: 30, wht: 'services', tin: '281-902-446' },
  { code: 'SECURITY', name: 'Guardian Security Services', alt: 'جارديان للخدمات الأمنية', city: 'Cairo', country: 'Egypt', usd: false, terms: 30, wht: 'services', tin: '290-311-588' },
  { code: 'MAINT', name: 'Techno Industrial Maintenance', alt: 'تكنو للصيانة الصناعية', city: '6th of October', country: 'Egypt', usd: false, terms: 30, wht: 'contracting', tin: '296-775-102' },
  { code: 'MEDIA', name: 'Cairo Media & Advertising', alt: 'القاهرة للإعلام والإعلان', city: 'Cairo', country: 'Egypt', usd: false, terms: 30, wht: 'services', tin: '303-418-650' },
  { code: 'TELECOM', name: 'Nile Telecom Business', alt: 'النيل للاتصالات — قطاع الشركات', city: 'Cairo', country: 'Egypt', usd: false, terms: 15, wht: 'services', tin: '310-557-221' },
  { code: 'LANDLORD', name: 'New Cairo Office Towers', alt: 'أبراج القاهرة الجديدة الإدارية', city: 'New Cairo', country: 'Egypt', usd: false, terms: 5, wht: null, tin: '318-664-093' },
];

// ------------------------------------------------------------------------------------------------ seeder

export interface DemoSummary {
  documents: number;
  payments: number;
  productionOrders: number;
  employees: number;
  journals: number;
}

export async function seedHorizonEgypt(app: App, log: (msg: string) => void = () => {}): Promise<DemoSummary> {
  const c = await connect(app);
  const rand = rng(20260101);
  const count: DemoSummary = { documents: 0, payments: 0, productionOrders: 0, employees: 0, journals: 0 };

  // ---------------------------------------------------------------- chart of accounts
  let accounts: any[] = await c.get('/api/accounts');
  const acc = (code: string): number => {
    const a = accounts.find((x) => x.code === code);
    if (!a) throw new Error('no account ' + code);
    return a.id;
  };
  const addAccount = async (code: string, en: string, ar: string, type: string, subtype: string, parent: string, currency: string | null = null) => {
    await c.post('/api/accounts', { code, nameEn: en, nameAr: ar, type, subtype, parentId: acc(parent), currency });
    accounts = await c.get('/api/accounts');
  };
  await addAccount('1121', 'Bank — Banque Misr (payroll account)', 'بنك مصر — حساب الرواتب', 'asset', 'bank', '11');
  await addAccount('1126', 'Bank — HSBC (USD account)', 'بنك HSBC — حساب بالدولار', 'asset', 'bank', '11', 'USD');
  await addAccount('1205', 'Land — Kom Abu Radi site', 'أرض المصنع — كوم أبو راضي', 'asset', 'fixed_asset', '12');
  await addAccount('1240', 'Factory Buildings', 'مباني المصنع', 'asset', 'fixed_asset', '12');
  await addAccount('1250', 'Production Lines & Machinery', 'خطوط الإنتاج والآلات', 'asset', 'fixed_asset', '12');
  await addAccount('1291', 'Accumulated Depreciation — Buildings', 'مجمع إهلاك المباني', 'asset', 'accumulated_depreciation', '12');
  await addAccount('1292', 'Accumulated Depreciation — Machinery', 'مجمع إهلاك الآلات وخطوط الإنتاج', 'asset', 'accumulated_depreciation', '12');
  await addAccount('3900', 'Opening Balances (clearing)', 'أرصدة افتتاحية (حساب وسيط)', 'equity', 'equity', '3');
  await addAccount('4110', 'Export Sales', 'مبيعات التصدير', 'income', 'operating_income', '4');
  await addAccount('5215', 'Contract Labour', 'عمالة مؤقتة (توريد عمالة)', 'expense', 'operating_expense', '52');
  await addAccount('5225', 'Security Services', 'خدمات الأمن والحراسة', 'expense', 'operating_expense', '52');
  await addAccount('5275', 'Export Freight & Clearing', 'مصروفات شحن وتخليص الصادرات', 'expense', 'operating_expense', '52');
  const A = {
    cash: acc('1110'), cib: acc('1120'), misr: acc('1121'), usd: acc('1126'), inventory: acc('1140'), vatIn: acc('1150'),
    land: acc('1205'), furniture: acc('1210'), vehicles: acc('1220'), computers: acc('1230'), buildings: acc('1240'), machinery: acc('1250'),
    accDep: acc('1290'), accBld: acc('1291'), accMch: acc('1292'),
    vatOut: acc('2120'), loan: acc('2210'), capital: acc('3100'), retained: acc('3200'), opening: acc('3900'),
    sales: acc('4100'), exportSales: acc('4110'),
    salaries: acc('5210'), contract: acc('5215'), rent: acc('5220'), utilities: acc('5230'), telecom: acc('5240'), marketing: acc('5260'),
    transport: acc('5270'), exportFreight: acc('5275'), maintenance: acc('5280'), security: acc('5225'), depreciation: acc('5290'),
    interest: acc('5700'), bankCharges: acc('5800'), incomeTax: acc('5950'), incomeTaxPayable: acc('2180'),
  };
  log('chart of accounts ready');

  // ---------------------------------------------------------------- taxes, cost centers, warehouses
  const taxes: any[] = await c.get('/api/taxes');
  const VAT = taxes.find((t) => t.code === 'VAT').id as number;
  const EXP0 = (await c.post('/api/taxes', { code: 'VAT0-EXP', nameEn: 'VAT 0% — exports', nameAr: 'ضريبة القيمة المضافة 0% — صادرات', rateBp: 0, scope: 'sales', salesAccountId: A.vatOut })).id as number;

  const cc: Record<string, number> = {};
  for (const [code, en, ar] of COST_CENTERS) cc[code] = (await c.post('/api/cost-centers', { code, nameEn: en, nameAr: ar })).id;

  const wh = {
    rm: (await c.post('/api/inventory/warehouses', { code: 'RM', nameEn: 'Raw materials store', nameAr: 'مخزن الخامات', address: 'Beni Suef factory' })).id as number,
    fg: (await c.post('/api/inventory/warehouses', { code: 'FG', nameEn: 'Finished goods warehouse', nameAr: 'مخزن الإنتاج التام', address: 'Beni Suef factory' })).id as number,
    exp: (await c.post('/api/inventory/warehouses', { code: 'EXP', nameEn: 'Export staging — Alexandria port', nameAr: 'مخزن التصدير — ميناء الإسكندرية', address: 'Alexandria' })).id as number,
  };

  // ---------------------------------------------------------------- items
  const categories: Record<string, number> = {};
  for (const [key, en, ar] of [
    ['panels', 'Display panels', 'لوحات العرض'], ['electronics', 'Electronic components', 'مكونات إلكترونية'], ['packaging', 'Packaging', 'مواد التعبئة'],
    ['mechanical', 'Mechanical parts', 'أجزاء ميكانيكية'], ['tv', 'Televisions', 'تلفزيونات'], ['tab', 'Tablets', 'أجهزة تابلت'], ['phone', 'Mobile phones', 'هواتف محمولة'],
  ]) categories[key] = (await c.post('/api/item-categories', { nameEn: en, nameAr: ar })).id;

  const item: Record<string, number> = {};
  const unitCostEgp: Record<string, number> = {}; // planning cost in pounds (for opening stock and budgets)
  for (const m of MATERIALS) {
    const egp = m.egp ?? m.usd! * usdOn('2026-01-01');
    unitCostEgp[m.sku] = egp;
    item[m.sku] = (
      await c.post('/api/items', {
        sku: m.sku, nameEn: m.en, nameAr: m.ar, kind: 'product', unit: 'pc', purchasePrice: E(egp), categoryId: categories[m.cat],
        purchaseTaxId: m.usd ? null : VAT, reorderLevel: 1_000 * Q, reorderQty: 5_000 * Q,
      })
    ).id;
  }
  for (const p of PRODUCTS) {
    unitCostEgp[p.sku] = p.bom.reduce((s, [sku, n]) => s + unitCostEgp[sku] * n, 0) + p.hours * 405;
    item[p.sku] = (
      await c.post('/api/items', {
        sku: p.sku, nameEn: p.en, nameAr: p.ar, kind: 'product', unit: 'pc', salePrice: E(p.local), categoryId: categories[p.cat],
        incomeAccountId: A.sales, salesTaxId: VAT, minSalePrice: E(Math.round(p.local * 0.8)), reorderLevel: 500 * Q,
      })
    ).id;
  }
  log(`${MATERIALS.length + PRODUCTS.length} items`);

  // ---------------------------------------------------------------- parties
  const party: Record<string, number> = {};
  for (const x of CUSTOMERS) {
    party[x.code] = (
      await c.post('/api/parties', {
        kind: 'customer', code: x.code, name: x.name, nameAlt: x.alt, city: x.city, country: x.country, taxNumber: x.tin || null,
        paymentTermsDays: x.terms, whtType: x.wht ? 'supplies' : null, creditLimit: x.usd ? null : E(x.code === 'C-EDU' ? 900_000_000 : Math.round(x.share * 1_400_000_000 / 1_000_000) * 1_000_000),
        notes: 'Sample data — the name and figures are illustrative.',
      })
    ).id;
  }
  for (const x of SUPPLIERS) {
    party[x.code] = (
      await c.post('/api/parties', {
        kind: 'supplier', code: 'S-' + x.code, name: x.name, nameAlt: x.alt, city: x.city, country: x.country, taxNumber: x.tin || null,
        paymentTermsDays: x.terms, whtType: x.wht, notes: 'Sample data — the name and figures are illustrative.',
      })
    ).id;
  }

  // ---------------------------------------------------------------- exchange rates
  for (const [date, rate] of USD_RATES) await c.post('/api/fx/rates', { currency: 'USD', date, rate: R6(rate) });

  // ---------------------------------------------------------------- fixed assets (in the books since 2013)
  const cat = async (en: string, ar: string, asset: number, accum: number, life: number) =>
    (await c.post('/api/assets/categories', { nameEn: en, nameAr: ar, assetAccountId: asset, accumAccountId: accum, expenseAccountId: A.depreciation, lifeMonths: life })).id as number;
  const catBld = await cat('Factory buildings', 'مباني المصنع', A.buildings, A.accBld, 480);
  const catMch = await cat('Production lines & machinery', 'خطوط الإنتاج والآلات', A.machinery, A.accMch, 120);
  const catVeh = await cat('Forklifts & vehicles', 'الروافع والسيارات', A.vehicles, A.accDep, 60);
  const catIt = await cat('Computers & software', 'أجهزة الحاسب والبرامج', A.computers, A.accDep, 36);
  const catFur = await cat('Furniture & office equipment', 'الأثاث ومعدات المكاتب', A.furniture, A.accDep, 120);
  const ASSETS: [string, number, string, number, number, number, string][] = [
    // name, category, acquired, cost (EGP), months already used, life, cost center
    ['Factory building — assembly halls (2013)', catBld, '2013-01-01', 650_000_000, 156, 480, 'ADMIN'],
    ['TV assembly lines 1–3 (renewed 2019)', catMch, '2019-01-01', 1_050_000_000, 84, 120, 'PRD-TV'],
    ['Mobile SMT & assembly line (2023)', catMch, '2023-07-01', 780_000_000, 30, 120, 'PRD-MOB'],
    ['Tablet assembly line (2024)', catMch, '2024-03-01', 1_410_000_000, 22, 120, 'PRD-TAB'],
    ['Forklifts and reach trucks (24 units)', catVeh, '2024-01-01', 48_000_000, 24, 60, 'SCM'],
    ['ERP, servers and PCs', catIt, '2025-01-01', 36_000_000, 12, 36, 'ADMIN'],
    ['Office furniture and canteen equipment', catFur, '2021-01-01', 22_000_000, 60, 120, 'ADMIN'],
  ];
  const assetTotals = new Map<number, { cost: number; acc: number }>();
  for (const [name, categoryId, date, cost, used, life, center] of ASSETS) {
    const accumulated = Math.round((cost * used) / life);
    await c.post('/api/assets', {
      name, categoryId, acquisitionDate: date, startDate: '2026-01-01', cost: E(cost), residual: 0, lifeMonths: life, method: 'straight_line',
      openingAccumulated: E(accumulated), openingMonths: used, costCenterId: cc[center], location: 'Beni Suef factory',
    });
    const t = assetTotals.get(categoryId) ?? { cost: 0, acc: 0 };
    assetTotals.set(categoryId, { cost: t.cost + E(cost), acc: t.acc + E(accumulated) });
  }
  // A new SMT line is bought in May (financed from cash) — it shows an addition in the asset report.
  // (registered with its purchase entry in the monthly loop)

  // ---------------------------------------------------------------- opening stock (1 January)
  const openingStock = async (warehouseId: number, lines: [string, number][]) => {
    const doc = await c.post('/api/inventory/operations', {
      kind: 'opening', date: '2026-01-01', warehouseId, counterAccountId: A.opening, reference: 'OPEN-2026', memo: 'Stock on 1 January 2026 (count of 31 December 2025)',
      lines: lines.map(([sku, qty]) => ({ itemId: item[sku], qty: qty * Q, unitCost: E(unitCostEgp[sku]) })), post: true,
    });
    return doc.id as number;
  };
  // Half a month of components, a week of finished goods.
  await openingStock(wh.rm, MATERIALS.map((m) => [m.sku, Math.round(needOf(m.sku, 0) * 0.5)]));
  await openingStock(wh.fg, PRODUCTS.map((p) => [p.sku, Math.round(PRODUCTION[p.key][0] * 0.25)]));
  const stockValue = (MATERIALS.reduce((s, m) => s + E(unitCostEgp[m.sku]) * Math.round(needOf(m.sku, 0) * 0.5), 0)) +
    PRODUCTS.reduce((s, p) => s + E(unitCostEgp[p.sku]) * Math.round(PRODUCTION[p.key][0] * 0.25), 0);

  // ---------------------------------------------------------------- opening balance sheet
  const ob = (await c.get('/api/reports/trial-balance?from=2026-01-01&to=2026-01-01')).rows.find((r: any) => r.id === A.opening);
  const stockCredit = ob ? ob.closing_credit - ob.closing_debit : stockValue;
  const bld = assetTotals.get(catBld)!, mch = assetTotals.get(catMch)!;
  const others = [catVeh, catIt, catFur].map((x) => assetTotals.get(x)!);
  const openingLines = [
    { accountId: A.land, debit: E(60_000_000), description: 'Land — 6,000 m² plot plus expansion area' },
    { accountId: A.buildings, debit: bld.cost },
    { accountId: A.machinery, debit: mch.cost },
    { accountId: A.vehicles, debit: others[0].cost },
    { accountId: A.computers, debit: others[1].cost },
    { accountId: A.furniture, debit: others[2].cost },
    { accountId: A.accBld, credit: bld.acc },
    { accountId: A.accMch, credit: mch.acc },
    { accountId: A.accDep, credit: others.reduce((s, x) => s + x.acc, 0) },
    { accountId: A.cib, debit: E(1_450_000_000), description: 'CIB current account' },
    { accountId: A.misr, debit: E(25_000_000), description: 'Banque Misr payroll account' },
    { accountId: A.cash, debit: E(350_000), description: 'Petty cash' },
    { accountId: A.opening, debit: stockCredit, description: 'Clears the opening stock count' },
    { accountId: A.loan, credit: E(1_200_000_000), description: 'Syndicated investment loan — 21% a year' },
    { accountId: A.capital, credit: E(2_500_000_000), description: 'Issued and paid-up capital' },
  ].map((l) => ({ debit: 0, credit: 0, ...l }));
  const diff = openingLines.reduce((s, l) => s + l.debit - l.credit, 0);
  openingLines.push({ accountId: A.retained, debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, description: 'Retained earnings brought forward' });
  await c.post('/api/journal', { date: '2026-01-01', reference: 'OPEN-2026', memo: 'Opening balances on 1 January 2026 (audited balance sheet 31 December 2025)', opening: true, post: true, lines: openingLines });
  count.journals++;
  log('opening balances booked');

  // ---------------------------------------------------------------- manufacturing
  const LABOUR_RATE = 95, VAR_OH = 60, FIX_OH = 250; // pounds an hour
  await c.put('/api/mfg/settings', { budgetFixedOverhead: E(32_000_000), overheadAccounts: [A.utilities, A.maintenance, A.depreciation] });
  const bom: Record<string, number> = {};
  for (const p of PRODUCTS) {
    bom[p.key] = (
      await c.post('/api/mfg/boms', {
        itemId: item[p.sku], name: `${p.en} — standard`, outputQty: 100 * Q, labourHours: Math.round(p.hours * 100 * Q),
        labourRate: E(LABOUR_RATE), varOverheadRate: E(VAR_OH), fixedOverheadRate: E(FIX_OH),
        lines: p.bom.map(([sku, n]) => ({ itemId: item[sku], qty: n * 100 * Q, scrapBp: sku.startsWith('RM-OC') ? 30 : 0 })),
      })
    ).id;
  }

  // ---------------------------------------------------------------- people
  await c.post('/api/payroll/components/egypt', { year: 2026 });
  accounts = await c.get('/api/accounts'); // social insurance (2141) and salary tax (2142) payables were just created
  const first = ['Ahmed', 'Mohamed', 'Mahmoud', 'Mostafa', 'Omar', 'Youssef', 'Karim', 'Hassan', 'Ali', 'Tarek', 'Amr', 'Sherif', 'Hany', 'Ibrahim', 'Khaled', 'Sara', 'Mariam', 'Nour', 'Heba', 'Aya', 'Dina', 'Rania', 'Yasmin', 'Salma', 'Mona', 'Eman', 'Fatma', 'Reem', 'Laila', 'Nada'];
  const last = ['Abdelrahman', 'El-Sayed', 'Hassan', 'Mahmoud', 'Ibrahim', 'Fawzy', 'Ramadan', 'Soliman', 'Abdallah', 'Mansour', 'Farouk', 'Nasser', 'Gamal', 'Saad', 'Shawky', 'Hegazy', 'Zaki', 'Kamel', 'Rizk', 'Tawfik'];
  const ROLES: [string, string, string, number, number, number][] = [
    // title, department, cost center, count, min salary, max salary (EGP a month)
    ['Plant Director', 'Management', 'ADMIN', 1, 185_000, 185_000],
    ['Finance Manager', 'Finance', 'ADMIN', 1, 95_000, 95_000],
    ['Accountant', 'Finance', 'ADMIN', 5, 18_000, 32_000],
    ['HR Specialist', 'Human Resources', 'ADMIN', 3, 16_000, 26_000],
    ['Production Manager', 'Production', 'PRD-TV', 2, 70_000, 82_000],
    ['Line Supervisor', 'Production', 'PRD-TV', 8, 22_000, 30_000],
    ['Line Supervisor', 'Production', 'PRD-MOB', 4, 22_000, 30_000],
    ['Line Supervisor', 'Production', 'PRD-TAB', 3, 22_000, 30_000],
    ['Production Engineer', 'Production', 'PRD-TV', 10, 20_000, 38_000],
    ['Production Engineer', 'Production', 'PRD-MOB', 6, 20_000, 38_000],
    ['Production Engineer', 'Production', 'PRD-TAB', 4, 20_000, 38_000],
    ['Technician', 'Production', 'PRD-TV', 18, 9_500, 14_000],
    ['Technician', 'Production', 'PRD-MOB', 10, 9_500, 14_000],
    ['Technician', 'Production', 'PRD-TAB', 6, 9_500, 14_000],
    ['Quality Engineer', 'Quality', 'QA', 8, 18_000, 30_000],
    ['Quality Inspector', 'Quality', 'QA', 12, 9_000, 12_500],
    ['Storekeeper', 'Supply chain', 'SCM', 10, 8_500, 12_000],
    ['Logistics Planner', 'Supply chain', 'SCM', 4, 17_000, 28_000],
    ['Sales Manager', 'Sales', 'SLS-LOC', 2, 60_000, 75_000],
    ['Key Account Executive', 'Sales', 'SLS-LOC', 6, 20_000, 34_000],
    ['Export Coordinator', 'Export', 'SLS-EXP', 4, 22_000, 36_000],
    ['Driver', 'Administration', 'ADMIN', 6, 8_000, 9_500],
  ];
  let n = 0;
  for (const [title, dept, center, howMany, min, max] of ROLES) {
    for (let i = 0; i < howMany; i++) {
      const salary = Math.round((min + (max - min) * rand()) / 50) * 50;
      const name = `${first[Math.floor(rand() * first.length)]} ${last[Math.floor(rand() * last.length)]}`;
      const hire = `${2013 + Math.floor(rand() * 12)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-01`;
      n++;
      await c.post('/api/payroll/employees', {
        name, jobTitle: title, department: dept, hireDate: hire, basicSalary: E(salary), insurableWage: E(Math.min(salary, 16_700)),
        costCenterId: cc[center], nationalId: `2${String(8_500_000_000_000 + n * 7919).slice(0, 13)}`, bankAccount: `BM-${String(100_200_300 + n * 37)}`, paymentMethod: 'bank',
      });
    }
  }
  // Two people join in the year (pro-rated first month).
  await c.post('/api/payroll/employees', { name: 'Nour Hegazy', jobTitle: 'Export Coordinator', department: 'Export', hireDate: '2026-04-12', basicSalary: E(26_000), insurableWage: E(16_700), costCenterId: cc['SLS-EXP'], paymentMethod: 'bank' });
  await c.post('/api/payroll/employees', { name: 'Karim Soliman', jobTitle: 'Production Engineer', department: 'Production', hireDate: '2026-07-01', basicSalary: E(24_000), insurableWage: E(16_700), costCenterId: cc['PRD-MOB'], paymentMethod: 'bank' });
  count.employees = n + 2;
  log(`${count.employees} employees on the payroll`);

  // ---------------------------------------------------------------- recurring: New Cairo sales office rent
  await c.post('/api/recurring', {
    name: 'New Cairo sales office rent', kind: 'purchase_bill', frequency: 'monthly', firstDate: '2026-01-05', autoPost: true,
    payload: { partyId: party.LANDLORD, reference: 'Lease 2025/118', lines: [{ description: 'Office rent — 850 m², Fifth Settlement', quantity: Q, unitPrice: E(640_000), accountId: A.rent, costCenterId: cc['SLS-LOC'] }] },
  });

  // ---------------------------------------------------------------- helpers for the months
  const doc = async (body: any) => {
    const r = await c.post('/api/documents', { post: true, ...body });
    count.documents++;
    return r.id as number;
  };
  const journal = async (date: string, reference: string, memo: string, lines: any[]) => {
    await c.post('/api/journal', { date, reference, memo, post: true, lines: lines.map((l) => ({ debit: 0, credit: 0, ...l })) });
    count.journals++;
  };
  const balanceOf = async (accountId: number, to: string) => {
    const r = (await c.get(`/api/reports/trial-balance?from=2026-01-01&to=${to}`)).rows.find((x: any) => x.id === accountId);
    return r ? r.closing_debit - r.closing_credit : 0;
  };
  // Dollars on the HSBC account (in cents), so imports are paid from dollars actually held.
  let usdHeld = 0;
  const buyDollars = async (date: string, cents: number) => {
    const rate = usdOn(date);
    await c.post('/api/bank/transfers', {
      date, fromAccountId: A.cib, toAccountId: A.usd, amount: Math.round(cents * rate * 1.002), toAmount: cents, fee: E(9_800), feeAccountId: A.bankCharges,
      reference: `FX-${date}`, memo: `USD ${(cents / 100).toLocaleString('en')} bought on the interbank market at ${rate} + 0.2%`, post: true,
    });
    usdHeld += cents;
  };
  /** Pay (or collect) every open document of a party that is due by `asOf`. */
  const settleDue = async (code: string, direction: 'in' | 'out', asOf: string, date: string) => {
    const role = direction === 'in' ? 'customer' : 'supplier';
    const open: any[] = await c.get(`/api/payments/open-documents?partyId=${party[code]}&direction=${direction}&role=${role}`);
    for (const d of open.filter((x) => (x.due_date ?? x.date) <= asOf)) {
      const usd = d.currency === 'USD';
      if (usd && direction === 'out' && usdHeld < d.outstanding) await buyDollars(date, Math.ceil((d.outstanding - usdHeld + U(250_000)) / U(100_000)) * U(100_000));
      const wht = usd ? null : await c.post('/api/payments/withholding', { partyId: party[code], direction, allocations: [{ documentId: d.id, amount: d.outstanding }] });
      const withheld = wht && wht.amount > 0 ? wht.amount : 0;
      await c.post('/api/payments', {
        direction, date, partyId: party[code], partyRole: role, accountId: usd ? A.usd : A.cib, amount: d.outstanding - withheld, currency: usd ? 'USD' : null,
        method: 'bank_transfer', reference: `${direction === 'in' ? 'RCV' : 'PAY'}-${d.number}`, post: true,
        withholding: withheld ? { type: wht.type, base: wht.base } : null, allocations: [{ documentId: d.id, amount: d.outstanding }],
      });
      if (usd) usdHeld += direction === 'in' ? d.outstanding : -d.outstanding;
      count.payments++;
    }
  };
  /** Customers who pay by post-dated cheque hand one over for each invoice within a week; it is due on the invoice due date. */
  const cheques: { id: number; due: string; deposited: boolean }[] = [];
  const takeCheques = async (code: string, date: string) => {
    const open: any[] = await c.get(`/api/payments/open-documents?partyId=${party[code]}&direction=in&role=customer`);
    for (const d of open) {
      const received = addDays(d.date, 7) < date ? addDays(d.date, 7) : date;
      const chq = await c.post('/api/cheques', {
        direction: 'received', chequeNo: String(730_100 + cheques.length * 7), bankName: code === 'C-NILE' ? 'National Bank of Egypt' : 'Banque du Caire', partyId: party[code],
        amount: d.outstanding, date: received, dueDate: d.due_date, memo: `Post-dated cheque for ${d.number}`, allocations: [{ documentId: d.id, amount: d.outstanding }],
      });
      cheques.push({ id: chq.id, due: d.due_date, deposited: false });
      count.payments++;
    }
  };
  /** Deposit cheques on their due date; the bank clears them two days later. */
  const collectCheques = async (asOf: string) => {
    for (const ch of cheques) {
      if (!ch.deposited && ch.due <= asOf) {
        await c.post(`/api/cheques/${ch.id}/deposit`, { date: ch.due, bankAccountId: A.cib });
        ch.deposited = true;
      }
      if (ch.deposited && ch.due !== '' && addDays(ch.due, 2) <= asOf) {
        await c.post(`/api/cheques/${ch.id}/clear`, { date: addDays(ch.due, 2), bankAccountId: A.cib });
        ch.due = '';
      }
    }
  };

  // ---------------------------------------------------------------- the months
  for (let m = 0; m < MONTHS; m++) {
    const mm = String(m + 1).padStart(2, '0');
    const ym = `2026-${mm}`;
    const d = (day: number) => `${ym}-${String(Math.min(day, lastDay(ym))).padStart(2, '0')}`;
    const isLast = m === MONTHS - 1;

    // 1. Component imports from HQ (USD, 90 days) with customs, and import VAT at the port.
    const hqLines = MATERIALS.filter((x) => x.supplier === 'HQ').map((x) => ({
      itemId: item[x.sku], description: x.en, quantity: Math.round(needOf(x.sku, m) * 1.01) * Q, unitPrice: U(x.usd!), warehouseId: wh.rm,
    }));
    for (const [part, lines] of [['A', hqLines.slice(0, 7)], ['B', hqLines.slice(7)]] as const) {
      const bill = await doc({ kind: 'purchase_bill', partyId: party.HQ, date: d(3), currency: 'USD', reference: `CI-SEC-${ym}-${part}`, notes: 'Commercial invoice — CIF Alexandria; components for local assembly', warehouseId: wh.rm, lines });
      const b = await c.get(`/api/documents/${bill}`);
      const egpValue = b.base_total as number;
      const duty = Math.round(egpValue * 0.02); // 2% on production inputs
      await c.post('/api/inventory/landed-costs', {
        date: d(5), counterAccountId: A.cib, amount: duty + E(185_000), method: 'value', reference: `ACI-${ym}-${part}`,
        memo: 'Customs duty 2% and port handling, paid at Alexandria port', targets: [{ sourceType: 'purchase_bill', sourceId: bill }], post: true,
      });
      await journal(d(5), `IMPVAT-${ym}-${part}`, 'Import VAT 14% paid to the Customs Authority (recoverable input VAT)', [
        { accountId: A.vatIn, debit: Math.round((egpValue + duty) * 0.14) },
        { accountId: A.cib, credit: Math.round((egpValue + duty) * 0.14) },
      ]);
    }
    // 2. Local packaging and mechanical parts (14% VAT, withholding 1%).
    for (const code of ['CARTON', 'FOAM', 'PLASTIC']) {
      const lines = MATERIALS.filter((x) => x.supplier === code).map((x) => ({
        itemId: item[x.sku], quantity: Math.round(needOf(x.sku, m) * 1.005) * Q, unitPrice: E(x.egp! * (1 + 0.01 * Math.floor(m / 3))), taxId: VAT, warehouseId: wh.rm,
      }));
      await doc({ kind: 'purchase_bill', partyId: party[code], date: d(4), reference: `INV-${code}-${ym}`, warehouseId: wh.rm, lines });
    }

    // 3. Production: two batches per product (completed on the 9th and the 22nd); actual usage and hours vary.
    for (const p of PRODUCTS) {
      const total = PRODUCTION[p.key][m];
      if (!total) continue;
      for (const [units, day] of [[Math.floor(total / 2), 9], [total - Math.floor(total / 2), 22]]) {
        const order = (await c.post('/api/mfg/orders', { bomId: bom[p.key], plannedQty: units * Q, date: d(day - 7), warehouseId: wh.rm, outputWarehouseId: wh.fg, notes: `${p.en} — ${ym}` })).id;
        const hours = units * p.hours * (0.97 + rand() * 0.08);
        await c.put(`/api/mfg/orders/${order}`, {
          date: d(day), warehouseId: wh.rm, outputWarehouseId: wh.fg, outputQty: units * Q, labourHours: Math.round(hours * Q), labourCost: E(Math.round(hours * LABOUR_RATE * (0.98 + rand() * 0.06))),
          lines: p.bom.map(([sku, per]) => ({ itemId: item[sku], qty: Math.round(units * per * (sku.startsWith('RM-OC') ? 1.004 : 1)) * Q })),
        });
        await c.post(`/api/mfg/orders/${order}/complete`);
        count.productionOrders++;
      }
    }

    // 4. Sales. TVs: 85% exported through the Alexandria staging warehouse; tablets to the government
    //    programme (80%) and distributors; phones to local distributors. Sales run a little behind output.
    const sold = (p: Product) => Math.floor(PRODUCTION[p.key][m] * (m === 0 ? 1.1 : 0.97));
    const tvs = PRODUCTS.filter((p) => p.exportUsd);
    const exportQty = Object.fromEntries(tvs.map((p) => [p.key, Math.floor(sold(p) * p.exportShare)]));
    for (const [part, day] of [[0, 12], [1, 24]]) {
      await c.post('/api/inventory/operations', {
        kind: 'transfer', date: d(day), warehouseId: wh.fg, toWarehouseId: wh.exp, reference: `TRF-EXP-${ym}-${part + 1}`, memo: 'TVs trucked to Alexandria port for export', post: true,
        lines: tvs.map((p) => ({ itemId: item[p.sku], qty: (part ? exportQty[p.key] - Math.floor(exportQty[p.key] / 2) : Math.floor(exportQty[p.key] / 2)) * Q })),
      });
      count.documents++;
    }
    const exporters = CUSTOMERS.filter((x) => x.usd);
    for (const x of exporters) {
      await doc({
        kind: 'sales_invoice', partyId: party[x.code], date: d(25), currency: 'USD', reference: `EXP-${x.code}-${ym}`, warehouseId: wh.exp,
        notes: 'FOB Alexandria — zero-rated export (VAT Law 67/2016, art. 30)',
        lines: tvs.map((p) => ({
          itemId: item[p.sku], quantity: Math.max(1, Math.floor(exportQty[p.key] * x.share)) * Q, unitPrice: U(p.exportUsd! * (1 - 0.01 * Math.floor(m / 4))),
          taxId: EXP0, accountId: A.exportSales, warehouseId: wh.exp, costCenterId: cc['SLS-EXP'],
        })),
      });
    }
    const locals = CUSTOMERS.filter((x) => !x.usd && x.share > 0);
    for (const half of [0, 1]) {
      for (const x of locals) {
        const lines = PRODUCTS.map((p) => {
          const localUnits = p.key === 'TAB' ? sold(p) * 0.2 : sold(p) * (1 - p.exportShare);
          const qty = Math.floor((localUnits * x.share) / 2);
          const promo = p.exportUsd && (m === 4 || m === 5) ? 500 : 0; // World Cup promotion on TVs
          return { itemId: item[p.sku], quantity: qty * Q, unitPrice: E(p.local), discountBp: promo, taxId: VAT, warehouseId: wh.fg, costCenterId: cc['SLS-LOC'] };
        }).filter((l) => l.quantity > 0);
        await doc({ kind: 'sales_invoice', partyId: party[x.code], date: d(half ? 24 : 10), dueDate: addDays(d(half ? 24 : 10), x.terms), reference: `SO-${x.code}-${ym}-${half + 1}`, warehouseId: wh.fg, lines });
      }
    }
    const tablets = Math.floor(sold(PRODUCTS[3]) * 0.8);
    if (tablets > 0) {
      await doc({
        kind: 'sales_invoice', partyId: party['C-EDU'], date: d(22), dueDate: addDays(d(22), 60), reference: `EDU-TAB-${ym}`, warehouseId: wh.fg,
        notes: 'Education tablets under the framework contract; delivered to the governorate education directorates',
        lines: [{ itemId: item['FG-SMX216'], quantity: tablets * Q, unitPrice: E(TABLET_TENDER_PRICE), taxId: VAT, warehouseId: wh.fg, costCenterId: cc['SLS-LOC'] }],
      });
    }
    // A customer returns a batch of damaged 55" TVs in March.
    if (m === 2) {
      const inv = (await c.get(`/api/payments/open-documents?partyId=${party['C-DELTA']}&direction=in&role=customer`)).at(-1);
      await doc({
        kind: 'sales_credit', partyId: party['C-DELTA'], date: d(27), againstDocumentId: inv.id, reference: `RMA-${ym}-01`, warehouseId: wh.fg, notes: 'Transport damage — 40 units returned',
        lines: [{ itemId: item['FG-HZ55'], quantity: 40 * Q, unitPrice: E(18_900), taxId: VAT, warehouseId: wh.fg, costCenterId: cc['SLS-LOC'] }],
      });
    }

    // 5. Overheads (bills), each on its cost centers. The office rent comes from its recurring template.
    await c.post('/api/recurring/generate', { upTo: d(5) });
    const kwh = Math.round(3_900_000 + (PRODUCTION.TV55[m] + PRODUCTION.TV65[m]) * 60);
    const tariff = m < 3 ? 1.69 : 1.94; // industrial medium voltage, raised in April 2026
    await doc({
      kind: 'purchase_bill', partyId: party.POWER, date: d(8), reference: `ELEC-${ym}`, notes: `${kwh.toLocaleString('en')} kWh at ${tariff} EGP (medium voltage industrial tariff)`,
      lines: [['PRD-TV', 0.55], ['PRD-MOB', 0.22], ['PRD-TAB', 0.1], ['SCM', 0.05], ['ADMIN', 0.08]].map(([center, share]) => ({
        description: `Electricity — ${center}`, quantity: Q, unitPrice: E(Math.round(kwh * tariff * (share as number))), accountId: A.utilities, costCenterId: cc[center as string],
      })),
    });
    const contractWorkers = 1_250 + Math.round((PRODUCTION.TV55[m] - 5_000) / 10);
    await doc({
      kind: 'purchase_bill', partyId: party.MANPOWER, date: d(28), reference: `MP-${ym}`, notes: `${contractWorkers} contract line operators at 10,400 EGP a month all-in`,
      lines: [['PRD-TV', 0.6], ['PRD-MOB', 0.28], ['PRD-TAB', 0.12]].map(([center, share]) => ({
        description: `Line operators — ${center}`, quantity: Q, unitPrice: E(Math.round(contractWorkers * 10_400 * (share as number))), accountId: A.contract, taxId: VAT, costCenterId: cc[center as string],
      })),
    });
    await doc({ kind: 'purchase_bill', partyId: party.SECURITY, date: d(28), reference: `SEC-${ym}`, lines: [{ description: 'Site security — 42 guards, 24/7', quantity: Q, unitPrice: E(860_000), accountId: A.security, taxId: VAT, costCenterId: cc.ADMIN }] });
    await doc({
      kind: 'purchase_bill', partyId: party.MAINT, date: d(18), reference: `PM-${ym}`,
      lines: [
        { description: 'Preventive maintenance — SMT and assembly lines', quantity: Q, unitPrice: E(1_150_000 + Math.round(rand() * 250_000)), accountId: A.maintenance, taxId: VAT, costCenterId: cc['PRD-TV'] },
        { description: 'Chiller and compressor service', quantity: Q, unitPrice: E(320_000), accountId: A.maintenance, taxId: VAT, costCenterId: cc.ADMIN },
      ],
    });
    await doc({
      kind: 'purchase_bill', partyId: party.LOGI, date: d(25), reference: `TRN-${ym}`,
      lines: [
        { description: 'Local deliveries to distributors', quantity: Q, unitPrice: E(2_400_000 + Math.round(rand() * 400_000)), accountId: A.transport, taxId: VAT, costCenterId: cc['SLS-LOC'] },
        { description: 'Trucking to Alexandria port', quantity: Q, unitPrice: E(1_650_000), accountId: A.exportFreight, taxId: VAT, costCenterId: cc['SLS-EXP'] },
      ],
    });
    await doc({ kind: 'purchase_bill', partyId: party.FWD, date: d(21), reference: `FWD-${ym}`, lines: [{ description: 'Export clearance, documents and terminal handling', quantity: Q, unitPrice: E(1_280_000), accountId: A.exportFreight, taxId: VAT, costCenterId: cc['SLS-EXP'] }] });
    await doc({ kind: 'purchase_bill', partyId: party.TELECOM, date: d(6), reference: `TEL-${ym}`, lines: [{ description: 'Leased lines, mobiles and internet', quantity: Q, unitPrice: E(185_000), accountId: A.telecom, taxId: VAT, costCenterId: cc.ADMIN }] });
    const campaign = m === 4 || m === 5 ? 9_500_000 : m === 1 ? 6_000_000 : 3_200_000; // pre-Ramadan and World Cup campaigns
    await doc({ kind: 'purchase_bill', partyId: party.MEDIA, date: d(12), reference: `ADV-${ym}`, lines: [{ description: 'TV, digital and outdoor campaign', quantity: Q, unitPrice: E(campaign), accountId: A.marketing, taxId: VAT, costCenterId: cc['SLS-LOC'] }] });

    // 6. A new SMT line for the phone plant arrives in May.
    if (m === 4) {
      await c.post('/api/assets', {
        name: 'Second SMT line — mobile plant expansion', categoryId: catMch, acquisitionDate: d(12), cost: E(410_000_000), residual: 0, lifeMonths: 120, method: 'straight_line',
        costCenterId: cc['PRD-MOB'], location: 'Beni Suef — mobile plant', acquisition: { counterAccountId: A.cib },
      });
    }

    // 7. Payroll: compute, post and pay on the 25th from the Banque Misr payroll account.
    const run = (await c.post('/api/payroll/runs', { month: ym, payDate: d(25) })).id;
    await c.post(`/api/payroll/runs/${run}/post`);
    const net = (await c.get(`/api/payroll/runs/${run}`)).net as number;
    await c.post('/api/bank/transfers', { date: d(23), fromAccountId: A.cib, toAccountId: A.misr, amount: net, reference: `PAYFUND-${ym}`, memo: 'Funding the payroll account', post: true });
    await c.post(`/api/payroll/runs/${run}/pay`, { date: d(25), accountId: A.misr });

    // 8. Collections and supplier payments due by now; cheques deposited on their due dates.
    const asOf = isLast ? DEMO_TO : d(28);
    for (const x of CUSTOMERS) {
      if (x.cheques) await takeCheques(x.code, isLast ? DEMO_TO : d(27));
      else await settleDue(x.code, 'in', asOf, isLast ? DEMO_TO : d(27));
    }
    await collectCheques(asOf);
    // 9. Suppliers; dollars for the HQ invoices are bought when they fall due (exports cover about half).
    for (const x of SUPPLIERS) await settleDue(x.code, 'out', addDays(asOf, x.code === 'HQ' ? 0 : 3), isLast ? DEMO_TO : d(28));

    // 10. Loan interest monthly, a principal instalment each quarter.
    await journal(d(25), `LOAN-INT-${ym}`, 'Interest on the investment loan (21% a year)', [
      { accountId: A.interest, debit: E(Math.round((1_200_000_000 - 50_000_000 * Math.floor(m / 3)) * 0.21 / 12)) },
      { accountId: A.cib, credit: E(Math.round((1_200_000_000 - 50_000_000 * Math.floor(m / 3)) * 0.21 / 12)) },
    ]);
    if (m % 3 === 2) await journal(d(25), `LOAN-PRN-${ym}`, 'Quarterly loan instalment', [{ accountId: A.loan, debit: E(50_000_000) }, { accountId: A.cib, credit: E(50_000_000) }]);

    // 11. Taxes of last month: VAT return, salary tax and social insurance (all by the 15th… here on the 14th).
    if (m > 0) {
      const prev = `2026-${String(m).padStart(2, '0')}`;
      const out = -(await balanceOf(A.vatOut, d(13)));
      const inp = await balanceOf(A.vatIn, d(13));
      if (out > inp) {
        await journal(d(14), `VAT-${prev}`, `VAT return for ${prev} — net VAT paid (Form 10)`, [{ accountId: A.vatOut, debit: out }, { accountId: A.vatIn, credit: inp }, { accountId: A.cib, credit: out - inp }]);
      }
      const si = -(await balanceOf(acc('2141'), d(13)));
      const st = -(await balanceOf(acc('2142'), d(13)));
      if (si > 0) await journal(d(14), `NOSI-${prev}`, `Social insurance for ${prev} (employee and employer shares)`, [{ accountId: acc('2141'), debit: si }, { accountId: A.cib, credit: si }]);
      if (st > 0) await journal(d(14), `SALTAX-${prev}`, `Salary tax withheld in ${prev}`, [{ accountId: acc('2142'), debit: st }, { accountId: A.cib, credit: st }]);
      // Form 41 each quarter (January, April, July, October).
      if (m === 3 || m === 6) {
        const wht = -(await balanceOf(acc('2190'), d(13)));
        if (wht > 0) await journal(d(14), `F41-2026-Q${m / 3}`, 'Withholding tax deducted from suppliers — Form 41', [{ accountId: acc('2190'), debit: wht }, { accountId: A.cib, credit: wht }]);
      }
    }

    // 12. Month end (September is still open on the demo date).
    if (!isLast) {
      await c.post('/api/assets/depreciation/run', { month: ym });
      await c.post('/api/fx/revaluations', { date: d(31) });
      // Quarterly income tax provision at 22.5% of the year's profit so far.
      if (m % 3 === 2) {
        const is = await c.get(`/api/reports/income-statement?from=2026-01-01&to=${d(31)}`);
        const profit = Number(is.netProfit ?? is.net_profit ?? is.totals?.netProfit ?? 0);
        const already = -(await balanceOf(A.incomeTaxPayable, d(31)));
        const provision = Math.max(0, Math.round(((profit + already) * 0.225) / K) * K - already);
        if (provision > 0) await journal(d(31), `CIT-2026-Q${(m + 1) / 3}`, 'Corporate income tax provision (22.5%) — year to date', [{ accountId: A.incomeTax, debit: provision }, { accountId: A.incomeTaxPayable, credit: provision }]);
      }
    }
    log(`${ym} done`);
  }


  // ---------------------------------------------------------------- budget 2026 (approved in December 2025)
  const budget = (await c.post('/api/budgets', { name: 'Budget 2026 — Beni Suef factory', startDate: '2026-01-01' })).id;
  const spread = (total: number) => Array.from({ length: 12 }, () => E(Math.round(total / 12)));
  const plan = (key: ProductKey, f: (p: Product) => number) => { const p = PRODUCTS.find((x) => x.key === key)!; return f(p); };
  const localRevenue = PRODUCTS.reduce((s, p) => s + p.local * (p.key === 'TAB' ? 0.2 : 1 - p.exportShare) * avg(PRODUCTION[p.key]) * 12, 0) + TABLET_TENDER_PRICE * 0.8 * avg(PRODUCTION.TAB) * 12;
  const exportRevenue = PRODUCTS.filter((p) => p.exportUsd).reduce((s, p) => s + p.exportUsd! * 51 * p.exportShare * avg(PRODUCTION[p.key]) * 12, 0);
  const cogs = PRODUCTS.reduce((s, p) => s + unitCostEgp[p.sku] * avg(PRODUCTION[p.key]) * 12, 0);
  await c.put(`/api/budgets/${budget}/lines`, {
    lines: [
      { accountId: A.sales, amounts: spread(localRevenue * 1.05) },
      { accountId: A.exportSales, amounts: spread(exportRevenue * 1.03) },
      { accountId: acc('5100'), amounts: spread(cogs * 0.99) },
      { accountId: A.contract, amounts: spread(1_300 * 10_400 * 12) },
      { accountId: A.salaries, amounts: spread(4_300_000 * 12) },
      { accountId: A.utilities, amounts: spread(8_200_000 * 12) },
      { accountId: A.marketing, amounts: spread(52_000_000) },
      { accountId: A.transport, amounts: spread(2_500_000 * 12) },
      { accountId: A.exportFreight, amounts: spread(2_900_000 * 12) },
      { accountId: A.maintenance, amounts: spread(1_500_000 * 12) },
      { accountId: A.rent, amounts: spread(640_000 * 12) },
      { accountId: A.interest, amounts: spread(245_000_000) },
    ],
  });
  await c.put(`/api/budgets/${budget}/sales`, {
    rows: PRODUCTS.map((p) => ({ itemId: item[p.sku], quantities: Array(12).fill(Math.round(avg(PRODUCTION[p.key])) * Q), unitPrice: E(p.exportUsd ? plan(p.key, () => p.local * 0.15 + p.exportUsd! * 51 * 0.85) : p.local), unitCost: E(unitCostEgp[p.sku]) })),
  });
  await c.post(`/api/budgets/${budget}/approve`);

  // ---------------------------------------------------------------- September bank statement (CIB), reconciled
  const gl = await c.get(`/api/reports/general-ledger?accountId=${A.cib}&from=2026-09-01&to=${DEMO_TO}`);
  const moves: any[] = (gl.rows ?? gl.lines ?? gl.entries ?? []).filter((r: any) => (r.debit ?? 0) - (r.credit ?? 0) !== 0);
  if (moves.length) {
    const opening = await balanceOf(A.cib, '2026-08-31');
    const closing = await balanceOf(A.cib, DEMO_TO);
    const st = (await c.post('/api/bank/statements', {
      accountId: A.cib, date: DEMO_TO, reference: 'CIB-STMT-2026-09', openingBalance: opening,
      closingBalance: closing - E(4_350),
      lines: [
        ...moves.map((r: any) => ({ date: r.date, description: (r.memo ?? r.description ?? r.reference ?? 'Transfer').slice(0, 290) || 'Transfer', reference: r.reference ?? null, amount: (r.debit ?? 0) - (r.credit ?? 0) })),
        { date: '2026-09-24', description: 'Account maintenance and SWIFT charges', amount: -E(4_350) },
      ],
    })).id;
    await c.post(`/api/bank/statements/${st}/auto-match`);
    const s = await c.get(`/api/bank/statements/${st}`);
    const unmatched = (s.lines ?? []).filter((l: any) => !l.journal_entry_id && !l.matched && !l.match_id);
    for (const l of unmatched) {
      if (l.amount === -E(4_350)) await c.post(`/api/bank/statement-lines/${l.id}/entry`, { accountId: A.bankCharges, date: l.date, memo: l.description });
    }
    await c.post(`/api/bank/statements/${st}/reconcile`);
  }

  log('done');
  return count;
}

// ------------------------------------------------------------------------------------------------ plan helpers

function needOf(sku: string, m: number): number {
  return PRODUCTS.reduce((s, p) => {
    const line = p.bom.find(([x]) => x === sku);
    return line ? s + line[1] * PRODUCTION[p.key][m] * (sku.startsWith('RM-OC') ? 1.004 : 1) : s;
  }, 0);
}
function avg(xs: number[]) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function lastDay(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function addDays(date: string, days: number) {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
