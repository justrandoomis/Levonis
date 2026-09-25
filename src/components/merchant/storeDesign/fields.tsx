/**
 * ONE CONTROL PER SETTING TYPE, chosen by the schema — the block inspector
 * draws a block's form by walking `BLOCKS[type].settings` and handing each
 * `FieldSpec` to `SettingControl` here. So the form can only ever offer what
 * the registry declares, in the declared shape and within the declared
 * bounds: a `text` is three hand-written languages capped at `max`, an `enum`
 * is its values and nothing else, an `int` its range, a `media` a key from the
 * picker, a `link` one of the typed link kinds, a `ref` a row from the
 * merchant's own list.
 *
 * Each control reports issues from the SAME `normalizeLayout` the server runs
 * (editorModel.validateLayout), next to itself: fatal ones as errors (the
 * draft is not saved while one stands), the rest as notes of what the gate
 * will clean.
 */
import { useId, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Film, ImageIcon, Plus, Trash2, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Field, Input, Select, Textarea } from '../../ui/Field';
import { Switch, Checkbox } from '../../ui/Switch';
import { Segmented } from '../../ui/Segmented';
import { NumberInput } from '../../ui/NumberInput';
import { Button, IconButton } from '../../ui/Button';
import type { BlockType, FieldSpec, RefKind } from '../../../../packages/storeLayout/src/blocks';
import { LINK_ROUTES, SOCIAL_PROVIDER_NAMES, safeExternalUrl, type LinkTarget, type MediaKind, type SocialItem, type SocialProviderName } from '../../../../packages/storeLayout/src/refs';
import type { LocalizedText } from '../../../../packages/storeLayout/src/text';
import { fieldCopy, ISSUE_COPY, ROUTE_COPY, say, SOCIAL_COPY, VALUE_COPY, type Loc } from './catalog';
import type { FieldIssue } from './editorModel';
import { MediaPicker, MediaThumb, RefPicker, useRefName } from './pickers';

type ScalarSpec = Exclude<FieldSpec, { t: 'list' }>;

export interface ControlProps {
  blockType: BlockType;
  /** The setting's key in the block (or in a list item). */
  name: string;
  spec: FieldSpec;
  value: unknown;
  /** `key` coalesces keystrokes into one undo step. */
  onChange: (value: unknown, key?: string) => void;
  /** Issues whose field is this setting or under it. */
  issues: FieldIssue[];
  /** A stable id prefix for coalescing (the block id + path). */
  path: string;
}

// ----------------------------------------------------------------- issues

function issueWords(issues: FieldIssue[], loc: Loc, fatal: boolean): string {
  const codes = [...new Set(issues.filter((i) => i.fatal === fatal).map((i) => (i.field === 'collection_id' && i.code === 'invalid_value' ? 'pick_collection' : i.code)))];
  return codes
    .map((c) =>
      c === 'pick_collection'
        ? loc('اختر مجموعة — حتى تختارها تعرض القائمة أحدث المنتجات.', 'Choose a collection — until you do, the list shows the latest products.')
        : say(loc, ISSUE_COPY[c], c)
    )
    .join(' ');
}

function useLabel(blockType: BlockType, name: string) {
  const { loc } = useLanguage();
  const copy = fieldCopy(blockType, name);
  return { label: say(loc, copy?.label, name), hint: copy?.hint ? say(loc, copy.hint) : undefined };
}

/** A setting's frame: its label, its note, its error — then the control. */
function Frame({ blockType, name, issues, children, hintExtra }: { blockType: BlockType; name: string; issues: FieldIssue[]; children: ReactNode; hintExtra?: ReactNode }) {
  const { loc } = useLanguage();
  const { label, hint } = useLabel(blockType, name);
  const error = issueWords(issues, loc, true);
  const note = issueWords(issues, loc, false);
  return (
    <Field
      label={label}
      error={error || undefined}
      hint={
        hint || note || hintExtra ? (
          <>
            {hint}
            {note && <span className="block text-warning/90">{note}</span>}
            {hintExtra}
          </>
        ) : undefined
      }
    >
      {children}
    </Field>
  );
}

// --------------------------------------------------------------- the switch

