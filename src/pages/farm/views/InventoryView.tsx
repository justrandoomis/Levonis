/**
 * INVENTORY — spools as coloured cards with a grams bar, the printers owned,
 * and the way into the coin ledger.
 */
import React, { useRef, useState } from 'react';
import { Boxes, History } from 'lucide-react';
import { EmptyState } from '../../../components/ui/AsyncStates';
import { colorNameOf, printerModel, type FarmState } from '../../../lib/farmApi';
import type { FarmStrings } from '../strings';
import { formatCoins, formatHours, formatInt, nameOf, printerName, printerStateLabel, swatchFor } from '../format';
import { Chip, CoinsChip, ProgressBar, SectionTitle } from '../bits';
import { BTN_SECONDARY, PANEL, ROW, STATE_CHIP } from '../ui';
import LedgerSheet from '../sheets/LedgerSheet';

export interface InventoryViewProps {
  state: FarmState;
  lang: string;
  s: FarmStrings;
}

export default function InventoryView({ state, lang, s }: InventoryViewProps) {
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const ledgerBtn = useRef<HTMLButtonElement | null>(null);
  const storageTotal = state.profile.location.storage_grams;
  const storageUsed = state.spools.reduce((n, sp) => n + sp.grams_left, 0);
  const printers = [...state.printers].sort((a, b) => a.slot - b.slot);

  return (
    <div className="space-y-6">
      <section className={`${PANEL} p-4 flex items-center justify-between gap-3`}>
        <div className="min-w-0">
          <p className="text-[11px] text-zinc-500">{s.coins}</p>
          <CoinsChip coins={state.profile.coins} lang={lang} s={s} size="lg" className="mt-1" />
        </div>
        <button ref={ledgerBtn} type="button" onClick={() => setLedgerOpen(true)} className={BTN_SECONDARY} data-farm-action="ledger">
          <History aria-hidden="true" className="w-4 h-4" />
          {s.viewLedger}
        </button>
      </section>

      <section className="space-y-3" aria-labelledby="farm-spools-title">
        <SectionTitle
          id="farm-spools-title"
          title={s.spools}
          count={
            <span dir="ltr">
              {formatInt(storageUsed, lang)} / {formatInt(storageTotal, lang)} g
            </span>
          }
        />
        {state.spools.length === 0 ? (
          <EmptyState compact icon={<Boxes aria-hidden="true" className="w-6 h-6" />} title={s.noSpools} description={s.noSpoolsDesc} />
        ) : (
          <div className="grid gap-3 grid-cols-2">
            {state.spools.map((sp) => {
              const swatch = swatchFor(state.config, sp.color);
              const frac = sp.grams_total > 0 ? sp.grams_left / sp.grams_total : 0;
              return (
                <article key={sp.id} className={`${PANEL} p-3 space-y-2 border-s-2`} style={{ borderInlineStartColor: swatch }} data-farm-spool={sp.id}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span aria-hidden="true" className="w-6 h-6 rounded-full border border-white/15 shrink-0" style={{ backgroundColor: swatch }} />
                    <div className="min-w-0">
                      <p className="text-white font-bold text-[13px] truncate" dir="ltr">
                        {sp.material}
                      </p>
                      <p className="text-[11px] text-zinc-400 truncate">{nameOf(colorNameOf(state.config, sp.color), lang, sp.color)}</p>
                    </div>
                  </div>
                  <ProgressBar fraction={frac} tone={frac < 0.15 ? 'warn' : 'gold'} label={s.gramsLeft(sp.grams_left)} />
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className="text-zinc-200 font-bold tabular-nums" dir="ltr">
                      {formatInt(sp.grams_left, lang)} / {formatInt(sp.grams_total, lang)} g
                    </span>
                    <span className="text-zinc-500 tabular-nums">{s.spoolQuality(sp.quality)}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="farm-inv-printers-title">
        <SectionTitle id="farm-inv-printers-title" title={s.printersOwned} count={printers.length} />
        <div className="space-y-2">
          {printers.map((p) => {
            const model = printerModel(state.config, p.model_key);
            return (
              <div key={p.id} className={`${ROW} px-3 py-2.5 flex items-center gap-3`}>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-white font-bold truncate">{printerName(p, state.config, lang)}</p>
                  <p className="text-[11px] text-zinc-500 truncate" dir="ltr">
                    {nameOf(model?.name, lang, p.model_key)} · {formatHours(p.hours, lang)} · {formatInt(p.prints, lang)} {s.prints.toLowerCase()} · {formatInt(p.failures, lang)}{' '}
                    {s.failures.toLowerCase()}
                  </p>
                </div>
                <Chip className={STATE_CHIP[p.state] ?? STATE_CHIP.idle}>{printerStateLabel(p.state, s)}</Chip>
              </div>
            );
          })}
          {printers.length === 0 && <p className="text-[13px] text-zinc-500">{s.noPrinters}</p>}
        </div>
      </section>

      <LedgerSheet open={ledgerOpen} onClose={() => setLedgerOpen(false)} anchor={ledgerBtn} lang={lang} s={s} currentCoins={formatCoins(state.profile.coins, lang)} />
    </div>
  );
}
