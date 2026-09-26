import type { AccountType } from './schema.js';

export interface TemplateAccount {
  code: string;
  en: string;
  ar: string;
  type: AccountType;
  subtype: string;
  group?: boolean;
  /** Key in the default-account map (see DefaultAccountKey). */
  role?: DefaultAccountKey;
  children?: TemplateAccount[];
}

export type DefaultAccountKey =
  | 'cash'
  | 'bank'
  | 'receivable'
  | 'payable'
  | 'sales'
  | 'services'
  | 'purchases'
  | 'inventory'
  | 'cogs'
  | 'vatOutput'
  | 'vatInput'
  | 'retainedEarnings'
  | 'capital'
  | 'inventoryAdjustment';

export const DEFAULT_ACCOUNT_KEYS: DefaultAccountKey[] = [
  'cash', 'bank', 'receivable', 'payable', 'sales', 'services', 'purchases',
  'inventory', 'cogs', 'vatOutput', 'vatInput', 'retainedEarnings', 'capital', 'inventoryAdjustment',
];

/** A clean, IFRS-friendly starter chart, bilingual. */
export const STANDARD_CHART: TemplateAccount[] = [
  {
    code: '1', en: 'Assets', ar: 'الأصول', type: 'asset', subtype: 'current_asset', group: true,
    children: [
      {
        code: '11', en: 'Current Assets', ar: 'الأصول المتداولة', type: 'asset', subtype: 'current_asset', group: true,
        children: [
          { code: '1110', en: 'Cash on Hand', ar: 'النقدية بالصندوق', type: 'asset', subtype: 'cash', role: 'cash' },
          { code: '1120', en: 'Bank Accounts', ar: 'الحسابات البنكية', type: 'asset', subtype: 'bank', role: 'bank' },
          { code: '1130', en: 'Accounts Receivable', ar: 'العملاء (ذمم مدينة)', type: 'asset', subtype: 'receivable', role: 'receivable' },
          { code: '1140', en: 'Inventory', ar: 'المخزون', type: 'asset', subtype: 'inventory', role: 'inventory' },
          { code: '1150', en: 'VAT Receivable (Input)', ar: 'ضريبة القيمة المضافة - مدخلات', type: 'asset', subtype: 'current_asset', role: 'vatInput' },
          { code: '1160', en: 'Prepaid Expenses', ar: 'مصروفات مدفوعة مقدماً', type: 'asset', subtype: 'current_asset' },
          { code: '1170', en: 'Employee Advances', ar: 'سلف الموظفين', type: 'asset', subtype: 'current_asset' },
        ],
      },
      {
        code: '12', en: 'Non-Current Assets', ar: 'الأصول غير المتداولة', type: 'asset', subtype: 'fixed_asset', group: true,
        children: [
          { code: '1210', en: 'Furniture & Equipment', ar: 'الأثاث والمعدات', type: 'asset', subtype: 'fixed_asset' },
          { code: '1220', en: 'Vehicles', ar: 'السيارات', type: 'asset', subtype: 'fixed_asset' },
          { code: '1230', en: 'Computers & Software', ar: 'أجهزة الحاسب والبرامج', type: 'asset', subtype: 'fixed_asset' },
          { code: '1290', en: 'Accumulated Depreciation', ar: 'مجمع الإهلاك', type: 'asset', subtype: 'accumulated_depreciation' },
        ],
      },
    ],
  },
  {
    code: '2', en: 'Liabilities', ar: 'الالتزامات', type: 'liability', subtype: 'current_liability', group: true,
    children: [
      {
        code: '21', en: 'Current Liabilities', ar: 'الالتزامات المتداولة', type: 'liability', subtype: 'current_liability', group: true,
        children: [
          { code: '2110', en: 'Accounts Payable', ar: 'الموردون (ذمم دائنة)', type: 'liability', subtype: 'payable', role: 'payable' },
          { code: '2120', en: 'VAT Payable (Output)', ar: 'ضريبة القيمة المضافة - مخرجات', type: 'liability', subtype: 'current_liability', role: 'vatOutput' },
          { code: '2130', en: 'Accrued Expenses', ar: 'مصروفات مستحقة', type: 'liability', subtype: 'current_liability' },
          { code: '2140', en: 'Salaries Payable', ar: 'رواتب مستحقة', type: 'liability', subtype: 'current_liability' },
          { code: '2150', en: 'Customer Advances', ar: 'دفعات مقدمة من العملاء', type: 'liability', subtype: 'current_liability' },
        ],
      },
      {
        code: '22', en: 'Non-Current Liabilities', ar: 'الالتزامات غير المتداولة', type: 'liability', subtype: 'non_current_liability', group: true,
        children: [
          { code: '2210', en: 'Long-term Loans', ar: 'قروض طويلة الأجل', type: 'liability', subtype: 'non_current_liability' },
        ],
      },
    ],
  },
  {
    code: '3', en: 'Equity', ar: 'حقوق الملكية', type: 'equity', subtype: 'equity', group: true,
    children: [
      { code: '3100', en: "Owner's Capital", ar: 'رأس المال', type: 'equity', subtype: 'equity', role: 'capital' },
      { code: '3200', en: 'Retained Earnings', ar: 'الأرباح المحتجزة', type: 'equity', subtype: 'retained_earnings', role: 'retainedEarnings' },
      { code: '3300', en: "Owner's Drawings", ar: 'المسحوبات الشخصية', type: 'equity', subtype: 'equity' },
    ],
  },
  {
    code: '4', en: 'Revenue', ar: 'الإيرادات', type: 'income', subtype: 'operating_income', group: true,
    children: [
      { code: '4100', en: 'Sales Revenue', ar: 'إيرادات المبيعات', type: 'income', subtype: 'operating_income', role: 'sales' },
      { code: '4200', en: 'Service Revenue', ar: 'إيرادات الخدمات', type: 'income', subtype: 'operating_income', role: 'services' },
      { code: '4900', en: 'Other Income', ar: 'إيرادات أخرى', type: 'income', subtype: 'other_income' },
    ],
  },
  {
    code: '5', en: 'Expenses', ar: 'المصروفات', type: 'expense', subtype: 'operating_expense', group: true,
    children: [
      { code: '5100', en: 'Cost of Goods Sold', ar: 'تكلفة البضاعة المباعة', type: 'expense', subtype: 'cogs', role: 'cogs' },
      { code: '5150', en: 'Purchases', ar: 'المشتريات', type: 'expense', subtype: 'cogs', role: 'purchases' },
      { code: '5160', en: 'Inventory Adjustments', ar: 'تسويات المخزون', type: 'expense', subtype: 'cogs', role: 'inventoryAdjustment' },
      {
        code: '52', en: 'Operating Expenses', ar: 'المصروفات التشغيلية', type: 'expense', subtype: 'operating_expense', group: true,
        children: [
          { code: '5210', en: 'Salaries & Wages', ar: 'الرواتب والأجور', type: 'expense', subtype: 'operating_expense' },
          { code: '5220', en: 'Rent', ar: 'الإيجار', type: 'expense', subtype: 'operating_expense' },
          { code: '5230', en: 'Utilities', ar: 'الكهرباء والمياه والمرافق', type: 'expense', subtype: 'operating_expense' },
          { code: '5240', en: 'Telephone & Internet', ar: 'الهاتف والإنترنت', type: 'expense', subtype: 'operating_expense' },
          { code: '5250', en: 'Office Supplies', ar: 'أدوات مكتبية', type: 'expense', subtype: 'operating_expense' },
          { code: '5260', en: 'Marketing & Advertising', ar: 'الدعاية والإعلان', type: 'expense', subtype: 'operating_expense' },
          { code: '5270', en: 'Transportation', ar: 'مصروفات النقل والانتقالات', type: 'expense', subtype: 'operating_expense' },
          { code: '5280', en: 'Maintenance & Repairs', ar: 'الصيانة والإصلاحات', type: 'expense', subtype: 'operating_expense' },
          { code: '5290', en: 'Depreciation Expense', ar: 'مصروف الإهلاك', type: 'expense', subtype: 'depreciation' },
        ],
      },
      { code: '5800', en: 'Bank Charges', ar: 'مصروفات بنكية', type: 'expense', subtype: 'other_expense' },
      { code: '5900', en: 'Other Expenses', ar: 'مصروفات أخرى', type: 'expense', subtype: 'other_expense' },
    ],
  },
];