export function SettingControl(props: ControlProps) {
  const { spec } = props;
  switch (spec.t) {
    case 'bool':
      return <BoolControl {...props} />;
    case 'enum':
      return <EnumControl {...props} spec={spec} />;
    case 'int':
      return <IntControl {...props} spec={spec} />;
    case 'text':
      return <TextControl {...props} spec={spec} />;
    case 'media':
      return <MediaControl {...props} kind={spec.kind} />;
    case 'link':
      return <LinkControl {...props} />;
    case 'date':
      return <DateControl {...props} />;
    case 'ref':
      return <RefControl {...props} refKind={spec.ref} />;
    case 'refs':
      return <RefsControl {...props} refKind={spec.ref} max={spec.max} />;
    case 'set':
      return <SetControl {...props} spec={spec} />;
    case 'socials':
      return <SocialsControl {...props} max={spec.max} />;
    case 'list':
      return <ListControl {...props} spec={spec} />;
  }
}

// ------------------------------------------------------------------ scalars

function BoolControl({ blockType, name, value, onChange, issues }: ControlProps) {
  const { label, hint } = useLabel(blockType, name);
  const { loc } = useLanguage();
  const note = issueWords(issues, loc, false);
  return <Switch checked={value === true} onChange={(v) => onChange(v)} label={label} description={note || hint} />;
}

function EnumControl({ blockType, name, value, onChange, issues, spec, path }: ControlProps & { spec: Extract<FieldSpec, { t: 'enum' }> }) {
  const { loc } = useLanguage();
  const { label } = useLabel(blockType, name);
  const words = (v: string) => say(loc, VALUE_COPY[v], v);
  if (spec.values.length <= 4) {
    return (
      <Frame blockType={blockType} name={name} issues={issues}>
        <Segmented
          size="sm"
          group={`sd-${path}`}
          label={label}
          value={typeof value === 'string' ? value : spec.d}
          onChange={(v) => onChange(v)}
          items={spec.values.map((v) => ({ id: v, label: words(v) }))}
        />
      </Frame>
    );
  }
  return (
    <Frame blockType={blockType} name={name} issues={issues}>
      <Select value={typeof value === 'string' ? value : spec.d} onChange={(e) => onChange(e.target.value)}>
        {spec.values.map((v) => (
          <option key={v} value={v}>
            {words(v)}
          </option>
        ))}
      </Select>
    </Frame>
  );
}

function IntControl({ blockType, name, value, onChange, issues, spec }: ControlProps & { spec: Extract<FieldSpec, { t: 'int' }> }) {
  const { loc } = useLanguage();
  const [bad, setBad] = useState(false);
  const n = typeof value === 'number' ? value : spec.d;
  return (
    <Frame
      blockType={blockType}
      name={name}
      issues={issues}
      hintExtra={
        <span className={`block ${bad ? 'text-danger' : ''}`}>
          {loc(`من ${spec.min} إلى ${spec.max}`, `From ${spec.min} to ${spec.max}`)}
        </span>
      }
    >
      <NumberInput
        kind="quantity"
        value={n}
        min={spec.min}
        max={spec.max}
        onValueChange={(v, valid) => {
          setBad(!valid || v === null);
          if (valid && v !== null && v >= spec.min && v <= spec.max) onChange(v);
        }}
      />
    </Frame>
  );
}

const LANGS = [
  { id: 'ar', short: 'ع', dir: 'rtl' },
  { id: 'en', short: 'En', dir: 'ltr' },
  { id: 'ckb', short: 'کو', dir: 'rtl' },
] as const;
type TextLang = (typeof LANGS)[number]['id'];

/**
 * Merchant text in the three interface languages, each written by hand: a
 * language left empty falls back to one the merchant did write (pickText),
 * never to a machine translation.
 */
