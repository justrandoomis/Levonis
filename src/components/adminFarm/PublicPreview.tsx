/**
 * What the player receives. Read-only, from the server's own `public`
 * projection — the panel never decides which keys are public; it shows the
 * list the server sent and lets the admin open a section's JSON to see the
 * exact document a customer downloads from /api/farm/config.
 */
import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { Language } from '../../translations';
import { btnGhost } from '../adminProducts/form/formUi';
import { labelFor } from './labels';
import { orderedSections, privateKeys, sectionCount, type JsonObject } from './schema';
import type { FarmAdminStrings } from './strings';

export function PublicPreview({ config, pub, s, lang }: { config: JsonObject | null; pub: JsonObject | null; s: FarmAdminStrings; lang: Language }) {
  const [shown, setShown] = useState<string | null>(null);
  const sections = orderedSections(config);
  const hidden = new Set(privateKeys(config, pub));
  const publicSections = pub ? orderedSections(pub) : [];

  return (
    <section data-farm-public className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 sm:p-4">
      <h3 className="text-[14px] font-black text-white flex items-center gap-2">
        <Eye className="w-4 h-4 text-gold" aria-hidden="true" />
        {s.publicTitle}
      </h3>
      <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">{s.publicBody}</p>

      {!pub || publicSections.length === 0 ? (
        <p className="mt-3 text-[12px] text-zinc-500">{s.publicNone}</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2 text-[10.5px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-gold" aria-hidden="true" /> {s.publicLegendPublic}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-zinc-600" aria-hidden="true" /> {s.publicLegendPrivate}
            </span>
          </div>
          <ul className="mt-2 flex flex-wrap gap-1.5 min-w-0">
            {sections.map((k) => {
              const isPublic = !hidden.has(k);
              const count = sectionCount(isPublic ? pub[k] : config?.[k]);
              const lb = labelFor(k, lang);
              const open = shown === k;
              return (
                <li key={k} className="min-w-0">
                  <button
                    type="button"
                    disabled={!isPublic}
                    aria-pressed={isPublic ? open : undefined}
                    aria-label={`${lb.label}: ${isPublic ? s.publicLegendPublic : s.publicLegendPrivate}`}
                    data-farm-public-key={k}
                    data-farm-public-state={isPublic ? 'public' : 'private'}
                    onClick={() => setShown(open ? null : k)}
                    className={`inline-flex items-center gap-1.5 h-8 ps-2 pe-2.5 rounded-full border text-[12px] transition-colors disabled:cursor-default ${
                      isPublic
                        ? open
                          ? 'border-gold/60 bg-gold/15 text-white'
                          : 'border-gold/30 bg-gold/5 text-zinc-100 hover:bg-gold/10'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-500'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${isPublic ? 'bg-gold' : 'bg-zinc-600'}`} aria-hidden="true" />
                    <span className="font-mono" dir="ltr">
                      {k}
                    </span>
                    <span className="text-[10px] text-zinc-500 tabular-nums">
                      {count.catalog ? s.entriesCount(count.entries) : s.fieldsCount(count.entries)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown && pub[shown] !== undefined && (
            <div className="mt-3 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="font-mono text-[12px] text-zinc-300" dir="ltr">
                  {shown}
                </span>
                <button type="button" onClick={() => setShown(null)} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
                  <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                  {s.hideJson}
                </button>
              </div>
              <pre
                dir="ltr"
                data-farm-public-json={shown}
                className="text-[11px] leading-relaxed text-zinc-300 bg-zinc-950/70 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-80"
              >
                {JSON.stringify(pub[shown], null, 2)}
              </pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}
