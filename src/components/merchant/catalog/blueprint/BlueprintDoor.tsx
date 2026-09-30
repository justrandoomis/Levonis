/**
 * «التخصيص · Customization · خۆگونجاندن» — THE DOOR IN THE PRODUCT EDITOR
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 1, §0 rows
 * 5 and 39). One line of state — off · draft · live (rev n) · paused — and
 * «ابدأ التخصيص» / «تعديل» / «إيقاف». The editor mounts this file lazily
 * (a chunk of its own, `BlueprintDoor`), and only when /api/merchant/me says
 * `can.customize` (./gate.ts); the builder is another chunk, fetched on the
 * first tap. The door also hides itself when the builder's own door answers
 * 404 for this merchant (the switch closed since the page loaded).
 *
 * Its words are the builder's table for the merchant's language only
 * (./strings.ts `useWords`, a lazy chunk per language): it is fetched with
 * the builder's state, so the builder opens with its words already here.
 *
 * Hooks for probes: data-blueprint-door = off | draft | live | paused |
 * ineligible | failed | new, data-blueprint-open, data-blueprint-pause.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { useLanguage } from '../../../../LanguageContext';
import { api, ApiError } from '../../../../lib/api';
import { Button } from '../../../ui/Button';
import { StatusChip } from '../../../ui/Badge';
import { useConfirm } from '../../../ui/ConfirmDialog';
import { useToast } from '../../../ui/Toast';
import type { CatalogProductDetail } from '../catalogApi';
import type { BuilderState } from './api';
import { useWords } from './strings';

const Builder = lazy(() => import('./Builder'));

export type DoorState = 'off' | 'draft' | 'live' | 'paused';

/** What the door says: a live revision, else a paused one (retired, nothing live), else a draft, else off. */
export function doorState(st: Pick<BuilderState, 'draft' | 'live' | 'retired'>): { state: DoorState; rev: number | null } {
  if (st.live) return { state: 'live', rev: st.live.rev };
  if (st.retired.length) return { state: 'paused', rev: st.retired[0].rev };
  return st.draft ? { state: 'draft', rev: st.draft.rev } : { state: 'off', rev: null };
}

/** A state's words are `door<State>` and `door<State>Hint` (./strings.ar.ts). */
const keyOf = (s: DoorState) => `door${s[0].toUpperCase()}${s.slice(1)}` as `door${Capitalize<DoorState>}`;

export default function BlueprintDoor({ product, dirty, onReload }: { product: CatalogProductDetail | null; dirty: boolean; onReload: () => void }) {
  const { lang } = useLanguage();
  const t = useWords(lang);
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [st, setSt] = useState<BuilderState | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const id = product?.id;
  const path = `/api/merchant/products/${encodeURIComponent(id ?? '')}/blueprint`;

  useEffect(() => {
    if (!id) return;
    let live = true;
    setErr(null);
    api
      .get<BuilderState>(path, { mascot: 'silent' })
      .then((d) => live && setSt(d))
      .catch((e: unknown) => live && setErr(e));
    return () => {
      live = false;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The words ride with the state: nothing is drawn until the merchant's language is here.
  // A 404: the switch closed for this merchant since the page loaded — there is no door.
  // A product not saved yet has nothing to customize: the door appears once it is.
  if (!t || !product || (err instanceof ApiError && err.status === 404)) return null;

  async function pause() {
    if (!t || !(await confirm({ title: t.doorPauseTitle, consequence: t.doorPauseBody, confirmLabel: t.doorPause }))) return;
    try {
      setSt(await api.post<BuilderState>(`${path}/pause`));
      toast.success(t.doorPausedToast);
    } catch (e) {
      const { apiRefusal } = await import('../../../../lib/refusalStrings');
      toast.error(apiRefusal(e, lang, t.doorFailed));
    }
  }

  const why = err instanceof ApiError && err.code === 'BLUEPRINT_PRODUCT_INELIGIBLE' ? String(err.details?.reason ?? '') : null;
  const at = !err && st ? doorState(st) : null;
  const key = at && keyOf(at.state);
  const kind = why !== null ? 'ineligible' : err ? 'failed' : at ? at.state : 'loading';
  const text = why !== null ? t[why === 'private' ? 'doorPrivate' : why === 'archived' ? 'doorArchived' : 'doorLegacy'] : err ? t.doorFailed : key ? t[`${key}Hint`] : '';

  return (
    <section className="rounded-2xl border border-border-subtle bg-surface-raised/40 px-4 py-3" data-blueprint-door={kind}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-text-primary">{t.doorTitle}</h3>
        {at && key && <StatusChip tone={at.state === 'live' ? 'success' : at.state === 'paused' ? 'warning' : 'neutral'}>{t[key].replace('{rev}', String(at.rev))}</StatusChip>}
      </div>
      <p className="mt-0.5 min-h-4 text-[12.5px] leading-relaxed text-text-muted">{text}</p>
      {at && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-blueprint-open>{at.state === 'off' ? t.doorStart : t.doorEdit}</Button>
          {at.state === 'live' && <Button size="sm" variant="ghost" onClick={pause} data-blueprint-pause>{t.doorPause}</Button>}
        </div>
      )}
      {open && st && (
        <Suspense fallback={null}>
          <Builder product={product} initial={st} dirty={dirty} onState={setSt} onClose={() => setOpen(false)} onReload={onReload} />
        </Suspense>
      )}
      {confirmDialog}
    </section>
  );
}
