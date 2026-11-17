/**
 * THE HEAD OF A REQUEST PAGE (community UI plan C3, IMG_8472, IMG_8479): one
 * card holding the thumbnail, the title, the state pill, the meta line and,
 * under a hairline, the files at a glance (./AttachmentsPreview.tsx).
 *
 *   thumbnail  the first picture of the owner; anybody else, and an owner with no
 *              picture, sees the neutral glyph (plan R3: no request picture
 *              is public)
 *   pill       «بانتظار الاختيار» in gold for the owner while offers wait on
 *              the choice, otherwise the state in the words of the cards
 *              (./requestWords.ts)
 *   meta       «4 قطع · PETG · أسود · بغداد», each part in its own isolate,
 *              so a Latin material never turns an Arabic line around
 */
import React from 'react';
import { Box, FileText } from 'lucide-react';
import { GOVERNORATE_LABELS } from '../../../lib/governorates';
import { StatePill } from '../kit/display';
import type { RequestFile } from '../../media/RequestAttachments';
import AttachmentsPreview from './AttachmentsPreview';
import { RequestThumb, pictureFiles } from './RequestFileThumbs';
import { localColour, localMaterial } from './mirrors';
import { piecesWord, requestGlyph, requestStateWord, type CardLang } from './requestWords';
import type { RequestStrings } from './strings';

export interface RequestHeaderCardProps {
  request: { title: string; state: string; quantity: number; material: string; color: string; governorate: string; file_count?: number };
  files: RequestFile[];
  isOwner: boolean;
  /** Offers that wait on the owner choice: with one, the owner pill says «بانتظار الاختيار». */
  waitingOffers: number;
  /** Pieces in a set of a job of parts (P1-05), 1 for a single part. */
  piecesPerSet?: number;
  lang: CardLang;
  s: RequestStrings;
  onOpenFiles: () => void;
  /** The owner may add files while the request takes offers: with none yet, the door to the list stays. */
  canAddFiles?: boolean;
  /** The technical review chip and other marks, under the meta line. */
  children?: React.ReactNode;
}

export default function RequestHeaderCard({ request: r, files, isOwner, waitingOffers, piecesPerSet = 1, lang, s, onOpenFiles, canAddFiles = false, children }: RequestHeaderCardProps) {
  const cover = isOwner ? pictureFiles(files)[0]?.url ?? null : null;
  const glyph = requestGlyph({ file_count: files.length || r.file_count, material: r.material });
  const Glyph = glyph === 'text' ? FileText : Box;
  const state = requestStateWord(r.state, lang, { owner: isOwner, offers: waitingOffers });
  const pieces = piecesWord(Math.max(1, r.quantity || 1) * Math.max(1, piecesPerSet), lang);
  const gov = r.governorate ? GOVERNORATE_LABELS[r.governorate]?.[lang] ?? '' : '';
  const meta = [pieces, localMaterial(r.material, lang), r.color ? localColour(r.color, lang) : '', gov].filter(Boolean);
  return (
    <section data-request-section="header" className="cm-card rounded-xl p-3 shadow-sm" aria-labelledby="request-title">
      <div className="flex items-center gap-3">
        {cover ? (
          <RequestThumb url={cover} size={96} className="cm-line rounded-md" />
        ) : (
          <span aria-hidden="true" data-request-glyph={glyph} className="cm-line flex size-24 shrink-0 items-center justify-center rounded-md bg-surface-selected text-text-secondary">
            <Glyph className="h-8 w-8" strokeWidth={1.5} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* The words of the customer keep their own direction: an Arabic «80×60 ملم» read in the English interface must not come out as 60×80. */}
          <h2 id="request-title" dir="auto" className="break-words text-start text-[19px] font-bold leading-snug text-text-primary">
            {r.title}
          </h2>
          <StatePill tone={state.tone} className="mt-1.5">
            {state.word}
          </StatePill>
          <p className="mt-1.5 break-words text-[13px] leading-snug text-text-secondary" data-request-meta>
            {meta.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span aria-hidden="true">{' · '}</span>}
                <bdi>{part}</bdi>
              </React.Fragment>
            ))}
          </p>
          {children}
        </div>
      </div>
      {(files.length > 0 || canAddFiles) && (
        <div className="mt-3 border-t border-border-subtle pt-3">
          <AttachmentsPreview files={files} lang={lang} s={s} onOpenAll={onOpenFiles} />
        </div>
      )}
    </section>
  );
}
