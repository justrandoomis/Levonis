/**
 * MORE — the one sheet behind the More tile (survey S2): exactly the rows the
 * engine compiled (`plan.more`, in its order), each pushing its page inside
 * the same sheet («‹ More» back; never a second sheet), then «Surprise me».
 * Sheet v2 with two detents on a phone, a centred window from `sm`. Escape
 * and the scrim close only this sheet, and focus returns to the More tile.
 *
 * Lazy (its own chunk): the sheet's gesture code is not part of the studio's
 * first paint. `data-sheet` = the page shown, `data-more-row` = each row.
 */
import { useId, useState } from 'react';
import * as Motion from 'motion/react-m';
import { ChevronLeft, ChevronRight, Dices } from 'lucide-react';
import type { MorePage, SurfaceItem } from '../../../packages/catalog/src/personalize/types';
import { LOOKS, LOOK_WORDS, TIERS, TIER_WORDS, word } from '../../../packages/catalog/src/personalize/vocab';
import { Sheet } from '../ui/Sheet';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';
import { FinishChoices, TierChoices } from './LookPanel';
import { NamePanel } from './NamePanel';
import { AddonsPage } from './pages';
import { IconPicker, ImagePage, NotesPage, TargetPage } from './extras';
import { axisOf, type Kit } from './useStudio';

export interface MoreSheetProps {
  k: Kit;
  open: boolean;
  onClose: () => void;
  /** A page to open at once (the verdict line's «Fix it» on a More page). */
  start?: SurfaceItem<MorePage> | null;
  onAsk: () => void;
  onSurprise: () => void;
}

const rowKey = (r: SurfaceItem<MorePage>) => (r.ref ? `${r.id}:${r.ref}` : r.id);

export default function MoreSheet({ k, open, onClose, start, onAsk, onSurprise }: MoreSheetProps) {
  const { pub, state, derived, t, lang } = k;
  const m = useMotion();
  const { dir } = useLanguage();
  const titleId = useId();
  const [page, setPage] = useState<SurfaceItem<MorePage> | null>(start ?? null);
  const rows = derived.plan.more;
  const title = (r: SurfaceItem<MorePage>): string => {
    const area = r.ref ? pub.areas.find((a) => a.id === r.ref) : undefined;
    switch (r.id) {
      case 'look': return t.look;
      case 'tier': return t.tier;
      case 'text': return area?.role === 'name' ? t.tiles.name : t.tiles.text;
      case 'nfc': return t.nfc;
      case 'notes': return t.notes;
      case 'ask': return t.ask;
      default: return t.tiles[r.id];
    }
  };
  const valueOf = (r: SurfaceItem<MorePage>): string => {
    if (r.id === 'look') {
      const v = axisOf(pub, state.config, 'look');
      return v ? word(LOOK_WORDS, LOOKS, pub.axes.look!.values[v].look, lang) : '';
    }
    if (r.id === 'tier') {
      const v = axisOf(pub, state.config, 'tier');
      return v ? word(TIER_WORDS, TIERS, pub.axes.tier!.values[v].tier, lang) : '';
    }
    if (r.id === 'text' && r.ref) return state.config.texts[r.ref]?.value.join(' + ') ?? '';
    if ((r.id === 'photo' || r.id === 'logo') && r.ref) return state.config[r.id][r.ref] ? t.added : '';
    if (r.id === 'qr' && r.ref) return state.config.qr[r.ref] ? t.added : '';
    if (r.id === 'nfc') return state.config.nfc ? t.added : '';
    return '';
  };
  const body = (r: SurfaceItem<MorePage>) => {
    switch (r.id) {
      case 'look': return <FinishChoices k={k} />;
      case 'tier': return <TierChoices k={k} />;
      case 'text': return <NamePanel k={k} areaId={r.ref!} />;
      case 'photo':
      case 'logo': return <ImagePage k={k} areaId={r.ref!} />;
      case 'qr': return <TargetPage k={k} areaId={r.ref!} />;
      case 'icon': return <div className="px-3 py-3"><IconPicker k={k} areaId={r.ref!} /></div>;
      case 'nfc': return <TargetPage k={k} areaId="nfc" />;
      case 'addons': return <AddonsPage k={k} />;
      case 'notes': return <NotesPage k={k} />;
      default: return null;
    }
  };
  const Back = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Forward = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      panelClassName="w-full sm:max-w-lg"
      header={
        <div className="flex min-h-11 items-center gap-1 px-3 pb-1">
          {page ? (
            <button type="button" onClick={() => setPage(null)} className="lv-button lv-button-ghost lv-button-sm -ms-2" data-more-back>
              <Back aria-hidden="true" className="h-4 w-4" />
              {t.back}
            </button>
          ) : null}
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[16px] font-bold text-text-primary">
            {page ? title(page) : t.more}
          </h2>
        </div>
      }
    >
      <MotionFeatures>
        <Motion.div
          key={page ? rowKey(page) : 'more'}
          data-sheet={page ? page.id : 'more'}
          initial={{ opacity: 0, x: m.travel(m.inline(page ? 24 : -24)) }}
          animate={{ opacity: 1, x: 0 }}
          transition={m.spring('move')}
          className="pb-6"
        >
          {page ? (
            body(page)
          ) : (
            <ul className="divide-y divide-border-subtle px-3">
              {rows.map((r) => (
                <li key={rowKey(r)}>
                  <button
                    type="button"
                    data-more-row={r.ref ? `${r.id}:${r.ref}` : r.id}
                    onClick={() => (r.id === 'ask' ? onAsk() : setPage(r))}
                    className="flex min-h-12 w-full items-center gap-3 text-start"
                  >
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-text-primary">{title(r)}</span>
                    <span className="shrink-0 truncate text-[12.5px] text-text-muted">{valueOf(r)}</span>
                    {r.id !== 'ask' && <Forward aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />}
                  </button>
                </li>
              ))}
              <li>
                <button type="button" data-more-row="surprise" onClick={onSurprise} className="flex min-h-12 w-full items-center gap-3 text-start">
                  <Dices aria-hidden="true" className="h-4 w-4 shrink-0 text-gold" />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-text-primary">{t.surprise}</span>
                </button>
              </li>
            </ul>
          )}
        </Motion.div>
      </MotionFeatures>
    </Sheet>
  );
}
