/**
 * The schema-less editor tree. `ValueEditor` looks at a VALUE and the DEFAULT
 * beside it (schema.ts `shapeOf`) and picks the control: a number box with a
 * unit or a star/percent preview, a switch, a text box with the document's
 * own catalog keys as suggestions, three boxes for a localised name, chips
 * for a key list, small boxes for a number list, a row table for a catalog
 * (locked keys once saved, a blank row from the defaults' template, an
 * in-app confirm before a row goes), and a fieldset for a nested group.
 *
 * Nothing here knows a field by name beyond the HINTS in schema.ts — a
 * section the engine grows tomorrow renders today, humanised.
 */
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Lock, Plus, Trash2, X } from 'lucide-react';
import type { Language } from '../../translations';
import type { Localized } from '../../lib/farmApi';
import { Grid, btnGhost, btnDanger, iconBtn } from '../adminProducts/form/formUi';
import { Overlay } from '../ui/Overlay';
import { nameOf, starsFromBp } from '../../pages/farm/format';
import {
  FIXED_KEY_PATHS,
  KEY_RE,
  blankFrom,
  defaultText,
  freshKey,
  getAt,
  isPlainObject,
  isTuple,
  numberSpec,
  ratioPercent,
  referenceOptions,
  renameKey,
  shapeOf,
  splitPath,
  templateOf,
  type JsonObject,
} from './schema';
import { labelFor } from './labels';
import { ChipEditor, FarmField, NumInput, NumListEditor, Switch, TextBox } from './inputs';
import type { FarmAdminStrings } from './strings';

export interface EditorCtx {
  s: FarmAdminStrings;
  lang: Language;
  /** The whole draft document — reference hints (material keys, colour keys) read from it. */
  doc: JsonObject;
  /** The last document read from the server — catalog keys present here are locked. */
  saved: JsonObject | null;
}

