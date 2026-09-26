import { useEffect, useState } from 'react';
import { Pencil, Plus, Warehouse as WarehouseIcon } from 'lucide-react';
import { useApiMutation, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import type { Warehouse } from '../../core/types';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Money } from '../../ui/Money';
import { Dialog } from '../../ui/Dialog';
import { Checkbox, Field, Input } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { useWarehouses } from './common';

function WarehouseDialog({ open, onClose, warehouse }: { open: boolean; onClose(): void; warehouse: Warehouse | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const errText = useErrorText();
  const blank = { code: '', nameEn: '', nameAr: '', address: '', isActive: true, isDefault: false };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      warehouse
        ? { code: warehouse.code, nameEn: warehouse.name_en, nameAr: warehouse.name_ar, address: warehouse.address ?? '', isActive: !!warehouse.is_active, isDefault: !!warehouse.is_default }
        : blank,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, warehouse]);
  const save = useApiMutation(() => (warehouse ? api.put(`/inventory/warehouses/${warehouse.id}`, f) : api.post('/inventory/warehouses', f)));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={warehouse ? t('inventory.editWarehouse') : t('inventory.newWarehouse')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.code || !f.nameEn || !f.nameAr}
            onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('common.code')}>
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} dir="ltr" />
        </Field>
        <div className="grid-2">
          <Field label={t('common.nameEn')}>
            <Input dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} />
          </Field>
          <Field label={t('common.nameAr')}>
            <Input dir="rtl" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} />
          </Field>
        </div>
        <Field label={t('common.address')}>
          <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <div className="row wrap" style={{ gap: 20 }}>
          <Checkbox label={t('inventory.isDefault')} checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} />
          <Checkbox label={t('common.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
        </div>
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

export function WarehousesPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { data, isLoading } = useWarehouses();
  const [dialog, setDialog] = useState<{ w: Warehouse | null } | null>(null);
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/inventory', label: t('nav.stock') }]}
        title={t('inventory.warehousesTitle')}
        subtitle={t('inventory.warehousesSubtitle')}
        actions={
          can('inventory.write') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ w: null })}>
              {t('inventory.newWarehouse')}
            </Button>
          )
        }
      />
      {isLoading ? (
        <Loading />
      ) : (
        <div className="feature-grid">
          {(data ?? []).map((w) => (
            <div key={w.id} className="feature" style={{ opacity: w.is_active ? 1 : 0.55 }}>
              <div className="row">
                <WarehouseIcon style={{ color: w.is_default ? 'var(--primary)' : 'var(--text-muted)' }} />
                <span className="num faint">{w.code}</span>
                <span className="spacer" />
                {!!w.is_default && <Badge tone="blue">{t('inventory.isDefault')}</Badge>}
                {!w.is_active && <Badge>{t('common.inactive')}</Badge>}
                {can('inventory.write') && <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setDialog({ w })} />}
              </div>
              <h3>{pick(w.name_en, w.name_ar)}</h3>
              <p>{w.address || '—'}</p>
              <div className="row" style={{ marginTop: 6, fontSize: 13 }}>
                <span className="muted">
                  {t('inventory.items')}: <strong style={{ color: 'var(--text)' }}>{w.items ?? 0}</strong>
                </span>
                <span className="spacer" />
                <strong>
                  <Money v={w.value ?? 0} />
                </strong>
              </div>
            </div>
          ))}
        </div>
      )}
      <WarehouseDialog open={!!dialog} onClose={() => setDialog(null)} warehouse={dialog?.w ?? null} />
    </div>
  );
}