function TextControl({ blockType, name, value, onChange, issues, spec, path }: ControlProps & { spec: Extract<FieldSpec, { t: 'text' }> }) {
  const { loc, lang: uiLang } = useLanguage();
  const [lang, setLang] = useState<TextLang>(uiLang === 'en' ? 'en' : uiLang === 'ckb' ? 'ckb' : 'ar');
  const { label, hint } = useLabel(blockType, name);
  const text: LocalizedText = isText(value) ? value : { ar: '', en: '', ckb: '' };
  const cur = text[lang] ?? '';
  const meta = LANGS.find((l) => l.id === lang)!;
  const groupId = useId();
  const langName = (l: TextLang) => (l === 'ar' ? loc('العربية', 'Arabic') : l === 'en' ? loc('الإنجليزية', 'English') : loc('الكردية (سوراني)', 'Kurdish (Sorani)'));
  const error = issueWords(issues, loc, true);
  const note = issueWords(issues, loc, false);
  const set = (v: string) => onChange({ ...text, [lang]: v }, `${path}.${lang}`);
  return (
    <Field
      label={label}
      error={error || undefined}
      hint={
        <span className="flex flex-wrap items-center gap-x-3">
          {hint && <span>{hint}</span>}
          {note && <span className="text-warning/90">{note}</span>}
          <span className="ms-auto tabular-nums" aria-live="off">
            {cur.length}/{spec.max}
          </span>
        </span>
      }
    >
      {/* The language row sits on the label's line, at its end; then the control. */}
      <div role="radiogroup" aria-label={loc('لغة النص', 'Text language')} id={groupId} className="-mt-[2.1rem] mb-1.5 flex justify-end gap-0.5">
        {LANGS.map((l) => {
          const on = l.id === lang;
          const filled = !!text[l.id];
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${langName(l.id)}${filled ? '' : ` — ${loc('فارغ', 'empty')}`}`}
              onClick={() => setLang(l.id)}
              className={`relative min-h-7 min-w-9 rounded-md px-2 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                on ? 'bg-surface-selected text-text-primary' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {l.short}
              {filled && <span aria-hidden="true" className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-success" />}
            </button>
          );
        })}
      </div>
      {spec.multiline ? (
        <Textarea value={cur} maxLength={spec.max} rows={4} dir={meta.dir} lang={lang} onChange={(e) => set(e.target.value)} aria-label={`${label} — ${langName(lang)}`} />
      ) : (
        <Input value={cur} maxLength={spec.max} dir={meta.dir} lang={lang} onChange={(e) => set(e.target.value)} aria-label={`${label} — ${langName(lang)}`} />
      )}
    </Field>
  );
}

const isText = (v: unknown): v is LocalizedText => !!v && typeof v === 'object' && 'ar' in (v as object);

