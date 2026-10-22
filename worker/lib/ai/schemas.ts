/**
 * THE JSON SCHEMAS A MODEL ANSWERS IN (push B plan §7).
 *
 * Built at runtime from push A's closed sets (the routable intents, printer
 * aliases, part and symptom keys, photo subjects), so a new printer or
 * symptom in push A reaches the schema with no edit here. Deliberately
 * small: only `type`, `enum`, `pattern`, `required`, `items` and
 * `additionalProperties: false`. No `anyOf`, no `null` (a `"none"` sentinel
 * instead), no recursion, no length or count keywords: lengths and counts are
 * enforced locally by the validators (worker/lib/assist/ai), which are the
 * real gate. A schema only shapes what the provider returns.
 *
 * `conformsTo` checks a value against these schemas (the same subset), for
 * the admin Test's `valid` flag; it is not a general JSON Schema validator.
 */
import { PART_KEYS, SYMPTOM_KEYS } from '../assist/types';
import { PHOTO_SUBJECTS, READING_ACTIONS, READING_OUTCOMES, ROUTABLE_INTENTS } from '../assist/ai/adapter';
import { MODEL_ALIASES } from '../assist/ai/aliases';

export const HMS_PATTERN = '^[0-9A-Fa-f]{4}(-[0-9A-Fa-f]{4}){1,3}$';
export const LABEL_PATTERN = '^[A-Za-z0-9][A-Za-z0-9-]{2,31}$';

const str = (values: readonly string[]) => ({ type: 'string', enum: [...values] });

export const READING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'intent', 'printer', 'part', 'symptom', 'outcome', 'maintenance', 'terms'],
  properties: {
    action: str(READING_ACTIONS),
    intent: str([...ROUTABLE_INTENTS, 'none']),
    printer: str([...MODEL_ALIASES, 'other', 'none']),
    part: str([...PART_KEYS, 'none']),
    symptom: str([...SYMPTOM_KEYS, 'none']),
    outcome: str([...READING_OUTCOMES, 'none']),
    maintenance: { type: 'boolean' },
    terms: { type: 'array', items: { type: 'string' } },
  },
});

export const PHOTO_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'printer', 'symptom', 'part', 'hms_codes', 'label_codes', 'confidence'],
  properties: {
    subject: str(PHOTO_SUBJECTS),
    printer: str([...MODEL_ALIASES, 'none']),
    symptom: str([...SYMPTOM_KEYS, 'none']),
    part: str([...PART_KEYS, 'none']),
    hms_codes: { type: 'array', items: { type: 'string', pattern: HMS_PATTERN } },
    label_codes: { type: 'array', items: { type: 'string', pattern: LABEL_PATTERN } },
    confidence: str(['high', 'low']),
  },
});

type Node = {
  type?: string;
  enum?: string[];
  pattern?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Node>;
  items?: Node;
};

/** Does `value` have exactly the shape `schema` (this file's subset) describes? */
export function conformsTo(schema: object, value: unknown): boolean {
  const n = schema as Node;
  switch (n.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const o = value as Record<string, unknown>;
      const props = n.properties ?? {};
      const keys = Object.keys(o);
      if (n.additionalProperties === false && keys.some((k) => !(k in props))) return false;
      if ((n.required ?? []).some((k) => !(k in o))) return false;
      return keys.every((k) => !(k in props) || conformsTo(props[k]!, o[k]));
    }
    case 'array':
      return Array.isArray(value) && (!n.items || value.every((v) => conformsTo(n.items!, v)));
    case 'string':
      if (typeof value !== 'string') return false;
      if (n.enum && !n.enum.includes(value)) return false;
      if (n.pattern && !new RegExp(n.pattern).test(value)) return false;
      return true;
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}
