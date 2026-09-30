/**
 * STEP 2 · «الأجزاء» — every part of the merchant's file, with the name the
 * file gave it (merchant words), its share of the model and its role. A tap
 * on the model or on its row chooses it (every tap has this list as its
 * twin); the role is one of the engine's twelve, or «مخفي» (the publish
 * strips it from the public model). A role's colours are the customer's:
 * from the shelf, any, or a list — and the first one.
 */
import { REGION_ROLES, ROLE_WORDS, PAINT_KEYS, colorWord, word } from '../../../../../../packages/catalog/src/personalize/vocab';
import type { PaletteKey, Region, RegionRole } from '../../../../../../packages/catalog/src/personalize/types';
import { Segmented } from '../../../../ui/Segmented';
import { PART_ROLES, regionOfPart, setPartRole } from '../model';
import { PART_COLOURS } from '../Stage';
import type { Kit } from '../kit';

/** A row of colour swatches, one chosen (`value`) or many (`values`). */
export function Swatches({ keys, value, values, onPick, label, name }: { keys: readonly PaletteKey[]; value?: PaletteKey; values?: readonly PaletteKey[]; onPick: (k: PaletteKey) => void; label: string; name: (k: PaletteKey) => string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {keys.map((c) => (
        <button key={c} type="button" className="lv-choice flex h-11 w-11 items-center justify-center p-0" aria-pressed={value ? value === c : !!values?.includes(c)} aria-label={name(c)} title={name(c)} onClick={() => onPick(c)} data-swatch-pick={c}>
          <span className="lv-swatch text-[22px]" data-swatch={c} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** The colours a region offers: the shelf, all, or the merchant's list — and its first colour. */
export function PaintEditor({ k, paint, onPaint, fixed }: { k: Kit; paint: Region['paint']; onPaint: (p: Region['paint']) => void; fixed?: boolean }) {
  const { t, lang } = k;
  const mode = paint.allowed === 'stocked' || paint.allowed === 'all' ? paint.allowed : 'list';
  const list = Array.isArray(paint.allowed) ? paint.allowed : [];
  const named = (c: PaletteKey) => colorWord(c, lang);
  return (
    <div className="space-y-3">
      {!fixed && (
        <Segmented
          items={[
            { id: 'stocked', label: t.paintStocked },
            { id: 'all', label: t.paintAll },
            { id: 'list', label: t.paintList },
          ]}
          value={mode}
          onChange={(id) => onPaint({ ...paint, allowed: id === 'list' ? [paint.default] : (id as 'stocked' | 'all'), premium: undefined })}
          label={t.colours}
          group="paint-mode"
          size="sm"
        />
      )}
      {!fixed && mode === 'list' && (
        <Swatches
          keys={PAINT_KEYS}
          values={list}
          label={t.colours}
          name={named}
          onPick={(c) => {
            const next = list.includes(c) ? list.filter((x) => x !== c) : [...list, c];
            if (next.length) onPaint({ ...paint, allowed: next, default: next.includes(paint.default) ? paint.default : next[0], premium: undefined });
          }}
        />
      )}
      <div className="space-y-1.5">
        <p className="text-[12.5px] font-semibold text-text-secondary">{t.startsAs} · {named(paint.default)}</p>
        <Swatches keys={mode === 'list' && !fixed ? list : PAINT_KEYS} value={paint.default} label={t.startsAs} name={named} onPick={(c) => onPaint(fixed ? { allowed: [c], default: c } : { ...paint, default: c })} />
      </div>
    </div>
  );
}

export function Parts({ k }: { k: Kit }) {
  const { t, st, spec, lang } = k;
  const chosen = k.sel.part;
  const region = chosen === undefined ? undefined : regionOfPart(spec, chosen);
  const roleWord = (r: RegionRole) => word(ROLE_WORDS, REGION_ROLES, r, lang);
  if (!st.parts.length) return <p className="text-[13px] text-text-muted">{t.noParts}</p>;
  const setPaint = (id: string, paint: Region['paint']) => k.edit((s) => ({ ...s, regions: s.regions.map((r) => (r.id === id ? { ...r, paint } : r)) }));

  return (
    <div className="space-y-4" data-step-parts>
      <div>
        <p className="text-[13.5px] font-semibold text-text-primary">{t.partsLead}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{t.suggested}</p>
      </div>
      <ul className="divide-y divide-border-subtle overflow-hidden rounded-2xl border border-border-subtle" aria-label={t.stepParts}>
        {st.parts.map((p) => {
          const r = regionOfPart(spec, p.n);
          const i = r ? spec.regions.indexOf(r) : -1;
          return (
            <li key={p.n}>
              <button
                type="button"
                className={`flex min-h-[44px] w-full items-center gap-3 px-3 py-2 text-start ${chosen === p.n ? 'bg-surface-selected' : ''}`}
                aria-pressed={chosen === p.n}
                onClick={() => k.setSel({ part: p.n })}
                data-part={p.n}
                data-role={r?.role ?? 'hidden'}
              >
                <span className="lv-swatch text-[16px]" data-swatch={i >= 0 ? PART_COLOURS[i % PART_COLOURS.length] : undefined} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-text-primary"><bdi>{p.name}</bdi></span>
                  <span className="block text-[12px] text-text-muted">
                    {r ? roleWord(r.role) : t.roleHidden} · <span className="tabular-nums" dir="ltr">{Math.round(p.share * 1000) / 10}%</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {chosen !== undefined && (
        <section className="space-y-4 rounded-2xl border border-border-subtle p-3" data-part-editor={chosen}>
          <div className="space-y-2">
            <p className="text-[12.5px] font-semibold text-text-secondary">{t.roleLabel}</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {[...PART_ROLES, null].map((role) => (
                <button
                  key={role ?? 'hidden'}
                  type="button"
                  className="lv-choice px-2 text-[12.5px]"
                  aria-pressed={(region?.role ?? null) === role}
                  onClick={() => k.edit((s) => setPartRole(s, chosen, role))}
                  data-role-pick={role ?? 'hidden'}
                >
                  {role ? roleWord(role) : t.roleHidden}
                </button>
              ))}
            </div>
            {!region && <p className="text-[12px] text-text-muted">{t.hiddenHint}</p>}
          </div>
          {region && (
            <div className="space-y-2">
              <p className="text-[12.5px] font-semibold text-text-secondary">{region.role === 'fixed' ? t.fixedHint : t.colours}</p>
              <PaintEditor k={k} paint={region.paint} fixed={region.role === 'fixed'} onPaint={(p) => setPaint(region.id, p)} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