function DateControl({ blockType, name, value, onChange, issues }: ControlProps) {
  const iso = typeof value === 'string' ? value : '';
  const local = iso && Number.isFinite(Date.parse(iso)) ? toLocalInput(new Date(iso)) : '';
  return (
    <Frame blockType={blockType} name={name} issues={issues}>
      <Input
        type="datetime-local"
        ltr
        value={local}
        min="2020-01-01T00:00"
        max="2099-12-31T23:59"
        onChange={(e) => {
          const ms = e.target.value ? Date.parse(e.target.value) : NaN;
          onChange(Number.isFinite(ms) ? new Date(ms).toISOString() : '');
        }}
      />
    </Frame>
  );
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// -------------------------------------------------------------------- media

function MediaControl({ blockType, name, value, onChange, issues, kind }: ControlProps & { kind: MediaKind }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const key = typeof value === 'string' ? value : '';
  return (
    <Frame blockType={blockType} name={name} issues={issues}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="relative flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-surface-raised text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label={key ? loc('تغيير', 'Change') : loc('اختيار', 'Choose')}
        >
          {key ? <MediaThumb value={key} kind={kind} className="h-full w-full" /> : kind === 'video' ? <Film className="h-5 w-5" aria-hidden="true" /> : <ImageIcon className="h-5 w-5" aria-hidden="true" />}
        </button>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {key ? loc('تغيير', 'Change') : kind === 'video' ? loc('اختر فيديو', 'Choose a video') : loc('اختر صورة', 'Choose a picture')}
          </Button>
          {key && (
            <Button size="sm" variant="ghost" onClick={() => onChange('')}>
              {loc('إزالة', 'Remove')}
            </Button>
          )}
        </div>
      </div>
      <MediaPicker open={open} onClose={() => setOpen(false)} kind={kind} value={key} onPick={(k) => onChange(k)} />
    </Frame>
  );
}

// -------------------------------------------------------------------- links

type LinkKind = LinkTarget['kind'];

/**
 * A link is one of five typed kinds; there is no free path. An https address
 * is typed as text and judged by the gate as it is typed — anything else (a
 * `javascript:` line, `http:`, a bare path) is shown as an error here and
 * never saved.
 */
function LinkControl({ blockType, name, value, onChange, issues, path }: ControlProps) {
  const { loc } = useLanguage();
  const link = (value && typeof value === 'object' ? value : { kind: 'none' }) as LinkTarget;
  const [picking, setPicking] = useState<RefKind | null>(null);
  // «An https address» chosen but nothing typed yet: shown, not committed, so
  // an empty «https://» is not reported as an unsafe link before any typing.
  const [startingUrl, setStartingUrl] = useState(false);
  const shownKind: LinkKind = startingUrl && link.kind !== 'external' ? 'external' : link.kind;
  const kinds: Array<{ id: LinkKind; label: string }> = [
    { id: 'none', label: loc('بلا رابط', 'No link') },
    { id: 'route', label: loc('صفحة في متجري', 'A page of my store') },
    { id: 'product', label: loc('منتج من منتجاتي', 'One of my products') },
    { id: 'collection', label: loc('مجموعة من مجموعاتي', 'One of my collections') },
    { id: 'external', label: loc('عنوان https خارجي', 'An https address') },
  ];
  const setKind = (k: LinkKind) => {
    setStartingUrl(k === 'external' && link.kind !== 'external');
    if (k === link.kind) return;
    if (k === 'none') onChange({ kind: 'none' });
    else if (k === 'route') onChange({ kind: 'route', route: 'products' });
    else if (k !== 'external') setPicking(k);
  };
  const typed = link.kind === 'external' ? link.url : 'https://';
  const localBad = link.kind === 'external' && !safeExternalUrl(typed);
  return (
    <Frame blockType={blockType} name={name} issues={issues}>
      <div className="space-y-2">
        <Select value={shownKind} onChange={(e) => setKind(e.target.value as LinkKind)} aria-label={loc('نوع الرابط', 'Link kind')}>
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </Select>
        {link.kind === 'route' && (
          <Select value={link.route} onChange={(e) => onChange({ kind: 'route', route: e.target.value })} aria-label={loc('الصفحة', 'Page')}>
            {LINK_ROUTES.map((r) => (
              <option key={r} value={r}>
                {say(loc, ROUTE_COPY[r])}
              </option>
            ))}
          </Select>
        )}
        {(link.kind === 'product' || link.kind === 'collection') && <RefChip kind={link.kind} id={link.id} onChange={() => setPicking(link.kind as RefKind)} />}
        {shownKind === 'external' && (
          <Input
            ltr
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            maxLength={500}
            onChange={(e) => {
              setStartingUrl(false);
              onChange({ kind: 'external', url: e.target.value }, `${path}.url`);
            }}
            aria-label={loc('عنوان الرابط', 'Web address')}
            aria-invalid={localBad || undefined}
            placeholder="https://"
          />
        )}
      </div>
      {picking && (
        <RefPicker
          open
          kind={picking}
          selected={link.kind === picking ? [link.id] : []}
          onClose={() => setPicking(null)}
          onPick={(ids) => ids[0] && onChange({ kind: picking, id: ids[0] })}
        />
      )}
    </Frame>
  );
}

function RefChip({ kind, id, onChange, onRemove }: { kind: RefKind; id: string; onChange?: () => void; onRemove?: () => void }) {
  const { loc } = useLanguage();
  const item = useRefName(kind, id);
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-xl border border-border-subtle bg-surface px-3">
      <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary" dir="auto">
        {item?.name ?? (kind === 'product' ? loc('منتج', 'Product') : kind === 'collection' ? loc('مجموعة', 'Collection') : loc('كوبون', 'Coupon'))}
      </span>
      {onChange && (
        <Button size="sm" variant="ghost" onClick={onChange}>
          {loc('تغيير', 'Change')}
        </Button>
      )}
      {onRemove && <IconButton variant="ghost" icon={<X className="h-4 w-4" />} label={loc('إزالة', 'Remove')} onClick={onRemove} />}
    </div>
  );
}

// --------------------------------------------------------------------- refs

function RefControl({ blockType, name, value, onChange, issues, refKind }: ControlProps & { refKind: RefKind }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const id = typeof value === 'string' ? value : '';
  return (
    <Frame blockType={blockType} name={name} issues={issues}>
      {id ? (
        <RefChip kind={refKind} id={id} onChange={() => setOpen(true)} onRemove={() => onChange('')} />
      ) : (
        <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setOpen(true)}>
          {refKind === 'coupon' ? loc('اختر كوبونًا', 'Choose a coupon') : refKind === 'collection' ? loc('اختر مجموعة', 'Choose a collection') : loc('اختر منتجًا', 'Choose a product')}
        </Button>
      )}
      <RefPicker open={open} onClose={() => setOpen(false)} kind={refKind} selected={id ? [id] : []} onPick={(ids) => onChange(ids[0] ?? '')} />
    </Frame>
  );
}

