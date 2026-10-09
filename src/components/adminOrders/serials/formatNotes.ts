/**
 * WHAT A SERIAL'S FORMAT RULE SAID, IN THE READER'S LANGUAGE (owner decision
 * 2, 2026-10-09; migration 0181). The server judges every serial by the rule
 * of its product — the product's own, else its brand's, else the generic
 * rule (worker/lib/serialRules.ts) — and sends its notes as codes
 * (packages/catalog/src/serialRules.ts `FormatNote`). These are the
 * sentences, in Arabic, English and Sorani (./strings.ts `formatNotes`),
 * shared by the order screen, the camera sheet, the inventory panel and the
 * owner's «صيغ الأرقام التسلسلية» screen. A warning is amber: the serial WAS
 * accepted.
 */
import type { Language } from '../../../translations';
import { serialStrings } from './strings';

export interface FormatNoteWire {
  code: string;
  len?: number;
  expected?: string;
  at?: number;
}

/** The `format` block of a link answer: which rule judged the serial, and its warnings. */
export interface LinkFormatWire {
  rule_id: string;
  rule_version: number;
  warnings: FormatNoteWire[];
}

/** One note as a sentence. A code this build does not know reads as the heading, never as a bare identifier. */
export function formatNoteText(note: FormatNoteWire, lang: Language | string): string {
  const s = serialStrings(lang);
  const n = s.formatNotes;
  switch (note.code) {
    case 'LENGTH_UNEXPECTED':
      return n.LENGTH_UNEXPECTED(Number(note.len) || 0, String(note.expected ?? ''));
    case 'POSITION_UNEXPECTED':
      return n.POSITION_UNEXPECTED(Number(note.at) || 0);
    case 'LOOKS_LIKE_BAMBU_BOX':
    case 'PREFIX_UNKNOWN':
    case 'CHARS_UNEXPECTED':
    case 'LOOKS_LIKE_BOX':
      return n[note.code];
    default:
      return s.formatTitle;
  }
}

/** Every note as a sentence, repeats folded. */
export function formatNoteTexts(notes: ReadonlyArray<FormatNoteWire> | null | undefined, lang: Language | string): string[] {
  return [...new Set((notes ?? []).map((n) => formatNoteText(n, lang)))];
}

/** Whether a link answer carries format warnings — they keep the camera sheet open until «تم», like any warning. */
export const hasFormatNotes = (res: { format?: LinkFormatWire | null }): boolean => !!res.format?.warnings?.length;
