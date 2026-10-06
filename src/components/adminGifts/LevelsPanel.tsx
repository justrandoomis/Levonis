/**
 * «المستويات» — the five gift levels (docs/GIFTS_QUICK_BUY.md D2, D3): each
 * level's name and description in Arabic, English and Sorani, whether it is
 * open for grants, and its items — real store products, fully pinned. The
 * items of a level are alternatives: a customer with a level gift picks one.
 * Removing an item is soft (it stops being offered; gifts that chose it keep
 * their frozen choice). Legacy label-only boxes are listed read-only.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, failureText } from '../../lib/api';
import { Sheet } from '../ui/Overlay';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Banner, Field, Grid, TextArea, TextInput, Toggle } from '../adminProducts/form/formUi';
import * as T from '../adminProducts/theme';
import ItemFields, { blankItem } from './ItemFields';
import { ItemRow, triOf } from './ui';
import { adminText, type AdminLang, type AdminStringKey } from './strings';
import type { ItemInput, Level, LevelItem, Tri } from './types';

type LevelDraft = { name: Tri; description: Tri; active: boolean };

function ItemSheet({
  lang,
  open,
  level,
  item,
  onClose,
  onSaved,
}: {
  lang: AdminLang;
  open: boolean;
  level: number;
  item: LevelItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = (k: AdminStringKey) => adminText(lang, k);
  const titleId = useId();
  const [value, setValue] = useState<ItemInput>(blankItem());
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setActive(item ? item.active : true);
    setValue(
      item
        ? {
            productId: item.product_id,
            optionValueIds: item.option_value_ids,
            colorId: item.color_id,
            qty: item.qty,
            saleType: item.sale_type,
            transportMethod: (item.transport_method as ItemInput['transportMethod']) || '',
          }
        : blankItem()
    );
  }, [open, item]);

  const save = async () => {
    if (busy || !value.productId) return;
    setBusy(true);
    setError('');
    try {
      const body = { ...value, active };
      if (item) await api.put(`/api/gifts/admin/items/${encodeURIComponent(item.id)}`, body);
      else await api.post(`/api/gifts/admin/levels/${level}/items`, body);
      onSaved();
      onClose();
    } catch (e) {
      setError(failureText(e, t('loadFailed')));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={() => !busy && onClose()} labelledBy={titleId} panelClassName="w-full sm:max-w-lg">
      <div className={`${T.AP} px-5 pb-5 pt-2 space-y-3`} data-gift-item-sheet>
        <h2 id={titleId} className="text-[15px] font-bold text-[var(--ap-text-1)]">
          {item ? t('editItem') : t('addItem')} · {adminText(lang, 'levelN', { n: level })}
        </h2>
        <ItemFields lang={lang} value={value} onChange={setValue} disabled={busy} />
        {item && <Toggle checked={active} onChange={setActive} label={active ? t('active') : t('inactive')} />}
        {error && (
          <div role="alert">
            <Banner kind="error">{error}</Banner>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button type="button" className={`${T.btnGhost} flex-1`} onClick={onClose} disabled={busy}>
            {t('cancel')}
          </button>
          <button type="button" className={`${T.btnPrimary} flex-1`} onClick={() => void save()} disabled={busy || !value.productId} data-gift-item-save>
            {busy && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden />}
            {t('save')}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function LevelCard({ lang, level, onChanged }: { lang: AdminLang; level: Level; onChanged: () => void }) {
  const t = (k: AdminStringKey) => adminText(lang, k);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LevelDraft>({ name: level.name, description: level.description, active: level.active });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<{ item: LevelItem | null } | null>(null);
  const [removing, setRemoving] = useState<LevelItem | null>(null);
  const [removeError, setRemoveError] = useState('');

  useEffect(() => {
    if (!editing) setDraft({ name: level.name, description: level.description, active: level.active });
  }, [level, editing]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/api/gifts/admin/levels/${level.n}`, {
        name_ar: draft.name.ar,
        name_en: draft.name.en,
        name_ckb: draft.name.ckb,
        description_ar: draft.description.ar,
        description_en: draft.description.en,
        description_ckb: draft.description.ckb,
        active: draft.active,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(failureText(e, t('loadFailed')));
    } finally {
      setBusy(false);
    }
  };

  const langs: Array<[keyof Tri, AdminStringKey, 'rtl' | 'ltr']> = [
    ['ar', 'langAr', 'rtl'],
    ['en', 'langEn', 'ltr'],
    ['ckb', 'langCkb', 'rtl'],
  ];
  const activeItems = level.items.filter((i) => i.active);
  const inactiveItems = level.items.filter((i) => !i.active);

  return (
    <section className={`${T.surface} p-4 space-y-3`} data-gift-level={level.n} aria-labelledby={`gift-level-${level.n}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] text-[var(--ap-text-3)]">{adminText(lang, 'levelN', { n: level.n })}</p>
          <h3 id={`gift-level-${level.n}`} className="text-[15px] font-bold text-[var(--ap-text-1)]">
            {triOf(lang, level.name)}
          </h3>
          {triOf(lang, level.description) && <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--ap-text-2)]">{triOf(lang, level.description)}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[12px] font-semibold ${level.active ? 'text-success' : 'text-[var(--ap-text-3)]'}`}>
            {level.active ? t('active') : t('levelOff')}
          </span>
          <button type="button" className={T.btnSecondary} onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            <Pencil className="w-3.5 h-3.5" aria-hidden /> {t('edit')}
          </button>
        </div>
      </header>

      {editing && (
        <div className="space-y-3 rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-3">
          <Grid cols={3}>
            {langs.map(([k, label, dir]) => (
              <Field key={`n-${k}`} ar={`${t('levelName')} · ${t(label)}`} en="Name">
                <TextInput dir={dir} value={draft.name[k]} maxLength={80} onChange={(e) => setDraft({ ...draft, name: { ...draft.name, [k]: e.target.value } })} />
              </Field>
            ))}
            {langs.map(([k, label, dir]) => (
              <Field key={`d-${k}`} ar={`${t('levelDescription')} · ${t(label)}`} en="Description">
                <TextArea
                  dir={dir}
                  rows={3}
                  maxLength={600}
                  value={draft.description[k]}
                  onChange={(e) => setDraft({ ...draft, description: { ...draft.description, [k]: e.target.value } })}
                />
              </Field>
            ))}
          </Grid>
          <Toggle checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} label={draft.active ? t('levelActive') : t('levelOff')} />
          {error && <Banner kind="error">{error}</Banner>}
          <div className="flex gap-2">
            <button type="button" className={T.btnGhost} onClick={() => setEditing(false)} disabled={busy}>
              {t('cancel')}
            </button>
            <button type="button" className={T.btnPrimary} onClick={() => void save()} disabled={busy || !draft.name.ar.trim()} data-gift-level-save>
              {busy && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {t('save')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-[var(--ap-text-1)]">
            {t('items')} <span className="text-[var(--ap-text-3)] tabular-nums">({activeItems.length})</span>
          </p>
          <button type="button" className={T.btnSecondary} onClick={() => setSheet({ item: null })} data-gift-add-item={level.n}>
            <Plus className="w-3.5 h-3.5" aria-hidden /> {t('addItem')}
          </button>
        </div>
        {level.items.length === 0 && <p className="text-[12.5px] text-[var(--ap-text-2)]">{t('noItems')}</p>}
        <ul className="space-y-2">
          {[...activeItems, ...inactiveItems].map((item) => (
            <li
              key={item.id}
              className={`rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-2.5 ${item.active ? '' : 'opacity-60'}`}
              data-gift-level-item={item.id}
            >
              <ItemRow
                lang={lang}
                item={item}
                trailing={
                  <div className="flex shrink-0 items-center gap-1">
                    {!item.active && <span className="text-[11.5px] text-[var(--ap-text-3)]">{t('inactive')}</span>}
                    <button type="button" className={T.btnIcon} aria-label={t('edit')} title={t('edit')} onClick={() => setSheet({ item })}>
                      <Pencil className="w-3.5 h-3.5" aria-hidden />
                    </button>
                    {item.active && (
                      <button type="button" className={T.btnIconDanger} aria-label={t('remove')} title={t('remove')} onClick={() => setRemoving(item)}>
                        <Trash2 className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                }
              />
            </li>
          ))}
        </ul>
        {level.legacy_items.length > 0 && (
          <details className="rounded-[var(--ap-radius-md)] border border-[var(--ap-border)] p-2.5">
            <summary className="cursor-pointer text-[12.5px] text-[var(--ap-text-2)]">
              {t('legacyItems')} ({level.legacy_items.length})
            </summary>
            <ul className="mt-2 space-y-1 text-[12px] text-[var(--ap-text-2)]">
              {level.legacy_items.map((li) => (
                <li key={li.id}>
                  • {triOf(lang, li.label)} {li.brand ? `· ${li.brand}` : ''} — {t('stock')} {li.stock}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <ItemSheet
        lang={lang}
        open={!!sheet}
        level={level.n}
        item={sheet?.item ?? null}
        onClose={() => setSheet(null)}
        onSaved={onChanged}
      />
      <ConfirmDialog
        open={!!removing}
        title={t('remove')}
        consequence={t('removeItemConfirm')}
        confirmLabel={t('remove')}
        cancelLabel={t('cancel')}
        destructive
        error={removeError || undefined}
        onConfirm={async () => {
          if (!removing) return;
          setRemoveError('');
          try {
            await api.delete(`/api/gifts/admin/items/${encodeURIComponent(removing.id)}`);
            setRemoving(null);
            onChanged();
          } catch (e) {
            setRemoveError(failureText(e, t('loadFailed')));
          }
        }}
        onCancel={() => {
          setRemoving(null);
          setRemoveError('');
        }}
      />
    </section>
  );
}

export default function LevelsPanel({ lang }: { lang: AdminLang }) {
  const t = (k: AdminStringKey) => adminText(lang, k);
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get<{ levels: Level[] }>('/api/gifts/admin/levels');
      setLevels(res.levels ?? []);
    } catch (e) {
      setError(failureText(e, adminText(lang, 'loadFailed')));
    }
  }, [lang]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!levels && !error) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-[var(--ap-text-3)]">
        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> {t('loading')}
      </p>
    );
  }
  return (
    <div className="space-y-3" data-gift-levels>
      <p className="text-[12.5px] leading-relaxed text-[var(--ap-text-3)]">{t('itemsHint')}</p>
      {error && (
        <Banner kind="error">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            {t('retry')}
          </button>
        </Banner>
      )}
      {(levels ?? []).map((level) => (
        <LevelCard key={level.n} lang={lang} level={level} onChanged={() => void load()} />
      ))}
    </div>
  );
}