function RefsControl({ blockType, name, value, onChange, issues, refKind, max }: ControlProps & { refKind: RefKind; max: number }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <Frame blockType={blockType} name={name} issues={issues} hintExtra={<span className="block tabular-nums">{ids.length}/{max}</span>}>
      <div className="space-y-1.5">
        {ids.map((id, i) => (
          <div key={id} className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <RefChip kind={refKind} id={id} onRemove={() => onChange(ids.filter((x) => x !== id))} />
            </div>
            <IconButton variant="ghost" icon={<ArrowUp className="h-4 w-4" />} label={loc('للأعلى', 'Move up')} disabled={i === 0} onClick={() => move(i, -1)} />
            <IconButton variant="ghost" icon={<ArrowDown className="h-4 w-4" />} label={loc('للأسفل', 'Move down')} disabled={i === ids.length - 1} onClick={() => move(i, 1)} />
          </div>
        ))}
        <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setOpen(true)} disabled={ids.length >= max && refKind !== 'collection'}>
          {ids.length ? loc('عدّل الاختيار', 'Change the selection') : loc('اختر', 'Choose')}
        </Button>
      </div>
      <RefPicker open={open} onClose={() => setOpen(false)} kind={refKind} selected={ids} max={max} onPick={(next) => onChange(next)} />
    </Frame>
  );
}

// ---------------------------------------------------------------------- set

/** An ordered subset: tick what shows, and order what is ticked. */
function SetControl({ blockType, name, value, onChange, issues, spec }: ControlProps & { spec: Extract<FieldSpec, { t: 'set' }> }) {
  const { loc } = useLanguage();
  const chosen = Array.isArray(value) ? (value as string[]).filter((v) => spec.values.includes(v)) : [...spec.d];
  const rest = spec.values.filter((v) => !chosen.includes(v));
  const words = (v: string) => say(loc, VALUE_COPY[v], v);
  const toggle = (v: string) => {
    if (chosen.includes(v)) {
      if (chosen.length > spec.min) onChange(chosen.filter((x) => x !== v));
    } else if (chosen.length < spec.max) onChange([...chosen, v]);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= chosen.length) return;
    const next = [...chosen];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <Frame
      blockType={blockType}
      name={name}
      issues={issues}
      hintExtra={<span className="block">{loc(`من ${spec.min} إلى ${spec.max}`, `${spec.min} to ${spec.max}`)}</span>}
    >
      <ul className="space-y-1">
        {chosen.map((v, i) => (
          <li key={v} className="flex items-center gap-1">
            <Checkbox className="flex-1" checked onChange={() => toggle(v)} label={words(v)} disabled={chosen.length <= spec.min} />
            {spec.max > 1 && (
              <>
                <IconButton variant="ghost" icon={<ArrowUp className="h-4 w-4" />} label={loc(`${words(v)} للأعلى`, `Move ${words(v)} up`)} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton variant="ghost" icon={<ArrowDown className="h-4 w-4" />} label={loc(`${words(v)} للأسفل`, `Move ${words(v)} down`)} disabled={i === chosen.length - 1} onClick={() => move(i, 1)} />
              </>
            )}
          </li>
        ))}
        {rest.map((v) => (
          <li key={v}>
            <Checkbox checked={false} onChange={() => toggle(v)} label={words(v)} disabled={chosen.length >= spec.max} />
          </li>
        ))}
      </ul>
    </Frame>
  );
}

// ------------------------------------------------------------------ socials

/**
 * A provider from the closed list and a handle. The address is BUILT from the
 * provider's own template when the page renders — there is no URL field.
 */
