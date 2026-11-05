/**
 * «أضف رابطًا» / «عدّل رابط المورّد» — ONE OF THE OWNER'S OWN SUPPLIER LINKS
 * (docs/SMART_PRICING.md §3.10; DECISIONS row 293).
 *
 * The address, checked as he types by the very parser the server runs
 * (packages/catalog/src/supplierPrices/ownerLink.ts), with the form it will be
 * saved in when that differs (a Tmall link without its tracking, an EU store
 * link with skr=yes); what it belongs to, chosen from the product's own list
 * (the whole product, a model or option, a colour, one exact SKU — the
 * purchase line's or the order line's preselected); an optional name, supplier
 * and note (a few lines, read by the server's own rule, `ownerLinkNote`).
 * Saved through `PUT /owner-links/:product_id`, fenced on the token
 * the panel read: a refusal is said beside its field, a stale screen reloads.
 * Saving writes no price and never makes a confirmed match.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { ApiError } from '../../lib/api';
import {
  OWNER_LINK_INPUT_MAX,
  OWNER_LINK_LABEL_MAX,
  OWNER_LINK_NOTE_MAX,
  OWNER_LINK_MAX,
  OWNER_LINKS_PER_PRODUCT,
  isOwnerLinkError,
  ownerLinkNote,
  ownerLinkUrl,
  type OwnerLinkError,
} from '../../../packages/catalog/src/supplierPrices/ownerLink';
import { saveOwnerLinks, type OwnerLink, type OwnerLinkChoice, type OwnerLinkChoiceKind } from './api';
import { ActNote, Ltr, SheetFrame, useAct, useUiLang } from './parts';
import { noteText } from './input';
import { COMMON, OWNER_LINKS, OWNER_LINK_ERROR_TEXT, say, type Tri, type UiLang } from './strings';
import { nameIn } from './format';

export interface OwnerLinkSheetTarget {
  /** The link edited, or null for a new one. */
  link: OwnerLink | null;
  /** The key a new link starts on: the stock row's, the order line's, or '' (the whole product). */
  comboKey: string;
}

/** The owner's words for a refused address. */
export function urlErrorText(reason: OwnerLinkError, lang: UiLang): string {
  return say(OWNER_LINK_ERROR_TEXT[reason], lang, { n: OWNER_LINK_MAX });
}

type Errors = Partial<Record<'url' | 'label' | 'supplier' | 'note', string>>;

/** A refusal of the server said beside its field (PRICING_INPUT_INVALID {field, reason}), or as the form's own words; null for any other. */
export function refusalOf(e: unknown, lang: UiLang): { errors: Errors; form: string | null } | null {
  if (!(e instanceof ApiError) || e.code !== 'PRICING_INPUT_INVALID') return null;
  const field = e.details?.field;
  const reason = e.details?.reason;
  if (field === 'url') return { errors: { url: reason === 'duplicate' ? say(OWNER_LINKS.duplicate, lang) : urlErrorText(isOwnerLinkError(reason) ? reason : 'not_url', lang) }, form: null };
  if (field === 'upsert' && reason === 'limit') return { errors: {}, form: say(OWNER_LINKS.limit, lang, { n: OWNER_LINKS_PER_PRODUCT }) };
  // The key was the product's when the panel read it, and is gone since (an option removed in between).
  if (field === 'combo_key') return { errors: {}, form: say(OWNER_LINKS.keyGone, lang) };
  const text = say(OWNER_LINKS.textInvalid, lang);
  if (field === 'label') return { errors: { label: text }, form: null };
  if (field === 'supplier_name') return { errors: { supplier: text }, form: null };
  if (field === 'note') return { errors: { note: text }, form: null };
  return null;
}

const KIND_LABEL: Readonly<Record<OwnerLinkChoiceKind, Tri>> = {
  product: OWNER_LINKS.kindProduct,
  option: OWNER_LINKS.kindOption,
  colour: OWNER_LINKS.kindColour,
  sku: OWNER_LINKS.kindSku,
};
const KINDS: readonly OwnerLinkChoiceKind[] = ['option', 'colour', 'sku'];

