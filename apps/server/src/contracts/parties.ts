/** Business partners (customers & suppliers) — master data shared by AR, AP, Treasury and Inventory. */
export type PartyKind = 'customer' | 'supplier' | 'both';

export interface Party {
  id: number;
  kind: PartyKind;
  code: string;
  name: string;
  name_alt: string | null;
  tax_number: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  receivable_account_id: number | null;
  payable_account_id: number | null;
  payment_terms_days: number;
  credit_limit: number | null;
  notes: string | null;
  is_active: number;
  created_at: string;
}

/** What a partner role is called in permissions (registered by AR for customers, AP for suppliers). */
export interface PartyRoleInfo {
  /** Permission prefix, e.g. "ar.customers" → ar.customers.read / .write */
  perm: string;
}

export interface PartiesService {
  get(id: number): Party;
  names(ids: number[]): Map<number, string>;
  /** The AR control account for a customer (its own or the default). */
  receivableAccount(p: Party): number;
  /** The AP control account for a supplier (its own or the default). */
  payableAccount(p: Party): number;
  assertKind(p: Party, kind: 'customer' | 'supplier'): void;
  /** Create a party from the same input as POST /parties (validated inside; the caller checks rights). */
  create(input: unknown, userId: number | null): { id: number; code: string };
  /** AR and AP plug their partner role in; a role nobody registered cannot be used. */
  registerRole(kind: 'customer' | 'supplier', info: PartyRoleInfo): void;
  role(kind: 'customer' | 'supplier'): PartyRoleInfo | null;
}

declare module '../kernel/services.js' {
  interface ServiceMap {
    parties: PartiesService;
  }
}
