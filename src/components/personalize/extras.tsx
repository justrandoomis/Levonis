/**
 * THE CONTENT PAGES BEYOND THE ROW'S CORE — the icon, the QR code, «Tap with
 * your phone», the owner's logo or photo, and the note for the maker (survey
 * S2). Each lists only what the blueprint declares; the same component serves
 * a tile (inline) and a More page (inside the one sheet). A lazy chunk (C4
 * grows it into the studio's extras): a blueprint without these never loads
 * it, and the studio's first paint does not wait for it.
 *
 * A picture picked here stays on this device in C1 (an object URL; the
 * builder's preview never uploads): the check reads its pixel size, its
 * transparency and roughly how many colours it has (LOGO_DETAIL,
 * PHOTO_LOW_RES, PHOTO_NEEDS_CUTOUT). C3 uploads it through the `design_asset`
 * purpose before a configuration is minted.
 */
import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import type { IconKey, LogoMode, NfcKind, PhotoMode, QrKind } from '../../../packages/catalog/src/personalize/types';
import { ICON_KEYS, ICON_WORDS, LOGO_MODES, LOGO_WORDS, PHOTO_MODES, PHOTO_WORDS, TARGET_KEYS, TARGET_WORDS, word } from '../../../packages/catalog/src/personalize/vocab';
import { normalizeTarget } from '../../../packages/catalog/src/personalize/config';
import { Input, Textarea } from '../ui/Field';
import { type Kit, type LocalAsset } from './useStudio';

const chip = 'lv-choice shrink-0 px-3 text-[13px]';

/** The icon choices of an icon area (the closed lucide set, loaded when first shown). */
export function IconPicker({ k, areaId }: { k: Kit; areaId: string }) {
  const { pub, state, dispatch, t, lang } = k;
  const area = pub.areas.find((a) => a.id === areaId);
  const [paths, setPaths] = useState<Readonly<Record<IconKey, readonly string[]>> | null>(null);
  useEffect(() => {
    let live = true;
    void import('./iconPaths').then((m) => live && setPaths(m.ICON_PATHS));
    return () => {
      live = false;
    };
  }, []);
  if (!area?.icon) return null;
  const keys: readonly IconKey[] = area.icon.keys === 'all' ? ICON_KEYS : area.icon.keys;
  const current = state.config.icon[areaId] ?? null;
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-text-muted">{t.icon}</p>
      <div className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 hide-scrollbar" role="radiogroup" aria-label={t.icon}>
        {!area.required && (
          <button type="button" role="radio" aria-checked={current === null} className={`${chip} snap-start`} onClick={() => dispatch({ type: 'icon', area: areaId, key: null })}>
            {t.none}
          </button>
        )}
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={current === key}
            aria-label={word(ICON_WORDS, ICON_KEYS, key, lang)}
            title={word(ICON_WORDS, ICON_KEYS, key, lang)}
            data-icon={key}
            onClick={() => dispatch({ type: 'icon', area: areaId, key })}
            className="lv-choice flex h-11 w-11 shrink-0 snap-start items-center justify-center"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              {paths?.[key]?.map((d, i) => <path key={i} d={d} />)}
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Which field a target kind asks for. */
const fieldOf = (kind: string): 'handle' | 'phone' | 'link' | 'text' =>
  kind === 'instagram' || kind === 'tiktok' ? 'handle' : kind === 'whatsapp' || kind === 'contact' ? 'phone' : kind === 'wifi' ? 'text' : 'link';

/** A QR code's target — or, with `areaId` 'nfc', the tag's (survey S2 «QR code», «Tap with your phone»). */
export function TargetPage({ k, areaId }: { k: Kit; areaId: string }) {
  const { pub, state, derived, dispatch, t, lang } = k;
  const nfc = areaId === 'nfc';
  const kinds: readonly string[] = nfc ? pub.extras.nfc?.kinds ?? [] : pub.areas.find((a) => a.id === areaId)?.qr?.kinds ?? [];
  const typed = state.targets[areaId];
  const [kind, setKind] = useState(typed?.kind ?? kinds[0] ?? '');
  if (!kinds.length) return null;
  const raw = typed?.kind === kind ? typed.raw : '';
  const set = nfc ? state.config.nfc : state.config.qr[areaId];
  const field = fieldOf(kind);
  const issue = derived.check.issues.find((i) => i.path === `qr.${areaId}` && (i.code === 'QR_UNREADABLE' || i.code === 'SIZE_UP_FOR_QR'));
  /** The engine's canonical target (null: not one) travels with what was typed. */
  const put = (k: string, raw: string) => dispatch({ type: 'target', area: areaId, kind: k, raw, value: normalizeTarget(k as QrKind | NfcKind, raw, nfc) });
  const pick = (next: string) => {
    setKind(next);
    if (next === 'reorder') put(next, '');
    else if (typed?.raw) put(next, typed.raw);
  };
  return (
    <div className="space-y-3 px-3 py-3" data-target={areaId}>
      <div className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 hide-scrollbar" role="radiogroup" aria-label={nfc ? t.nfc : t.tiles.qr}>
        {kinds.map((q) => (
          <button key={q} type="button" role="radio" aria-checked={q === kind} className={`${chip} snap-start`} onClick={() => pick(q)}>
            {word(TARGET_WORDS, TARGET_KEYS, q, lang)}
          </button>
        ))}
      </div>
      {kind === 'reorder' ? (
        <p className="text-[12.5px] leading-relaxed text-text-muted">{t.reorderLater}</p>
      ) : (
        <>
          <Input
            value={raw}
            ltr={field !== 'text'}
            dir={field === 'text' ? 'auto' : undefined}
            inputMode={field === 'phone' ? 'tel' : field === 'link' ? 'url' : undefined}
            aria-label={t.qrField[field]}
            placeholder={t.qrField[field]}
            autoComplete="off"
            onChange={(e) => put(kind, e.target.value)}
          />
          {raw && !set ? (
            <p className="text-[12px] text-warning" role="status">{t.qrCheck}</p>
          ) : set && !nfc ? (
            <p className={`text-[12px] ${issue ? 'text-warning' : 'text-success'}`} role="status">
              {issue ? t.check[issue.code] : t.scansWell}
            </p>
          ) : null}
          {nfc && (kind === 'wifi' || kind === 'contact') && <p className="text-[12px] leading-relaxed text-text-muted">{t.shopSees}</p>}
        </>
      )}
      {set && (
        <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => dispatch({ type: 'clearTarget', area: areaId })}>
          {t.remove}
        </button>
      )}
    </div>
  );
}