export default function OwnerLinkSheet({
  productId,
  version,
  choices,
  target,
  onClose,
  onSaved,
  onStale,
}: {
  productId: string;
  /** The `versions.links` token of the panel's latest read (a reload after a refusal brings the new one). */
  version: string;
  choices: readonly OwnerLinkChoice[];
  target: OwnerLinkSheetTarget | null;
  onClose: () => void;
  onSaved: () => void;
  onStale: () => void;
}) {
  const { lang, dir } = useUiLang();
  const act = useAct(lang, onStale);
  const [url, setUrl] = useState('');
  const [combo, setCombo] = useState('');
  const [label, setLabel] = useState('');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  // A new target starts the sheet over: the link's own values, or the line's key for a new one.
  const targetKey = target ? `${target.link?.id ?? 'new'}\u0000${target.link?.version ?? 0}\u0000${target.comboKey}` : '';
  useEffect(() => {
    if (!target) return;
    setUrl(target.link?.url ?? '');
    setCombo(target.link?.combo_key ?? target.comboKey);
    setLabel(target.link?.label ?? '');
    setSupplier(target.link?.supplier_name ?? '');
    setNote(target.link?.note ?? '');
    setErrors({});
    act.setMessage(null);
    // Keyed on the target's identity, not its object: `act.setMessage` is a state setter (stable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const read = useMemo(() => (url.trim() ? ownerLinkUrl(url) : null), [url]);
  // The form it will be saved in, when that is not what he typed.
  const rebuilt = read && !('error' in read) && read.url !== url.trim() ? read.url : null;
  const groups = useMemo(() => {
    const known = choices.some((c) => c.combo_key === combo) ? choices : [...choices, { combo_key: combo, kind: 'sku' as const, labels: target?.link?.labels ?? { ar: '', en: '', ckb: '' } }];
    return KINDS.map((k) => [k, known.filter((c) => c.kind === k && c.combo_key !== '')] as const).filter(([, list]) => list.length > 0);
  }, [choices, combo, target?.link?.labels]);

  if (!target) return null;
  const link = target.link;
  const dirty =
    url !== (link?.url ?? '') || combo !== (link?.combo_key ?? target.comboKey) || label !== (link?.label ?? '') || supplier !== (link?.supplier_name ?? '') || note !== (link?.note ?? '');

  const save = async () => {
    const address = ownerLinkUrl(url);
    const labelClean = noteText(label, OWNER_LINK_LABEL_MAX);
    const supplierClean = noteText(supplier, OWNER_LINK_LABEL_MAX);
    // The note's box takes a few lines: the shared rule keeps its line breaks, as the server does.
    const noteClean = ownerLinkNote(note);
    const next: Errors = {};
    if ('error' in address) next.url = urlErrorText(address.error, lang);
    if (labelClean === null) next.label = say(OWNER_LINKS.textInvalid, lang);
    if (supplierClean === null) next.supplier = say(OWNER_LINKS.textInvalid, lang);
    if (noteClean === null) next.note = say(OWNER_LINKS.textInvalid, lang);
    setErrors(next);
    if ('error' in address || labelClean === null || supplierClean === null || noteClean === null) return;
    await act.run(
      'save',
      () =>
        saveOwnerLinks(productId, {
          version,
          upsert: [{ ...(link ? { id: link.id } : {}), combo_key: combo, url: address.url, label: labelClean, supplier_name: supplierClean, note: noteClean }],
        }).catch((e: unknown) => {
          const said = refusalOf(e, lang);
          if (!said) throw e;
          return said;
        }),
      (answer) => {
        if ('errors' in answer) {
          setErrors(answer.errors);
          return answer.form ? { tone: 'danger', text: answer.form } : null;
        }
        onSaved();
        return null;
      }
    );
  };

  return (
    <SheetFrame
      open={!!target}
      onClose={onClose}
      title={say(link ? OWNER_LINKS.editTitle : OWNER_LINKS.addTitle, lang)}
      lang={lang}
      dir={dir}
      dirty={dirty}
      testId="owner-link-sheet"
      footer={
        <>
          <Button variant="primary" loading={act.busy === 'save'} onClick={() => void save()} data-owner-link-save>
            {say(OWNER_LINKS.save, lang)}
          </Button>
          <Button variant="ghost" disabled={act.busy === 'save'} onClick={onClose}>
            {say(COMMON.cancel, lang)}
          </Button>
        </>
      }
    >
      <p className="text-[12px] leading-relaxed text-text-secondary">{say(OWNER_LINKS.sheetNote, lang)}</p>
      <Field
        label={say(OWNER_LINKS.url, lang)}
        error={errors.url}
        hint={
          rebuilt ? (
            <span data-owner-link-rebuilt>
              {say(OWNER_LINKS.urlSaved, lang)} <Ltr className="break-all">{rebuilt}</Ltr>
            </span>
          ) : (
            say(OWNER_LINKS.urlHint, lang)
          )
        }
      >
        <Input
          ltr
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={OWNER_LINK_INPUT_MAX}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (errors.url) setErrors((x) => ({ ...x, url: undefined }));
          }}
          onBlur={() => {
            const r = url.trim() ? ownerLinkUrl(url) : null;
            if (r && 'error' in r) setErrors((x) => ({ ...x, url: urlErrorText(r.error, lang) }));
          }}
          data-owner-link-url
        />
      </Field>
      <Field label={say(OWNER_LINKS.appliesTo, lang)}>
        <Select value={combo} onChange={(e) => setCombo(e.target.value)} data-owner-link-key>
          <option value="">{say(KIND_LABEL.product, lang)}</option>
          {groups.map(([kind, list]) => (
            <optgroup key={kind} label={say(KIND_LABEL[kind], lang)}>
              {list.map((c) => (
                <option key={c.combo_key} value={c.combo_key}>
                  {nameIn(c.labels, lang, c.combo_key)}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <Field label={say(OWNER_LINKS.name, lang)} optional error={errors.label}>
        <Input dir="auto" maxLength={OWNER_LINK_LABEL_MAX} placeholder={say(OWNER_LINKS.namePlaceholder, lang)} value={label} onChange={(e) => setLabel(e.target.value)} data-owner-link-label />
      </Field>
      <Field label={say(OWNER_LINKS.supplier, lang)} optional error={errors.supplier}>
        <Input dir="auto" maxLength={OWNER_LINK_LABEL_MAX} value={supplier} onChange={(e) => setSupplier(e.target.value)} data-owner-link-supplier />
      </Field>
      <Field label={say(OWNER_LINKS.note, lang)} optional error={errors.note}>
        <Textarea dir="auto" rows={2} maxLength={OWNER_LINK_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-owner-link-note />
      </Field>
      <ActNote message={act.message} />
    </SheetFrame>
  );
}
