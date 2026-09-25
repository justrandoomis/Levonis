/**
 * MARKET — filament by material, colour and spool size; the printer catalog.
 *
 * Prices are the config's own numbers (price_per_gram × grams, the model's
 * price); the server charges exactly those or refuses. A locked model says
 * which level unlocks it; a full room says so on every card. Buying a printer
 * lands it in the lowest free slot — the room redraws from the returned state.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { Segmented } from '../../../components/ui/Segmented';
import { colorNameOf, farmApi, materialList, printerCatalog, type FarmState } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { formatCoins, formatInt, formatPercent, formatVolume, nameOf, swatchFor } from '../format';
import { Chip, SectionTitle, Spec, Swatch } from '../bits';
import { BTN_PRIMARY, BTN_SECONDARY, FOCUS, PANEL, SPEC } from '../ui';
import { Window, WINDOW_BODY } from '../sheets/Window';
import type { RunResult } from '../hooks/useFarmState';

export interface MarketViewProps {
  state: FarmState;
  lang: string;
  s: FarmStrings;
  busy: string | null;
  run: (actionId: string, call: (key: string) => Promise<unknown>) => Promise<RunResult>;
  onError: (err: unknown) => void;
  /** Preselect the printer catalog (an empty slot was tapped in the room). */
  focusCatalog?: boolean;
}

