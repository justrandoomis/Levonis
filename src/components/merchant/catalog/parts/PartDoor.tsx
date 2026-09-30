/**
 * «يُستخدم داخل منتجات مطبوعة» — THE PART DOOR IN THE PRODUCT EDITOR
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3).
 *
 * One switch makes the product a part; when it is on, a second one keeps it
 * off the shelf — «مخفي عن المتجر — داخل المنتجات فقط» is the product's own
 * `hidden` state, nothing new — and the part's facts open below it. This file
 * is its own chunk (the editor mounts it lazily) and the facts are another,
 * fetched only when the switch is on, so an ordinary product's editor carries
 * a few hundred bytes for it.
 *
 * WHAT IS SENT IS THE FLAT MAP the server reads back strictly (400
 * PART_SPEC_INVALID names a field): switching on starts the map at the kind
 * «قطعة» (other) — the honest «not said yet» — and switching off sends null.
 */
import { Suspense, lazy } from 'react';
import { useLanguage } from '../../../../LanguageContext';
import { Switch } from '../../../ui/Switch';
import { Skeleton } from '../../../ui/Skeleton';
import type { CatalogProductDetail, PublishState } from '../catalogApi';
import type { VariantDraft } from '../VariantEditor';
import { partDoorStrings } from './strings';

const PartFields = lazy(() => import('./PartFields'));

export interface PartDoorProps {
  /** The form's part facts (the stored flat map), null when the product is not a part. */
  value: Record<string, string> | null;
  onChange: (value: Record<string, string> | null) => void;
  state: PublishState;
  onState: (state: PublishState) => void;
  /** The saved product — its option values, its id for «حدّث من ليفونيس». null for a new one. */
  product: CatalogProductDetail | null;
  /** The editor's variant draft: a per-option row is offered only for a SAVED value still in it. */
  variants: VariantDraft;
  errors: Record<string, string>;
  /** Unsaved edits in the editor — «حدّث من ليفونيس» asks for a save first. */
  dirty: boolean;
  /** Re-read the product after a refresh (its facts and pictures changed on the server). */
  onReload: () => void;
}

export default function PartDoor({ value, onChange, state, onState, product, variants, errors, dirty, onReload }: PartDoorProps) {
  const { lang } = useLanguage();
  const t = partDoorStrings(lang);
  const on = value !== null;
  return (
    <section className="rounded-2xl border border-border-subtle bg-surface-raised/40 px-4 py-1" data-part-door={on ? 'on' : 'off'}>
      <Switch
        checked={on}
        onChange={(v) => onChange(v ? { printed_use: 'Yes', part_kind: 'other' } : null)}
        label={t.use}
        description={t.useHint}
      />
      {on && (
        <div className="space-y-4 border-t border-border-subtle pb-4 pt-1">
          <Switch
            checked={state === 'hidden'}
            onChange={(v) => onState(v ? 'hidden' : 'published')}
            label={t.inside}
            description={t.insideHint}
          />
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <PartFields value={value} onChange={onChange} product={product} variants={variants} errors={errors} dirty={dirty} onReload={onReload} />
          </Suspense>
        </div>
      )}
    </section>
  );
}
