import { useMemo } from 'react';
import { useApi } from '../core/hooks';
import { useI18n } from '../core/i18n';
import type { Account, Item, Paged, Party, Tax } from '../core/types';
import { Combobox } from './Combobox';
import { Select } from './Field';

export function useAccounts() {
  return useApi<Account[]>('/accounts', undefined, { staleTime: 30_000 });
}

export function AccountPicker({
  value,
  onChange,
  filter,
  includeGroups,
  sm,
  invalid,
  placeholder,
  autoFocus,
}: {
  value: number | null;
  onChange(id: number | null, account?: Account): void;
  filter?: (a: Account) => boolean;
  includeGroups?: boolean;
  sm?: boolean;
  invalid?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { pick, t } = useI18n();
  const { data } = useAccounts();
  const options = useMemo(
    () =>
      (data ?? [])
        .filter((a) => (includeGroups || !a.is_group) && (a.is_active || a.id === value) && (!filter || filter(a)))
        .map((a) => ({ id: a.id, code: a.code, label: pick(a.name_en, a.name_ar), search: `${a.name_en} ${a.name_ar}` })),
    [data, filter, includeGroups, pick, value],
  );
  return (
    <Combobox
      options={options}
      value={value}
      sm={sm}
      invalid={invalid}
      autoFocus={autoFocus}
      placeholder={placeholder ?? t('common.selectAccount')}
      onChange={(id) => onChange(id, data?.find((a) => a.id === id))}
    />
  );
}

export function useParties(kind?: 'customer' | 'supplier') {
  return useApi<Paged<Party>>('/parties', { kind, active: 1, limit: 500 }, { staleTime: 30_000 });
}

export function PartyPicker({
  kind,
  value,
  onChange,
  sm,
  invalid,
  autoFocus,
  placeholder,
}: {
  kind?: 'customer' | 'supplier';
  value: number | null;
  onChange(id: number | null, party?: Party): void;
  sm?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const { data } = useParties(kind);
  const options = useMemo(
    () => (data?.rows ?? []).map((p) => ({ id: p.id, code: p.code, label: p.name, search: `${p.name_alt ?? ''} ${p.phone ?? ''}` })),
    [data],
  );
  return (
    <Combobox
      options={options}
      value={value}
      sm={sm}
      invalid={invalid}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(id) => onChange(id, data?.rows.find((p) => p.id === id))}
    />
  );
}

export function useItems() {
  return useApi<Item[]>('/items', { active: 1 }, { staleTime: 30_000 });
}

export function ItemPicker({
  value,
  onChange,
  sm,
  filter,
  autoFocus,
}: {
  value: number | null;
  onChange(id: number | null, item?: Item): void;
  sm?: boolean;
  filter?: (i: Item) => boolean;
  autoFocus?: boolean;
}) {
  const { pick } = useI18n();
  const { data } = useItems();
  const options = useMemo(
    () =>
      (data ?? [])
        .filter((i) => !filter || filter(i))
        // Barcode scanners type the code then Enter: the barcode is searchable too.
        .map((i) => ({ id: i.id, code: i.sku, label: pick(i.name_en, i.name_ar), search: `${i.name_en} ${i.name_ar} ${i.barcode ?? ''} ${(i.units ?? []).map((u) => u.barcode ?? '').join(' ')}` })),
    [data, pick, filter],
  );
  return (
    <Combobox
      options={options}
      value={value}
      sm={sm}
      autoFocus={autoFocus}
      placeholder="—"
      onChange={(id) => onChange(id, data?.find((i) => i.id === id))}
    />
  );
}

export function useTaxes() {
  return useApi<Tax[]>('/taxes', undefined, { staleTime: 30_000 });
}

export function TaxSelect({
  value,
  onChange,
  side,
  sm,
}: {
  value: number | null;
  onChange(id: number | null): void;
  side: 'sales' | 'purchases';
  sm?: boolean;
}) {
  const { t, pick } = useI18n();
  const { data } = useTaxes();
  const list = (data ?? []).filter((x) => (x.is_active || x.id === value) && (x.scope === 'both' || x.scope === side));
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className={sm ? 'input-sm' : ''}>
      <option value="">{t('docs.noTax')}</option>
      {list.map((x) => (
        <option key={x.id} value={x.id}>
          {pick(x.name_en, x.name_ar)}
        </option>
      ))}
    </Select>
  );
}
