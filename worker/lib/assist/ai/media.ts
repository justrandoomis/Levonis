/**
 * WHAT THE ASSISTANT SAYS AFTER READING A PHOTO, A CLIP OR A VOICE NOTE (push B
 * plan §6.4, §8; invariant I1). PURE: no I/O.
 *
 * Every sentence is a hand-written template (../strings.ts). What a model read
 * reaches the customer only as:
 *   - a code that passed push A's own reader (`canonicalHmsCode`), shown so
 *     the customer can compare it with the screen;
 *   - the curated label of a symptom or a part, or a printer token;
 *   - a count of frames;
 *   - storefront cards the identifier lane matched EXACTLY (the label code
 *     itself is never shown).
 *
 * NOTHING IS AUTO-SELECTED. Each candidate is a chip; a tap is an ordinary,
 * deterministic push A turn (`step: 'code' | 'symptom' | 'part' | 'printer'`)
 * that carries `via` so the ticket can say what was read and confirmed. A
 * chip names only what its sentence named: the printer of the photo rides on
 * no symptom or part chip, because the customer did not confirm it.
 */
import { tr } from '../strings';
import { symptomDef } from '../triage/symptoms';
import type { AssistCard, AssistChoice, AssistReply, Locale } from '../types';
import { PART_LABELS } from '../understand/lexicon';
import type { PhotoReading } from './adapter';
import { canonicalHmsCode } from './validate';

export type ReadSource = 'photo' | 'clip';
export type VoiceReplyKey = 'voice_unclear' | 'voice_unavailable' | 'voice_ckb' | 'voice_too_long';

/** The reply intent every attachment read answers with. */
export const READ_INTENT = 'attachment_read';
export const LABEL_CARDS_MAX = 6;

const notThis = (loc: Locale): AssistChoice => ({ label: tr(loc, 'chip_not_this'), intent: 'menu' });

/**
 * The reply to a photo or a clip, from a VALIDATED reading (../ai/validate.ts
 * `readPhotoReading`). The first rule that matches wins (plan §8): one code,
 * several codes, an exact label match, a symptom, a part, a printer, nothing.
 */
export function photoReply(loc: Locale, r: PhotoReading, labelCards: AssistCard[], source: ReadSource, frames?: number): AssistReply {
  const via = source;
  // A clip's reply says first that only its frames were looked at, never its sound.
  const say = (key: string, vars: Record<string, string | number> = {}) =>
    source === 'clip' ? `${tr(loc, 'video_frames_note', { count: frames ?? 0 })} ${tr(loc, key, vars)}` : tr(loc, key, vars);
  const codes = r.hmsCodes.map(canonicalHmsCode).filter((c): c is string => !!c);

  if (codes.length === 1) {
    const code = codes[0];
    return {
      intent: READ_INTENT,
      text: say('photo_code_one', { code }),
      choices: [{ label: tr(loc, 'chip_code_yes'), intent: 'printer_problem', params: { step: 'code', code, via } }, notThis(loc)],
    };
  }
  if (codes.length > 1) {
    return {
      intent: READ_INTENT,
      text: say('photo_code_many'),
      // Each chip is labelled with the code itself, in the canonical form push A's reader gave.
      choices: [...codes.map((code): AssistChoice => ({ label: code, intent: 'printer_problem', params: { step: 'code', code, via } })), notThis(loc)],
    };
  }
  if (labelCards.length) {
    return { intent: READ_INTENT, text: say('photo_label_match'), cards: labelCards.slice(0, LABEL_CARDS_MAX) };
  }
  if (r.symptom) {
    const symptom = r.symptom;
    return {
      intent: READ_INTENT,
      text: say('photo_symptom', { symptom: symptomDef(symptom).label[loc] }),
      choices: [{ label: tr(loc, 'chip_yes'), intent: 'printer_problem', params: { step: 'symptom', symptom, via } }, notThis(loc)],
    };
  }
  if (r.part) {
    const part = r.part;
    return {
      intent: READ_INTENT,
      text: say('photo_part', { part: PART_LABELS[part][loc] }),
      choices: [{ label: tr(loc, 'chip_yes'), intent: 'printer_problem', params: { step: 'part', part, via } }, notThis(loc)],
    };
  }
  if (r.model && r.confidence === 'high') {
    const model = r.model;
    return {
      intent: READ_INTENT,
      text: say('photo_printer', { printer: model }),
      choices: [{ label: tr(loc, 'chip_yes'), intent: 'printer_problem', params: { step: 'printer', model, via } }, notThis(loc)],
    };
  }
  return { intent: READ_INTENT, text: say('photo_unclear') };
}

/** Nothing was read: the picture failed its checks, or the reading was not one. */
export function photoUnclear(loc: Locale, source: ReadSource, frames?: number): AssistReply {
  return photoReply(loc, { subject: 'unclear', hmsCodes: [], labelCodes: [], confidence: 'low' }, [], source, frames);
}

/** Reading is not available now (switched off, the cap, a limit, the provider): the attachment stays attached. */
export function photoUnavailable(loc: Locale, source: ReadSource): AssistReply {
  return { intent: READ_INTENT, text: tr(loc, source === 'clip' ? 'clip_unavailable' : 'photo_unavailable') };
}

/** The only replies the voice path has: the transcript itself is never one (I1). */
export function voiceReply(loc: Locale, key: VoiceReplyKey): AssistReply {
  return { intent: READ_INTENT, text: tr(loc, key) };
}
