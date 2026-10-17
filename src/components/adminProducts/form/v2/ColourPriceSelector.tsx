/**
 * A COLOUR'S PRICE, IN ITS OWN CARD OF SECTION ٥ (implementation spec §5.2
 * `ColourPriceSelector.tsx`; docs/PRICING-V2.md §1.4, §2.4; owner decision C1).
 *
 *   «السعر [يتبع الموديل | ± $ فوق الموديل]» — one dollar difference added to
 *   EVERY model's price for that colour, so «Red +$2» never erases a model's
 *   premium (C1);
 *   the result per model it shows with — «Standard: مباشر 1,503,000 · بري
 *   1,450,500 (بعد خصم $35.00)», each figure labelled by its channel (a
 *   pre-order-only SKU names its route), and the owner's reasons under it
 *   (`lineNotes`, row 247);
 *   «حدّد» ticks it for «طبّق على الألوان المحددة» (ColourBulkBar).
 * The default is «كل الألوان بسعر واحد»: colours follow their model.
 */
import { FOLLOW_COLOUR, colourLines, firstPreorder, iqdText, nameIn, preorderOffOf, usdText, type ColourDraft, type V2TableRow } from './v2Model';
import { useV2 } from './useV2Pricing';
import { Select } from '../formUi';
import { lineNotes } from './ResultBar';
import { channelName, Chip, UsdInput, useV2Lang, useV2Strings, V2Field } from './v2Ui';

export default function ColourPriceSelector({ id, table }: { id: string; table: readonly V2TableRow[] }) {
  const v2 = useV2();
  const s = useV2Strings();
  const lang = useV2Lang();
  if (!v2 || !v2.mode) return null;
  const d = v2.draft;
  const c: ColourDraft = d?.colours[id] ?? FOLLOW_COLOUR;
  const lines = colourLines(table, id);
  const owner = v2.owner;
  const fig = (row: V2TableRow) =>
    row.blocked ? (
      <span className="font-bold text-text-primary">{s.noPriceYet}</span>
    ) : (
      <span dir="ltr" className="font-bold tabular-nums text-text-primary">
        {iqdText(row.price_iqd)}
      </span>
    );
  const notes = owner ? [...new Set(lines.flatMap((l) => lineNotes(l, s)))] : [];
  const result = lines.length ? (
    <div className="grid min-w-0 gap-0.5">
      <ul className="grid gap-0.5 text-[11px] text-text-secondary" dir="auto" data-v2-colour-result={id}>
        {lines.map((l) => {
          const direct = l.channels.direct_sale ?? null;
          const pre = firstPreorder(l);
          const off = owner ? preorderOffOf(pre, direct) : null;
          return (
            <li key={l.combo_key} className="min-w-0">
              <span className="font-bold">{nameIn(l.names, lang)}:</span>{' '}
              {direct ? (
                <>
                  {s.direct} {fig(direct)}
                </>
              ) : null}
              {direct && pre ? ' · ' : null}
              {/* A pre-order-only SKU is labelled with its route, never shown as an unlabelled figure. */}
              {pre ? (
                <>
                  {channelName(pre.channel, lang)} {fig(pre)}
                  {off ? ` (${s.preorderAfterOff(usdText(off))})` : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {notes.length ? (
        <ul className="grid gap-0.5 text-[11px] text-amber-300" data-v2-colour-notes={id}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  ) : null;
  if (!d || !v2.money) {
    return result ? <div className="mt-2 border-t border-border-subtle pt-2 min-w-0" data-v2-colour={id}>{result}</div> : null;
  }
  const set = (patch: Partial<ColourDraft>) => v2.setDraft((x) => ({ ...x, colours: { ...x.colours, [id]: { ...(x.colours[id] ?? FOLLOW_COLOUR), ...patch } } }));
  const selected = v2.selectedColours.has(id);
  return (
    <div className="mt-2 border-t border-border-subtle pt-2 min-w-0 grid gap-2" data-v2-colour={id}>
      <div className="grid min-w-0 gap-2 [grid-template-columns:minmax(0,1fr)] sm:[grid-template-columns:minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <V2Field label={s.price}>
          {(fid) => (
            <Select id={fid} value={c.price} onChange={(e) => set({ price: e.target.value === 'delta' ? 'delta' : 'follow' })} data-v2-field={`colour-price:${id}`}>
              <option value="follow">{s.followsModel}</option>
              <option value="delta">{s.overModel}</option>
            </Select>
          )}
        </V2Field>
        {c.price === 'delta' ? (
          <V2Field label={s.overModel}>
            {(fid) => <UsdInput id={fid} signed value={c.usd} onChange={(usd) => set({ usd })} data={`colour-usd:${id}`} />}
          </V2Field>
        ) : (
          <span />
        )}
        <label className="flex h-10 items-center gap-2 text-[12px] font-bold text-text-secondary">
          <input type="checkbox" className="h-4 w-4" checked={selected} onChange={() => v2.toggleColour(id)} data-v2-select-colour={id} />
          {s.selectColour}
        </label>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {result}
        {c.price === 'delta' ? (
          <span className="flex items-center gap-2">
            <Chip tone="info" data="exception">{s.exception}</Chip>
            <button type="button" className="inline-flex min-h-11 items-center px-2 text-[11px] font-bold underline underline-offset-2 text-text-secondary" onClick={() => set({ ...FOLLOW_COLOUR })} data-v2-inherit={id}>
              {s.backToInherited}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * «طبّق على الألوان المحددة» / «كل الألوان بسعر واحد» — above the colours of
 * section ٥: one dollar difference for every ticked colour, or every colour
 * back to its model's price.
 */
export function ColourBulkBar({ colourIds }: { colourIds: readonly string[] }) {
  const v2 = useV2();
  const s = useV2Strings();
  if (!v2 || !v2.mode || !v2.money || !v2.draft || colourIds.length === 0) return null;
  const draft = v2.draft;
  const ticked = colourIds.filter((id) => v2.selectedColours.has(id));
  const anyOwn = colourIds.some((id) => (draft.colours[id] ?? FOLLOW_COLOUR).price === 'delta');
  const first = ticked.length ? (draft.colours[ticked[0]!] ?? FOLLOW_COLOUR) : FOLLOW_COLOUR;
  const apply = (usd: string) =>
    v2.setDraft((x) => ({ ...x, colours: { ...x.colours, ...Object.fromEntries(ticked.map((id) => [id, { price: 'delta' as const, usd }])) } }));
  return (
    <div className="lv-well mb-2 grid min-w-0 gap-2 rounded-lg p-2.5" data-v2-colour-bulk>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] font-bold text-text-secondary">{s.allColoursOne}</span>
        {anyOwn ? (
          <button
            type="button"
            className="inline-flex min-h-11 items-center px-2 text-[11px] font-bold underline underline-offset-2 text-text-secondary"
            onClick={() => {
              v2.setDraft((x) => ({ ...x, colours: Object.fromEntries(colourIds.map((id) => [id, { ...FOLLOW_COLOUR }])) }));
              v2.clearColours();
            }}
            data-v2-colours-follow
          >
            {s.backToInherited}
          </button>
        ) : null}
      </div>
      {ticked.length ? (
        <div className="grid min-w-0 gap-1.5">
          <span className="text-[11px] text-text-muted">{s.applySelected} ({ticked.length})</span>
          <UsdInput signed value={first.price === 'delta' ? first.usd : ''} onChange={apply} label={s.applySelected} data="colour-bulk-usd" />
        </div>
      ) : null}
    </div>
  );
}
