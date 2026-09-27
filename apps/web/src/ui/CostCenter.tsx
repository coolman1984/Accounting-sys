import { useApi } from '../core/hooks';
import { useI18n } from '../core/i18n';
import { useSession } from '../core/session';
import { Select } from './Field';

export interface CostCenter {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  parent_id: number | null;
  is_active: number;
}

/** Cost centers when the CO app is on; otherwise nothing to show. */
export function useCostCenters() {
  const { hasApp } = useSession();
  const on = hasApp('co');
  const { data } = useApi<CostCenter[]>(on ? '/cost-centers' : null, undefined, { staleTime: 60_000 });
  return { on, list: data ?? [] };
}

export function CostCenterSelect({ value, onChange, list, sm }: { value: number | null; onChange(id: number | null): void; list: CostCenter[]; sm?: boolean }) {
  const { t, pick } = useI18n();
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className={sm ? 'input-sm' : undefined} aria-label={t('co.costCenter')}>
      <option value="">—</option>
      {list
        .filter((c) => c.is_active || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {pick(c.name_en, c.name_ar)}
          </option>
        ))}
    </Select>
  );
}
