import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogActions } from '@/renderer/components/ui/dialog';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Alert } from '@/renderer/components/ui/alert';
import { FormField } from '@/renderer/components/form-field';
import { useAction } from '@/renderer/lib/use-action';
import type { SupplierDto } from '@/shared/contracts';
export function SupplierForm({
  initial,
  onSaved,
  onClose,
}: {
  initial?: SupplierDto;
  onSaved: (s: SupplierDto) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const action = useAction();
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phoneNumber ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [active, setActive] = useState(initial?.isActive ?? true);
  const [duplicate, setDuplicate] = useState(false);
  const request = useRef({ key: '', id: '' });
  const save = () =>
    void action.run(async () => {
      const payload = {
        id: initial?.id,
        name,
        phoneNumber: phone,
        email,
        address,
        isActive: active,
        acknowledgeDuplicates: duplicate,
      };
      const key = JSON.stringify(payload);
      if (request.current.key !== key)
        request.current = { key, id: crypto.randomUUID() };
      const result = await window.bengkelin.suppliers.save({
        ...payload,
        requestId: request.current.id,
      });
      if (action.check(result)) {
        if (result.value.saved) onSaved(result.value.supplier);
        else setDuplicate(true);
      }
    });
  return (
    <Dialog
      title={t('purchases.addSupplier')}
      onClose={() => {
        if (!action.busy) onClose();
      }}
      closeLabel={t('purchases.close')}
      footer={
        <DialogActions
          secondary={
            <Button variant="outline" onClick={onClose} disabled={action.busy}>
              {t('purchases.cancel')}
            </Button>
          }
        >
          <Button onClick={save} disabled={action.busy || !name.trim()}>
            {t('purchases.save')}
          </Button>
        </DialogActions>
      }
    >
      <div className="space-y-4">
        {action.error ? <Alert>{action.error}</Alert> : null}
        {duplicate ? <Alert>{t('purchases.duplicatePhone')}</Alert> : null}
        <FormField label={t('purchases.name')} error={action.fieldErrors.name}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDuplicate(false);
            }}
          />
        </FormField>
        <FormField
          label={t('purchases.phone')}
          error={action.fieldErrors.phoneNumber}
        >
          <Input
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setDuplicate(false);
            }}
          />
        </FormField>
        <FormField
          label={t('purchases.email')}
          error={action.fieldErrors.email}
        >
          <Input value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <FormField
          label={t('purchases.address')}
          error={action.fieldErrors.address}
        >
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </FormField>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          {t('purchases.active')}
        </label>
      </div>
    </Dialog>
  );
}
export function SuppliersScreen() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [inactive, setInactive] = useState(false);
  const [items, setItems] = useState<SupplierDto[]>([]);
  const [editing, setEditing] = useState<SupplierDto | null | false>(false);
  const action = useAction();
  const revision = useRef(0);
  const load = () =>
    void action.run(async () => {
      const rev = ++revision.current;
      const r = await window.bengkelin.suppliers.search({
        query,
        includeInactive: inactive,
        limit: 50,
      });
      if (rev === revision.current && action.check(r))
        setItems(r.value.results);
    });
  useEffect(() => {
    const timer = setTimeout(load, 150);
    return () => clearTimeout(timer);
  }, [query, inactive]);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FormField label={t('purchases.searchSupplier')}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} />
        </FormField>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={inactive}
            onChange={(e) => setInactive(e.target.checked)}
          />
          {t('purchases.includeInactive')}
        </label>
        <Button onClick={() => setEditing(null)}>
          {t('purchases.addSupplier')}
        </Button>
      </div>
      {action.error ? (
        <Alert>
          {action.error}
          <Button variant="outline" onClick={load}>
            {t('common.retry')}
          </Button>
        </Alert>
      ) : null}
      {!items.length ? (
        <p className="text-muted-foreground">{t('purchases.noSuppliers')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('purchases.suppliers')}</caption>
            <thead>
              <tr>
                {['name', 'phone', 'email', 'active'].map((k) => (
                  <th key={k} className="border-b p-3 text-left">
                    {t(`purchases.${k}`)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="border-b p-3 font-medium">{s.name}</td>
                  <td className="border-b p-3">{s.phoneNumber}</td>
                  <td className="border-b p-3">{s.email}</td>
                  <td className="border-b p-3">
                    {t(s.isActive ? 'purchases.yes' : 'purchases.no')}
                  </td>
                  <td className="border-b p-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(s)}
                    >
                      {t('purchases.edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== false ? (
        <SupplierForm
          {...(editing ? { initial: editing } : {})}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            load();
          }}
        />
      ) : null}
    </section>
  );
}