/** What the check needs to know of a picture: its size, transparency, and about how many colours it has. */
async function pictureFacts(url: string): Promise<LocalAsset | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let has_alpha = false;
  const seen = new Set<number>();
  if (ctx) {
    ctx.drawImage(img, 0, 0, 48, 48);
    const d = ctx.getImageData(0, 0, 48, 48).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 250) has_alpha = true;
      if (d[i + 3] > 32) seen.add(((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5));
    }
  }
  return { url, px_w: img.naturalWidth, px_h: img.naturalHeight, has_alpha, colours: seen.size };
}

/** The owner's logo or photo, picked on this device (survey S2 «Your logo», «Photo»). */
export function ImagePage({ k, areaId }: { k: Kit; areaId: string }) {
  const { pub, state, dispatch, t, lang, mode } = k;
  const area = pub.areas.find((a) => a.id === areaId);
  const input = useRef<HTMLInputElement>(null);
  const kind = area?.logo ? 'logo' : area?.photo ? 'photo' : null;
  if (!area || !kind) return null;
  const asset = state.assets[areaId];
  const chosen = state.config[kind][areaId]?.mode;
  const modes: readonly string[] = kind === 'logo' ? area.logo!.modes : area.photo!.modes;
  const modeWord = (m: string) => (kind === 'logo' ? word(LOGO_WORDS, LOGO_MODES, m as LogoMode, lang) : word(PHOTO_WORDS, PHOTO_MODES, m as PhotoMode, lang));
  const onFile = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const facts = await pictureFacts(URL.createObjectURL(file));
    if (facts) dispatch({ type: 'asset', area: areaId, asset: facts });
  };
  return (
    <div className="space-y-3 px-3 py-3" data-picture={areaId}>
      <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e.target.files?.[0])} />
      {asset ? (
        <div className="flex items-center gap-3">
          <img src={asset.url} alt="" className="h-16 w-16 shrink-0 rounded-xl border border-border-subtle bg-surface-raised object-contain" />
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            <button type="button" className="lv-button lv-button-secondary lv-button-sm" onClick={() => input.current?.click()}>
              {t.change}
            </button>
            <button type="button" className="lv-button lv-button-ghost lv-button-sm" onClick={() => dispatch({ type: 'asset', area: areaId, asset: null })}>
              {t.remove}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="lv-button lv-button-secondary w-full" onClick={() => input.current?.click()}>
          <ImagePlus aria-hidden="true" className="h-4 w-4" />
          {kind === 'logo' ? t.addLogo : t.addPhoto}
        </button>
      )}
      {asset && modes.length > 1 && (
        <div className="-mx-3 flex snap-x gap-2 overflow-x-auto px-3 pb-1 hide-scrollbar" role="radiogroup" aria-label={kind === 'logo' ? t.tiles.logo : t.tiles.photo}>
          {modes.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={m === chosen} className={`${chip} snap-start`} onClick={() => dispatch({ type: 'mode', area: areaId, mode: m })}>
              {modeWord(m)}
            </button>
          ))}
        </div>
      )}
      {mode === 'preview' && <p className="text-[12px] leading-relaxed text-text-muted">{t.localOnly}</p>}
    </div>
  );
}

/** The note for the maker (≤ 500 characters, plain text). */
export function NotesPage({ k }: { k: Kit }) {
  const { state, dispatch, t } = k;
  const [raw, setRaw] = useState(state.config.notes);
  return (
    <div className="space-y-2 px-3 py-3">
      <Textarea
        value={raw}
        rows={4}
        maxLength={500}
        dir="auto"
        aria-label={t.notes}
        placeholder={t.notesHint}
        onChange={(e) => {
          setRaw(e.target.value);
          dispatch({ type: 'notes', text: e.target.value });
        }}
      />
    </div>
  );
}