function SocialsControl({ blockType, name, value, onChange, issues, max, path }: ControlProps & { max: number }) {
  const { loc } = useLanguage();
  const items = Array.isArray(value) ? (value as SocialItem[]) : [];
  const set = (i: number, patch: Partial<SocialItem>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)), `${path}[${i}]`);
  return (
    <Frame blockType={blockType} name={name} issues={issues} hintExtra={<span className="block tabular-nums">{items.length}/{max}</span>}>
      <div className="space-y-2">
        {items.map((it, i) => {
          const bad = issues.some((x) => x.field.startsWith(`${name}[${i}]`));
          return (
            <div key={i} className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto] items-center gap-1.5">
              <Select value={it.provider} onChange={(e) => set(i, { provider: e.target.value as SocialProviderName })} aria-label={loc('المنصة', 'Platform')}>
                {SOCIAL_PROVIDER_NAMES.map((p) => (
                  <option key={p} value={p}>
                    {SOCIAL_COPY[p]}
                  </option>
                ))}
              </Select>
              <Input ltr value={it.handle} maxLength={200} onChange={(e) => set(i, { handle: e.target.value })} placeholder="@handle" aria-label={loc('اسم الحساب', 'Handle')} aria-invalid={bad || undefined} />
              <IconButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} label={loc('حذف', 'Remove')} onClick={() => onChange(items.filter((_, j) => j !== i))} />
            </div>
          );
        })}
        {items.length < max && (
          <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => onChange([...items, { provider: 'instagram', handle: '' }])}>
            {loc('أضف حسابًا', 'Add an account')}
          </Button>
        )}
      </div>
    </Frame>
  );
}

// --------------------------------------------------------------------- list

function emptyItem(item: { readonly [k: string]: ScalarSpec }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(item)) {
    if (s.t === 'text') out[k] = { ar: '', en: '', ckb: '' };
    else if ('d' in s) out[k] = Array.isArray(s.d) ? [...s.d] : s.d;
    else if (s.t === 'link') out[k] = { kind: 'none' };
    else if (s.t === 'refs' || s.t === 'socials') out[k] = [];
    else out[k] = '';
  }
  return out;
}

/** A list of small records, each drawn from the item's own field specs. */
function ListControl({ blockType, name, value, onChange, issues, spec, path }: ControlProps & { spec: Extract<FieldSpec, { t: 'list' }> }) {
  const { loc } = useLanguage();
  const { label } = useLabel(blockType, name);
  const items = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const setItem = (i: number, key: string, v: unknown, k?: string) =>
    onChange(
      items.map((it, j) => (j === i ? { ...it, [key]: v } : it)),
      k
    );
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const listIssues = issues.filter((x) => x.field === name);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 flex w-full items-center gap-2 text-sm font-medium text-text-primary">
        {label}
        <span className="ms-auto text-[12px] font-normal tabular-nums text-text-muted">
          {items.length}/{spec.max}
        </span>
      </legend>
      {listIssues.length > 0 && <p className="lv-field-error">{issueWords(listIssues, loc, true) || issueWords(listIssues, loc, false)}</p>}
      {items.map((it, i) => {
        const at = `${name}[${i}]`;
        const itemIssues = issues.filter((x) => x.field.startsWith(at));
        const dropped = itemIssues.some((x) => x.code === 'dropped_item' && x.field === at);
        return (
          <div key={i} className={`space-y-3 rounded-xl border p-3 ${dropped ? 'border-warning/50' : 'border-border-subtle'}`}>
            <div className="flex items-center gap-1">
              <span className="text-[12px] font-semibold text-text-muted tabular-nums">{i + 1}</span>
              {dropped && <span className="text-[11.5px] text-warning">{say(loc, ISSUE_COPY.dropped_item)}</span>}
              <span className="ms-auto flex">
                <IconButton variant="ghost" icon={<ArrowUp className="h-4 w-4" />} label={loc('للأعلى', 'Move up')} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton variant="ghost" icon={<ArrowDown className="h-4 w-4" />} label={loc('للأسفل', 'Move down')} disabled={i === items.length - 1} onClick={() => move(i, 1)} />
                <IconButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} label={loc('حذف العنصر', 'Remove item')} onClick={() => onChange(items.filter((_, j) => j !== i))} />
              </span>
            </div>
            {Object.entries(spec.item).map(([k, s]) => (
              <SettingControl
                key={k}
                blockType={blockType}
                name={k}
                spec={s}
                value={it[k]}
                path={`${path}[${i}].${k}`}
                issues={itemIssues
                  .filter((x) => x.field === `${at}.${k}` || x.field.startsWith(`${at}.${k}.`) || x.field.startsWith(`${at}.${k}[`))
                  .map((x) => ({ ...x, field: x.field.slice(at.length + 1) }))}
                onChange={(v, key) => setItem(i, k, v, key)}
              />
            ))}
          </div>
        );
      })}
      {items.length < spec.max && (
        <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => onChange([...items, emptyItem(spec.item)])}>
          {loc('أضف عنصرًا', 'Add an item')}
        </Button>
      )}
    </fieldset>
  );
}