export interface EditorProps {
  path: string;
  value: unknown;
  /** The default at the same path (undefined for a key the defaults do not have). */
  fallback: unknown;
  onChange: (v: unknown) => void;
  ctx: EditorCtx;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// ------------------------------------------------------------------ dispatch

export function ValueEditor(p: EditorProps) {
  const shape = shapeOf(p.value, p.fallback);
  switch (shape) {
    case 'number':
      return <NumberField {...p} />;
    case 'boolean':
      return <BoolField {...p} />;
    case 'string':
      return <StringField {...p} />;
    case 'localized':
      return <LocalizedField {...p} />;
    case 'string-list':
      return <StringListField {...p} />;
    case 'number-list':
      return <NumberListField {...p} />;
    case 'record-list':
      return <RecordListEditor {...p} />;
    case 'catalog':
      return <CatalogEditor {...p} />;
    case 'group':
      return <GroupEditor {...p} />;
    default:
      return <JsonField {...p} />;
  }
}

// ------------------------------------------------------------------- scalars

function NumberField({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const spec = numberSpec(path, fallback);
  const v = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const preview =
    spec.kind === 'bp' ? s.starsPreview(starsFromBp(v)) : spec.kind === 'ratio' ? s.percentPreview(ratioPercent(v)) : undefined;
  const unit = spec.kind === 'money' ? s.unitCoins : spec.unit;
  const def = defaultText(fallback);
  return (
    <FarmField label={lb.label} secondary={lb.secondary} hint={lb.hint} defaultText={def ? s.defaultIs(def) : undefined} path={path}>
      <NumInput
        value={v}
        onChange={onChange}
        integer={spec.integer}
        step={spec.step}
        min={spec.min}
        max={spec.max}
        unit={unit}
        preview={preview}
        placeholder={def}
      />
    </FarmField>
  );
}

function BoolField({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const checked = value === true;
  return (
    <FarmField
      label={lb.label}
      secondary={lb.secondary}
      hint={lb.hint}
      defaultText={typeof fallback === 'boolean' ? s.defaultIs(fallback ? s.on : s.off) : undefined}
      path={path}
    >
      <Switch checked={checked} onChange={onChange} label={checked ? s.on : s.off} />
    </FarmField>
  );
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function StringField({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const id = useId();
  const listId = `${id}-list`;
  const options = referenceOptions(path, ctx.doc);
  const def = defaultText(fallback);
  const text = str(value);
  // A colour's hex shows its swatch — the value itself, not a guess.
  const swatch = path.split('.').pop() === 'hex' && HEX_RE.test(text.trim()) ? text.trim() : null;
  return (
    <FarmField label={lb.label} secondary={lb.secondary} hint={lb.hint} defaultText={def ? s.defaultIs(def) : undefined} path={path} htmlFor={id}>
      <div className="flex items-center gap-2 min-w-0">
        <TextBox id={id} value={text} onChange={onChange} placeholder={def} mono list={options ? listId : undefined} />
        {swatch && <span aria-hidden="true" className="shrink-0 w-6 h-6 rounded-md border border-white/15" style={{ backgroundColor: swatch }} />}
        {options && (
          <datalist id={listId}>
            {options.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        )}
      </div>
    </FarmField>
  );
}

/** The three boxes of a localised name, without a field label (the caller supplies one). */
function LocalizedInputs({
  id,
  value,
  fallback,
  onChange,
  label,
  s,
}: {
  id?: string;
  value: unknown;
  fallback: unknown;
  onChange: (v: unknown) => void;
  label: string;
  s: FarmAdminStrings;
}) {
  const v = isPlainObject(value) ? value : {};
  const d = isPlainObject(fallback) ? fallback : {};
  const set = (k: 'ar' | 'en' | 'ckb', text: string) => onChange({ ar: str(v.ar), en: str(v.en), ckb: str(v.ckb), [k]: text });
  return (
    <div className="grid gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:repeat(3,minmax(0,1fr))] min-w-0">
      <TextBox id={id} ariaLabel={`${label} — ${s.langAr}`} rtl value={str(v.ar)} onChange={(t) => set('ar', t)} placeholder={str(d.ar) || s.langAr} />
      <TextBox ariaLabel={`${label} — ${s.langEn}`} value={str(v.en)} onChange={(t) => set('en', t)} placeholder={str(d.en) || s.langEn} />
      <TextBox ariaLabel={`${label} — ${s.langCkb}`} rtl value={str(v.ckb)} onChange={(t) => set('ckb', t)} placeholder={str(d.ckb) || s.langCkb} />
    </div>
  );
}

function LocalizedField({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const id = useId();
  return (
    <FarmField label={lb.label} secondary={lb.secondary} hint={lb.hint} path={path} span htmlFor={id}>
      <LocalizedInputs id={id} value={value} fallback={fallback} onChange={onChange} label={lb.label} s={s} />
    </FarmField>
  );
}

// --------------------------------------------------------------------- lists

function StringListField({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const id = useId();
  const list = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const def = defaultText(fallback);
  const options = referenceOptions(path, ctx.doc);
  return (
    <FarmField label={lb.label} secondary={lb.secondary} hint={lb.hint} defaultText={def ? s.defaultIs(def) : undefined} path={path} span htmlFor={id}>
      <ChipEditor id={id} value={list} onChange={onChange} s={s} suggestions={options ?? undefined} />
    </FarmField>
  );
}

function NumberListField({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const id = useId();
  const list = Array.isArray(value) ? value.filter((x): x is number => typeof x === 'number') : [];
  const defs = Array.isArray(fallback) ? fallback.filter((x): x is number => typeof x === 'number') : undefined;
  const spec = numberSpec(path, defs?.[0]);
  const def = defaultText(fallback);
  return (
    <FarmField label={lb.label} secondary={lb.secondary} hint={lb.hint} defaultText={def ? s.defaultIs(def) : undefined} path={path} span htmlFor={id}>
      <NumListEditor
        id={id}
        value={list}
        onChange={onChange}
        s={s}
        integer={spec.integer}
        unit={spec.unit}
        defaults={defs}
        fixedLength={isTuple(path, defs ?? list)}
      />
    </FarmField>
  );
}

/** An ordered list of records (a tier's fictional customer names): rows with add and remove. */
function RecordListEditor({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const lb = labelFor(path, lang);
  const items = Array.isArray(value) ? value : [];
  const template = templateOf(fallback) ?? items[0] ?? {};
  const set = (i: number, v: unknown) => onChange(items.map((x, j) => (j === i ? v : x)));
  return (
    <div className="min-w-0" data-farm-list={path}>
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <span className="text-[11px] text-zinc-500 tabular-nums">{s.entriesCount(items.length)}</span>
        <button type="button" onClick={() => onChange([...items, blankFrom(template)])} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          {s.addItem}
        </button>
      </div>
      {items.length === 0 && <p className="text-[11px] text-zinc-600">{s.emptyList}</p>}
      <div className="space-y-2 min-w-0">
        {items.map((item, i) => {
          const itemPath = `${path}.${i}`;
          const shape = shapeOf(item, template);
          return (
            <div key={i} className="flex items-start gap-2 min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-2">
              <span className="shrink-0 w-6 h-10 grid place-items-center text-[11px] text-zinc-500 tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {shape === 'localized' ? (
                  <LocalizedInputs value={item} fallback={template} onChange={(v) => set(i, v)} label={`${lb.label} ${i + 1}`} s={s} />
                ) : shape === 'group' ? (
                  <GroupEditor path={itemPath} value={item} fallback={template} onChange={(v) => set(i, v)} ctx={ctx} />
                ) : (
                  <ValueEditor path={itemPath} value={item} fallback={template} onChange={(v) => set(i, v)} ctx={ctx} />
                )}
              </div>
              <button
                type="button"
                aria-label={s.removeItem(i + 1)}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className={`${iconBtn} hover:text-red-300`}
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- groups

/** A nested object as a bordered fieldset: label as legend, hint under it, its fields in a grid. */
function NestedBlock({ path, ctx, children }: { path: string; ctx: EditorCtx; children: ReactNode }) {
  const lb = labelFor(path, ctx.lang);
  return (
    <fieldset data-farm-group={path} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
      <legend className="px-1 text-[12px] font-bold text-zinc-200">
        {lb.label}
        {lb.secondary && <span className="ms-1.5 text-[10px] font-medium text-zinc-500">{lb.secondary}</span>}
      </legend>
      {lb.hint && <p className="mb-2 text-[11px] text-zinc-500 leading-snug">{lb.hint}</p>}
      {children}
    </fieldset>
  );
}

/**
 * The fields of a plain object in a responsive grid. Scalars sit in the
 * grid; anything with its own structure (a group, a catalog, a list of
 * records) takes the full row inside a fieldset.
 */
export function GroupEditor({ path, value, fallback, onChange, ctx }: EditorProps) {
  const obj = isPlainObject(value) ? value : {};
  const defs = isPlainObject(fallback) ? fallback : {};
  return (
    <Grid cols={3}>
      {Object.entries(obj).map(([k, v]) => {
        const childPath = path ? `${path}.${k}` : k;
        const childDef = defs[k];
        const shape = shapeOf(v, childDef);
        const set = (nv: unknown) => onChange({ ...obj, [k]: nv });
        if (shape === 'group' || shape === 'catalog' || shape === 'record-list') {
          return (
            <div key={k} className="md:col-span-2 xl:col-span-3 min-w-0">
              <NestedBlock path={childPath} ctx={ctx}>
                <ValueEditor path={childPath} value={v} fallback={childDef} onChange={set} ctx={ctx} />
              </NestedBlock>
            </div>
          );
        }
        return <ValueEditor key={k} path={childPath} value={v} fallback={childDef} onChange={set} ctx={ctx} />;
      })}
    </Grid>
  );
}

/** A shape the editor does not know: shown as it is, never silently dropped. */
function JsonField({ path, value, ctx }: EditorProps) {
  const lb = labelFor(path, ctx.lang);
  return (
    <div className="md:col-span-2 xl:col-span-3 min-w-0" data-farm-field={path}>
      <p className="text-[12px] font-bold text-zinc-300 mb-1">{lb.label}</p>
      <p className="text-[11px] text-zinc-500 mb-1">{ctx.s.shapeUnsupported}</p>
      <pre dir="ltr" className="text-[11px] text-zinc-400 bg-zinc-950/60 border border-zinc-800 rounded-lg p-2 overflow-x-auto max-h-48">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// ------------------------------------------------------------------ catalogs

/** A new row's key box: valid (KEY_RE), unique, committed on Enter or blur. */
function KeyInput({ value, taken, onCommit, s }: { value: string; taken: readonly string[]; onCommit: (k: string) => void; s: FarmAdminStrings }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const trimmed = text.trim();
  const invalid = trimmed !== '' && !KEY_RE.test(trimmed);
  const isTaken = trimmed !== value && taken.includes(trimmed);
  const commit = () => {
    if (!trimmed || invalid || isTaken || trimmed === value) {
      setText(value);
      return;
    }
    onCommit(trimmed);
  };
  return (
    <FarmField label={s.keyLabel} hint={s.keyPlaceholder} error={invalid ? s.keyInvalid : isTaken ? s.keyTaken : null} path="key">
      <TextBox value={text} onChange={setText} mono invalid={invalid || isTaken} placeholder={s.keyPlaceholder} onBlur={commit} onEnter={commit} />
    </FarmField>
  );
}

/**
 * A record keyed by catalog id (printers, materials, colours, products,
 * customers, locations, failure kinds). Rows are collapsed to a header —
 * key, name, a locked mark when the server already has the key — and open one
 * at a time. FIXED_KEY_PATHS (customers, quality, failure kinds) cannot gain
 * or lose rows: the engine names those keys.
 */
export function CatalogEditor({ path, value, fallback, onChange, ctx }: EditorProps) {
  const { s, lang } = ctx;
  const obj = isPlainObject(value) ? value : {};
  const defs = isPlainObject(fallback) ? fallback : {};
  const template = templateOf(fallback) ?? templateOf(obj) ?? {};
  const fixed = FIXED_KEY_PATHS.includes(path);
  const savedObj = getAt(ctx.saved, splitPath(path));
  const savedKeys = isPlainObject(savedObj) ? Object.keys(savedObj) : [];
  const keys = Object.keys(obj);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const removeAnchor = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  const add = () => {
    const k = freshKey(keys);
    onChange({ ...obj, [k]: blankFrom(template) });
    setOpenKey(k);
  };
  const remove = (k: string) => {
    const next = { ...obj };
    delete next[k];
    onChange(next);
    if (openKey === k) setOpenKey(null);
    setPendingRemove(null);
  };
  const rename = (from: string, to: string) => {
    onChange(renameKey(obj, from, to));
    if (openKey === from) setOpenKey(to);
  };

  return (
    <div className="min-w-0" data-farm-catalog={path}>
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <span className="text-[11px] text-zinc-500 tabular-nums">{s.entriesCount(keys.length)}</span>
        {!fixed && (
          <button type="button" onClick={add} className={`${btnGhost} h-8 px-2.5 text-[12px]`} data-farm-add={path}>
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            {s.addEntry}
          </button>
        )}
      </div>
      {fixed && <p className="mb-2 text-[11px] text-zinc-500">{s.keysFixed}</p>}
      {keys.length === 0 && <p className="text-[11px] text-zinc-600">{s.emptyList}</p>}
      <div className="space-y-1.5 min-w-0">
        {keys.map((k) => {
          const row = obj[k];
          const rowDef = defs[k] ?? template;
          const existing = savedKeys.includes(k);
          const open = openKey === k;
          const rowLabel = fixed ? labelFor(`${path}.${k}`, lang) : null;
          const nm = isPlainObject(row) ? row.name : undefined;
          const rowName = typeof nm === 'string' || isPlainObject(nm) ? nameOf(nm as Localized, lang, '') : '';
          const title = rowLabel?.curated ? rowLabel.label : rowName;
          return (
            <div
              key={k}
              data-farm-row={k}
              className={`min-w-0 rounded-lg border overflow-hidden ${open ? 'border-gold/40 bg-zinc-950/40' : 'border-zinc-800 bg-zinc-950/20'}`}
            >
              <div className="flex items-center gap-1 min-w-0 pe-1">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={open ? s.collapseRow(k) : s.expandRow(k)}
                  onClick={() => setOpenKey(open ? null : k)}
                  className="flex-1 min-w-0 flex items-center gap-2 ps-2.5 h-11 text-start hover:bg-zinc-800/30 transition-colors"
                >
                  <ChevronDown className={`shrink-0 w-4 h-4 text-zinc-500 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                  <span className="shrink-0 inline-flex items-center gap-1 font-mono text-[12px] text-zinc-100" dir="ltr">
                    {existing && !fixed && <Lock className="w-3 h-3 text-zinc-500" aria-hidden="true" />}
                    {k}
                  </span>
                  {title && <span className="min-w-0 truncate text-[12px] text-zinc-400">{title}</span>}
                  {!existing && !fixed && (
                    <span className="shrink-0 h-5 px-1.5 rounded-full bg-gold/15 text-gold text-[10px] font-bold grid place-items-center">{s.newRow}</span>
                  )}
                </button>
                {!fixed && (
                  <button
                    type="button"
                    aria-label={`${s.removeEntry}: ${k}`}
                    onClick={(e) => {
                      // The window scales from the button that asked for it; the
                      // anchor is set before the render that opens it.
                      removeAnchor.current = e.currentTarget;
                      setPendingRemove(k);
                    }}
                    className={`${iconBtn} hover:text-red-300`}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              {open && (
                <div className="p-3 border-t border-zinc-800/70 min-w-0 space-y-3">
                  {!existing && !fixed && <KeyInput value={k} taken={keys} onCommit={(to) => rename(k, to)} s={s} />}
                  {existing && !fixed && <p className="text-[11px] text-zinc-500">{s.keyLocked}</p>}
                  <GroupEditor
                    path={`${path}.${k}`}
                    value={row}
                    fallback={rowDef}
                    onChange={(v) => onChange({ ...obj, [k]: v })}
                    ctx={ctx}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Overlay
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        labelledBy={titleId}
        anchor={removeAnchor}
        testId="farm-remove-row"
        panelClassName="w-full max-w-sm"
      >
        <div className="p-5">
          <h3 id={titleId} className="text-white font-bold text-[15px]">{s.removeTitle}</h3>
          <p className="text-zinc-300 text-[13px] mt-2 leading-relaxed">{s.removeBody(pendingRemove ?? '')}</p>
          <div className="mt-4 flex flex-col-reverse sm:flex-row gap-2">
            <button type="button" onClick={() => setPendingRemove(null)} className={`${btnGhost} flex-1 h-10`}>
              {s.cancel}
            </button>
            <button type="button" onClick={() => pendingRemove !== null && remove(pendingRemove)} className={`${btnDanger} flex-1 h-10`} data-farm-remove-confirm>
              {s.remove}
            </button>
          </div>
        </div>
      </Overlay>
    </div>
  );
}