/** Minimal chart: only the accounts the system itself needs. */
export const MINIMAL_CHART: TemplateAccount[] = [
  { code: '1110', en: 'Cash on Hand', ar: 'النقدية بالصندوق', type: 'asset', subtype: 'cash', role: 'cash' },
  { code: '1120', en: 'Bank Accounts', ar: 'الحسابات البنكية', type: 'asset', subtype: 'bank', role: 'bank' },
  { code: '1130', en: 'Accounts Receivable', ar: 'العملاء (ذمم مدينة)', type: 'asset', subtype: 'receivable', role: 'receivable' },
  { code: '1140', en: 'Inventory', ar: 'المخزون', type: 'asset', subtype: 'inventory', role: 'inventory' },
  { code: '1150', en: 'VAT Receivable (Input)', ar: 'ضريبة القيمة المضافة - مدخلات', type: 'asset', subtype: 'current_asset', role: 'vatInput' },
  { code: '2110', en: 'Accounts Payable', ar: 'الموردون (ذمم دائنة)', type: 'liability', subtype: 'payable', role: 'payable' },
  { code: '2120', en: 'VAT Payable (Output)', ar: 'ضريبة القيمة المضافة - مخرجات', type: 'liability', subtype: 'current_liability', role: 'vatOutput' },
  { code: '3100', en: "Owner's Capital", ar: 'رأس المال', type: 'equity', subtype: 'equity', role: 'capital' },
  { code: '3200', en: 'Retained Earnings', ar: 'الأرباح المحتجزة', type: 'equity', subtype: 'retained_earnings', role: 'retainedEarnings' },
  { code: '4100', en: 'Sales Revenue', ar: 'إيرادات المبيعات', type: 'income', subtype: 'operating_income', role: 'sales' },
  { code: '4200', en: 'Service Revenue', ar: 'إيرادات الخدمات', type: 'income', subtype: 'operating_income', role: 'services' },
  { code: '5100', en: 'Cost of Goods Sold', ar: 'تكلفة البضاعة المباعة', type: 'expense', subtype: 'cogs', role: 'cogs' },
  { code: '5150', en: 'Purchases', ar: 'المشتريات', type: 'expense', subtype: 'cogs', role: 'purchases' },
  { code: '5160', en: 'Inventory Adjustments', ar: 'تسويات المخزون', type: 'expense', subtype: 'cogs', role: 'inventoryAdjustment' },
];