export default function MarketView({ state, lang, s, busy, run, onError, focusCatalog }: MarketViewProps) {
  const config = state.config;
  const level = state.profile.level;
  const coins = state.profile.coins;
  const materials = useMemo(() => materialList(config), [config]);
  const catalog = useMemo(() => printerCatalog(config), [config]);
  const sizes = useMemo(() => config.economy?.spool_sizes_g ?? [], [config.economy?.spool_sizes_g]);
  const storageTotal = state.profile.location.storage_grams;
  const storageUsed = state.spools.reduce((n, sp) => n + sp.grams_left, 0);
  const storageFree = Math.max(0, storageTotal - storageUsed);
  const freeSlots = state.profile.location.max_printers - state.printers.length;
  const owned = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of state.printers) m.set(p.model_key, (m.get(p.model_key) ?? 0) + 1);
    return m;
  }, [state.printers]);

  // ------------------------------------------------------------- filament
  const [material, setMaterial] = useState(() => materials.find((m) => m.def.min_level <= level)?.key ?? materials[0]?.key ?? '');
  const matDef = config.materials?.[material];
  const colors = useMemo(() => matDef?.colors ?? [], [matDef?.colors]);
  const [color, setColor] = useState(colors[0] ?? '');
  const [size, setSize] = useState<number>(sizes[0] ?? 0);
  useEffect(() => {
    if (!colors.includes(color)) setColor(colors[0] ?? '');
  }, [colors, color]);
  useEffect(() => {
    if (size === 0 && sizes.length > 0) setSize(sizes[0]);
  }, [sizes, size]);

  const materialLocked = !!matDef && matDef.min_level > level;
  const price = matDef && size > 0 ? Math.ceil(matDef.price_per_gram * size) : 0;
  const storageOk = size <= storageFree;
  const canBuyFilament = !!matDef && !materialLocked && !!color && size > 0 && price <= coins && storageOk && busy === null;

  const [confirmFilament, setConfirmFilament] = useState(false);
  const filamentBtn = useRef<HTMLButtonElement | null>(null);
  const filamentTitleId = useId();

  // -------------------------------------------------------------- printers
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const modelBtns = useRef(new Map<string, HTMLButtonElement | null>());
  const modelAnchor = useRef<HTMLElement | null>(null);
  const printerTitleId = useId();
  const catalogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focusCatalog) catalogRef.current?.scrollIntoView({ block: 'start' });
  }, [focusCatalog]);

  const act = async (id: string, call: (key: string) => Promise<unknown>) => {
    const r = await run(id, call);
    if (r.ok === false) onError(r.error);
    return r.ok;
  };

  const confirmModelDef = confirmModel ? config.printers?.[confirmModel] : null;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ filament */}
      <section className="space-y-3" aria-labelledby="farm-filament-title">
        <SectionTitle id="farm-filament-title" title={s.filament} />
        <div className={`${PANEL} p-4 space-y-4`}>
          <div className="space-y-2">
            <p className={SPEC}>{s.materialLabel}</p>
            {/* Each chip is a 44px control wrapped around a 36px pill: the hit
                area grows, the drawing stays the same size. */}
            <div role="radiogroup" aria-label={s.materialLabel} className="flex flex-wrap gap-x-1.5 gap-y-0">
              {materials.map(({ key, def }) => {
                const locked = def.min_level > level;
                const checked = key === material;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-disabled={locked || undefined}
                    data-farm-material={key}
                    onClick={() => setMaterial(key)}
                    title={locked ? s.materialLocked(def.min_level) : nameOf(def.name, lang, key)}
                    className="group inline-flex items-center min-h-[44px] min-w-[44px] rounded-full press-scale focus-visible:outline-none"
                    dir="ltr"
                  >
                    <span
                      className={`inline-flex items-center gap-1 h-9 px-3 rounded-full border text-[12px] font-bold group-focus-visible:ring-2 group-focus-visible:ring-gold ${
                        checked
                          ? 'border-gold/50 bg-gold/10 text-gold'
                          : locked
                            ? 'border-zinc-800 text-zinc-600'
                            : 'border-zinc-800 text-zinc-300 group-hover:text-white'
                      }`}
                    >
                      {locked && <Lock aria-hidden="true" className="w-3 h-3" />}
                      {key}
                    </span>
                  </button>
                );
              })}
            </div>
            {materialLocked && matDef && <p className="text-[11px] text-honey">{s.materialLocked(matDef.min_level)}</p>}
          </div>

          <div className="space-y-2">
            <p className={SPEC}>{s.colorLabel}</p>
            <div role="radiogroup" aria-label={s.colorLabel} className="flex flex-wrap gap-2">
              {colors.map((c) => {
                const checked = c === color;
                const label = nameOf(colorNameOf(config, c), lang, c);
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={label}
                    title={label}
                    data-farm-color={c}
                    onClick={() => setColor(c)}
                    className={`w-11 h-11 rounded-xl border flex items-center justify-center press-scale ${FOCUS} ${
                      checked ? 'border-gold bg-gold/10' : 'border-zinc-800 hover:border-zinc-600'
                    }`}
                  >
                    <Swatch color={swatchFor(config, c)} size="md" />
                  </button>
                );
              })}
              {colors.length === 0 && <span className="text-[12px] text-zinc-500">—</span>}
            </div>
            {color && (
              <p className="text-[12px] text-zinc-300">
                <span dir="ltr">{material}</span> · {nameOf(colorNameOf(config, color), lang, color)}
              </p>
            )}
          </div>

          {sizes.length > 0 && (
            <div className="space-y-2">
              <p className={SPEC}>{s.sizeLabel}</p>
              <Segmented
                group="farm-spool-size"
                label={s.sizeLabel}
                value={String(size)}
                onChange={(id) => setSize(Number(id))}
                dataAttr="data-farm-spool-size"
                items={sizes.map((g) => ({
                  id: String(g),
                  label: (
                    <span className="tabular-nums" dir="ltr">
                      {s.spoolSize(g)}
                    </span>
                  ),
                  accent: { indicator: 'bg-gold/10 border-gold/40', text: 'text-gold' },
                }))}
              />
            </div>
          )}

          <dl className="grid grid-cols-2 gap-3 text-[12px] border-t border-zinc-800/70 pt-3">
            <div>
              <dt className="text-zinc-500">{s.price}</dt>
              <dd className="text-gold font-black tabular-nums text-[16px]" dir="ltr">
                {formatCoins(price, lang)}
              </dd>
              {matDef && <dd className="text-zinc-500 tabular-nums text-[11px]">{s.pricePerGram(String(matDef.price_per_gram))}</dd>}
            </div>
            <div>
              <dt className="text-zinc-500">{s.inventory}</dt>
              <dd className={`tabular-nums ${storageOk ? 'text-zinc-200' : 'text-honey'}`}>{s.storageLeft(storageFree, storageTotal)}</dd>
            </div>
          </dl>

          {!storageOk && <p className="text-[11px] text-honey">{s.storageFull}</p>}
          {matDef && price > coins && <p className="text-[11px] text-honey">{s.notEnoughCoins}</p>}

          <button
            ref={filamentBtn}
            type="button"
            disabled={!canBuyFilament}
            onClick={() => setConfirmFilament(true)}
            className={`${BTN_PRIMARY} w-full`}
            data-farm-action="buy-filament"
          >
            {s.buy}
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------- printers */}
      <section className="space-y-3" aria-labelledby="farm-catalog-title" ref={catalogRef}>
        <SectionTitle
          id="farm-catalog-title"
          title={s.catalog}
          count={
            <span dir="ltr">
              {state.printers.length}/{state.profile.location.max_printers}
            </span>
          }
        />
        {freeSlots <= 0 && <p className="text-[12px] text-honey">{s.noFreeSlot}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {catalog.map(({ key, model }) => {
            const locked = model.min_level > level;
            const affordable = model.price <= coins;
            const have = owned.get(key) ?? 0;
            const disabled = locked || freeSlots <= 0 || !affordable || busy !== null;
            return (
              <article key={key} className={`${PANEL} p-4 space-y-3 ${locked ? 'opacity-80' : ''}`} data-farm-model={key} data-farm-model-locked={locked || undefined}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-white font-bold text-[14px] truncate" dir="ltr">
                      {nameOf(model.name, lang, key)}
                    </h3>
                    <p className="text-[11px] text-zinc-500">
                      {s.family(model.family)}
                      {have > 0 && <span className="text-zinc-400"> · {s.owned(have)}</span>}
                    </p>
                  </div>
                  {locked ? (
                    <Chip className="border-zinc-700 text-zinc-400 bg-zinc-800/60">
                      <Lock aria-hidden="true" className="w-3 h-3" />
                      {s.lockedLevel(model.min_level)}
                    </Chip>
                  ) : (
                    <Chip className="border-gold/40 text-gold bg-gold/10 text-[12px]">
                      <span dir="ltr">{formatCoins(model.price, lang)}</span>
                    </Chip>
                  )}
                </div>
                {/* The volume and the materials list run past a 90px column at
                    360px: they wrap to a second line (never "180×180×…"), and
                    reserve it so every card in the grid stays the same height. */}
                <div className="grid grid-cols-3 gap-x-3 gap-y-2 border-t border-zinc-800/70 pt-3">
                  <Spec label={s.specSpeed} value={`${formatInt(model.speed, lang)} mm/s`} />
                  <Spec label={s.specVolume} value={formatVolume(model.volume_mm)} wrap />
                  <Spec label={s.specPower} value={`${formatInt(model.watts, lang)} W`} />
                  <Spec label={s.specReliability} value={formatPercent(model.reliability, lang)} />
                  <Spec label={s.specAms} value={model.ams ? s.yes : s.no} ltr={false} />
                  <Spec label={s.specMaterials} value={model.materials.join(' ')} wrap />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-zinc-500">
                    {locked ? s.lockedLevel(model.min_level) : freeSlots <= 0 ? s.noFreeSlot : !affordable ? s.notEnoughCoins : ''}
                  </span>
                  <button
                    ref={(el) => {
                      modelBtns.current.set(key, el);
                    }}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      modelAnchor.current = modelBtns.current.get(key) ?? null;
                      setConfirmModel(key);
                    }}
                    className={BTN_PRIMARY}
                    data-farm-action="buy-printer"
                  >
                    {s.buy}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* -------------------------------------------------------- confirmations */}
      <Window open={confirmFilament} onClose={() => setConfirmFilament(false)} label={s.buyFilamentTitle} labelledBy={filamentTitleId} busy={busy !== null} anchor={filamentBtn} testId="farm-buy-filament">
        <div className={WINDOW_BODY}>
          <h3 id={filamentTitleId} className="text-white font-bold text-[16px]">
            {s.buyFilamentTitle}
          </h3>
          <p className="text-[13px] text-zinc-300 leading-relaxed">
            {s.buyFilamentBody(material, nameOf(colorNameOf(config, color), lang, color), size, formatCoins(price, lang))}
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" disabled={busy !== null} onClick={() => setConfirmFilament(false)} className={BTN_SECONDARY}>
              {s.cancel}
            </button>
            <button
              type="button"
              disabled={!canBuyFilament}
              onClick={async () => {
                const ok = await act(`buy-filament:${material}:${color}:${size}`, (k) => farmApi.buyFilament(material, color, size, k));
                if (ok) setConfirmFilament(false);
              }}
              className={BTN_PRIMARY}
            >
              {s.buy}
            </button>
          </div>
        </div>
      </Window>

      <Window open={confirmModel !== null} onClose={() => setConfirmModel(null)} label={s.buyPrinterTitle} labelledBy={printerTitleId} busy={busy !== null} anchor={modelAnchor} testId="farm-buy-printer">
        <div className={WINDOW_BODY}>
          <h3 id={printerTitleId} className="text-white font-bold text-[16px]">
            {s.buyPrinterTitle}
          </h3>
          {confirmModelDef && (
            <p className="text-[13px] text-zinc-300 leading-relaxed">
              {s.buyPrinterBody(nameOf(confirmModelDef.name, lang, confirmModel ?? ''), formatCoins(confirmModelDef.price, lang))}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" disabled={busy !== null} onClick={() => setConfirmModel(null)} className={BTN_SECONDARY}>
              {s.cancel}
            </button>
            <button
              type="button"
              disabled={busy !== null || !confirmModel}
              onClick={async () => {
                if (!confirmModel) return;
                const ok = await act(`buy-printer:${confirmModel}`, (k) => farmApi.buyPrinter(confirmModel, k));
                if (ok) setConfirmModel(null);
              }}
              className={BTN_PRIMARY}
            >
              {s.buy}
            </button>
          </div>
        </div>
      </Window>
    </div>
  );
}
