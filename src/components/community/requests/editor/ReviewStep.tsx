/**
 * STEP 4, «راجع طلبك» — THE LAST LOOK BEFORE IT GOES OUT, AS A PAGE
 * (community UI plan C4, §4; IMG_8470, IMG_8480; P1-06 design §8,
 * critiques 5 and 6; `17.public-private-preview`).
 *
 *   the hero          the first picture and the title; a tap goes back to
 *                     step 1 at the title
 *   «الملفات»         every file as the merchants will list it
 *   «مواصفات الطباعة» the method, the material, the colour, the quality
 *                     with its layer, the quantity and the size; a job of
 *                     several parts lists each part
 *   «التسليم»         the governorate and the handover, the day
 *   «الميزانية المقترحة» the figure, what the switch means now, and that
 *                     the price itself comes from the offers
 * Each card has «تعديل», which opens its step at its card. Then the Levonis
 * estimate with what it covers, «ما يراه الآخرون» open, and the privacy
 * line. The verb is in the dock (RequestEditor.tsx): «انشر الطلب», «احفظ
 * التعديلات» or «أرسل إلى {store}».
 *
 * Also here: the step 3 summary card «ملخص الطلب» (IMG_8477), the same facts
 * in short.
 */
import type { ReactNode } from 'react';
import { Box, CalendarDays, ChevronLeft, ChevronRight, Coins, Image as ImageIcon, Info, Layers, MapPin, Palette, Pencil } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { iqdUnit } from '../../../../lib/money';
import { KitCard, SectionCard } from '../../kit/display';
import { estimateCoverageLine, requestStrings } from '../strings';
import type { Catalog, CatalogMaterial, Quote } from '../api';
import { AudiencePanel } from './AudiencePanel';
import { budgetLine, dayInWords, governorateWords, handoverWords } from './DeliveryFields';
import { isolateLtr, latinIqd, rangeText } from './estimate';
import { coloursSummary, materialWords } from './MaterialRow';
import { dimsText, partSize } from './PartCard';
import { layerText } from './PartsEditor';
import { SourceThumb } from './SourceThumb';
import { fileMeta, sourceName, thumbKindOf } from './SourcesArea';
import { isFileSource, isNamed, isPublishedEdit, partProcess, type EditorState } from './state';
import { copiesWords, fill, partsCountWords, setsWords, type EditorLang, type EditorStrings } from './strings';

export type EditTarget = { step: 1 | 2 | 3; focus: string };

/** «80 × 40 × 30 mm» in a line of any direction. */
const sizeWords = (d: { x: number; y: number; z: number }) => `${dimsText(d).split('×').join(' × ')} mm`;

function Fact({ label, children, icon }: { label: ReactNode; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="lv-well flex min-h-12 min-w-0 items-center gap-2 rounded-md px-3 py-2" data-review-fact>
      {icon && (
        <span aria-hidden="true" className="shrink-0 text-text-secondary">
          {icon}
        </span>
      )}
      <span className="shrink-0 text-[13px] text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-end text-[15px] font-semibold text-text-primary">{children}</span>
    </div>
  );
}

function EditLink({ section, onClick, t }: { section: string; onClick: () => void; t: EditorStrings }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={fill(t.editSectionNamed, { section })}
      className="-me-1 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-sm px-1 text-[15px] font-semibold text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      data-review-edit
    >
      <Pencil aria-hidden="true" className="h-4 w-4" />
      {t.editSection}
    </button>
  );
}

/** The facts of the job of one part, in the order of the reference. */
function jobFacts(s: EditorState, catalogue: readonly CatalogMaterial[], qualities: Catalog['qualities'] | undefined, refName: (key: string) => string, lang: EditorLang, t: EditorStrings) {
  const p = s.parts[0];
  const processOf = (id: string): 'fdm' | 'resin' | '' => catalogue.find((m) => m.id === id)?.process ?? '';
  const proc = p ? partProcess(p, processOf) : 'unsure';
  const size = p ? partSize(p, s.files) : null;
  const colours = p ? p.materials.flatMap((m) => m.colours) : [];
  const swatch = colours.find(isNamed)?.hex;
  const layer = proc === 'resin' ? '' : layerText(s.quality, qualities);
  const quality = { draft: t.qDraft, standard: t.qStandard, fine: t.qFine, ultra: t.qUltra }[s.quality];
  return {
    process: proc === 'fdm' ? 'FDM' : proc === 'resin' ? t.processResin : t.unsure,
    material: p ? p.materials.map((m) => materialWords(m.materialId, lang, t, catalogue)).join(' + ') : t.unsure,
    colour: coloursSummary(colours, lang, t, refName),
    swatch,
    quality: layer ? `${quality} · ${layer}` : quality,
    quantity: s.parts.length > 1 ? setsWords(s.sets, lang) : copiesWords(s.sets * Math.max(1, p?.perSet ?? 1), lang),
    size: size ? sizeWords(size) : t.notSet,
  };
}

/** «ملخص الطلب» (step 3): the first picture beside the facts in short. */
export function RequestSummary({ state: s, catalogue, refName, lang, t }: { state: EditorState; catalogue: readonly CatalogMaterial[]; refName: (key: string) => string; lang: EditorLang; t: EditorStrings }) {
  const picture = s.files.find((f) => f.inline);
  const model = s.files.find((f) => f.kind === 'model');
  const f = jobFacts(s, catalogue, undefined, refName, lang, t);
  const rows: Array<[ReactNode, string, ReactNode]> =
    s.parts.length > 1
      ? [
          [<Box key="i" className="h-5 w-5" />, t.partsTitle, partsCountWords(s.parts.length, lang)],
          [<Layers key="i" className="h-5 w-5" />, t.sets, setsWords(s.sets, lang)],
          [<Layers key="i" className="h-5 w-5" />, t.material, f.material],
        ]
      : [
          [<Box key="i" className="h-5 w-5" />, t.quantity, f.quantity],
          [<Layers key="i" className="h-5 w-5" />, t.material, f.material],
          [<Palette key="i" className="h-5 w-5" />, t.colour, f.colour],
          [<Box key="i" className="h-5 w-5" />, t.sizeTitle, <bdi key="v" dir="ltr">{f.size}</bdi>],
        ];
  return (
    <SectionCard title={t.summaryTitle} data-editor-card="summary">
      <div className="flex gap-3">
        <span className="shrink-0">
          {picture ? <SourceThumb kind="image" url={picture.url} size={96} alt="" /> : <SourceThumb kind={model ? 'model' : 'document'} size={96} />}
        </span>
        <dl className="min-w-0 flex-1 divide-y divide-border-subtle rounded-md">
          {rows.map(([icon, k, v]) => (
            <div key={k} className="flex min-h-11 items-center gap-2 py-1.5">
              <span aria-hidden="true" className="shrink-0 text-text-secondary">
                {icon}
              </span>
              <dt className="shrink-0 text-[13px] text-text-muted">{k}</dt>
              <dd className="min-w-0 flex-1 truncate text-end text-[15px] font-semibold text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </SectionCard>
  );
}

export function ReviewStep({
  state: s,
  catalogue,
  qualities,
  refName,
  quote,
  onEdit,
  lang,
  t,
}: {
  state: EditorState;
  catalogue: readonly CatalogMaterial[];
  qualities?: Catalog['qualities'];
  refName: (key: string) => string;
  /** The last estimate of the body as it stands. */
  quote: Quote | null;
  onEdit: (target: EditTarget) => void;
  lang: EditorLang;
  t: EditorStrings;
}) {
  const { dir } = useLanguage();
  const rs = requestStrings(lang);
  const edit = isPublishedEdit(s);
  const direct = !!s.direct;
  const d = s.delivery ?? s.carried;
  const picture = s.files.find((f) => f.inline);
  const files = s.sources.filter((x) => isFileSource(x) || x.kind === 'link');
  const facts = jobFacts(s, catalogue, qualities, refName, lang, t);
  const coverage = estimateCoverageLine(quote, rs);
  const day = dayInWords(d.deadline, lang);
  const Onward = dir === 'rtl' ? ChevronLeft : ChevronRight;

  return (
    <div className="space-y-3" data-editor-review>
      <KitCard as="div" raised flush>
        <button
          type="button"
          onClick={() => onEdit({ step: 1, focus: 'editor-title' })}
          aria-label={t.heroEdit}
          className="flex min-h-20 w-full items-center gap-3 rounded-xl p-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-review-hero
        >
          {picture ? <SourceThumb kind="image" url={picture.url} size={72} alt="" /> : <SourceThumb kind={s.files.some((f) => f.kind === 'model') ? 'model' : 'document'} size={72} />}
          <span className="min-w-0 flex-1">
            <bdi className="line-clamp-2 text-[17px] font-bold text-text-primary">{s.title.trim() || t.untitledDraft}</bdi>
          </span>
          <Onward aria-hidden="true" className="h-5 w-5 shrink-0 text-text-secondary" />
        </button>
      </KitCard>

      <SectionCard title={t.filesCard} data-review-card="files" trailing={<EditLink section={t.filesCard} onClick={() => onEdit({ step: 1, focus: 'editor-attached' })} t={t} />}>
        {files.length === 0 ? (
          <p className="text-[13px] text-text-muted">{t.reviewNothing}</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {files.map((x) => {
              const f = s.files.find((y) => y.id === x.fileId);
              const kind = thumbKindOf(s, x);
              const kindWord = kind === 'model' ? t.kindModel : kind === 'image' ? t.kindPicture : kind === 'link' ? t.kindLink : t.kindDocument;
              const KindIcon = kind === 'image' ? ImageIcon : Box;
              return (
                <li key={x.key} className="flex items-center gap-3 py-2" data-review-file={kind}>
                  <SourceThumb kind={kind} url={f?.url} size={52} alt="" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-text-primary">
                      <bdi dir="ltr">{sourceName(s, x)}</bdi>
                    </span>
                    <span className="block truncate text-[13px] text-text-muted">
                      {kindWord}
                      {f && (
                        <>
                          {' · '}
                          <bdi dir="ltr">{fileMeta(f.file_name, f.size_bytes)}</bdi>
                        </>
                      )}
                      {x.original && ` · ${t.originalBadge}`}
                    </span>
                  </span>
                  <span aria-hidden="true" className="cm-raised hidden size-11 shrink-0 items-center justify-center rounded-md text-text-primary min-[400px]:flex">
                    <KindIcon className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={t.specsCard} data-review-card="specs" trailing={<EditLink section={t.specsCard} onClick={() => onEdit({ step: 2, focus: 'editor-step-2' })} t={t} />}>
        {s.parts.length === 1 ? (
          <div className="grid gap-2 min-[400px]:grid-cols-2">
            <Fact label={t.process}>{isolateLtr(facts.process)}</Fact>
            <Fact label={t.material}>{isolateLtr(facts.material)}</Fact>
            <Fact label={t.colour}>
              <span className="inline-flex items-center gap-2">
                {facts.swatch && <span aria-hidden="true" className="cm-swatch size-6 shrink-0 rounded-full" style={{ background: facts.swatch }} />}
                <bdi>{facts.colour}</bdi>
              </span>
            </Fact>
            <Fact label={t.quality}>{isolateLtr(facts.quality)}</Fact>
            <Fact label={t.quantity}>{facts.quantity}</Fact>
            <Fact label={t.sizeTitle}>
              <bdi dir="ltr">{facts.size}</bdi>
            </Fact>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-2 min-[400px]:grid-cols-2">
              <Fact label={t.quality}>{isolateLtr(facts.quality)}</Fact>
              <Fact label={t.sets}>{facts.quantity}</Fact>
            </div>
            <ul className="space-y-2">
              {s.parts.map((p, i) => {
                const size = partSize(p, s.files);
                return (
                  <li key={p.key} className="lv-well rounded-md px-3 py-2" data-review-part={i + 1}>
                    <p className="text-[15px] font-semibold text-text-primary">
                      <bdi>{p.name.trim() || fill(rs.partN, { n: i + 1 })}</bdi>
                      {p.perSet > 1 && <span className="ms-2 text-[13px] font-normal text-text-muted">×{p.perSet}</span>}
                    </p>
                    {p.materials.map((m) => (
                      <p key={m.key} className="text-[13px] text-text-secondary">
                        {isolateLtr(`${materialWords(m.materialId, lang, t, catalogue)} · ${coloursSummary(m.colours, lang, t, refName)}`)}
                      </p>
                    ))}
                    {size && (
                      <p className="text-[13px] text-text-muted">
                        <bdi dir="ltr">{sizeWords(size)}</bdi>
                      </p>
                    )}
                    {p.reviewState === 'needs_technical_review' && <p className="mt-1 text-[13px] font-semibold text-warning">{rs.reviewChip}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </SectionCard>

      <SectionCard title={t.deliveryCard} data-review-card="delivery" trailing={<EditLink section={t.deliveryCard} onClick={() => onEdit({ step: 3, focus: 'editor-governorate' })} t={t} />}>
        <div className="space-y-2">
          <Fact label={t.placeHandover} icon={<MapPin className="h-5 w-5" />}>
            {governorateWords(d.governorate, lang, t)} · {handoverWords(d.handover, t)}
          </Fact>
          <Fact label={t.neededBy} icon={<CalendarDays className="h-5 w-5" />}>
            {day ? fill(t.neededByDate, { date: day }) : t.flexibleTiming}
          </Fact>
        </div>
      </SectionCard>

      <SectionCard title={t.budgetCard} data-review-card="budget" trailing={<EditLink section={t.budgetCard} onClick={() => onEdit({ step: 3, focus: 'editor-budget' })} t={t} />}>
        <div className="space-y-2">
          <Fact label={t.yourBudget} icon={<Coins className="h-5 w-5" />}>
            {d.budget ? <bdi>{`${latinIqd(d.budget)} ${iqdUnit(lang)}`}</bdi> : t.noBudget}
          </Fact>
          {d.budget ? (
            <p className="text-[13px] text-text-secondary" data-editor-review-budget={d.budgetVisible ? 'shown' : 'hidden'}>
              {budgetLine(d, direct, t)}
            </p>
          ) : null}
          <p className="lv-well flex items-start gap-2 rounded-md px-3 py-2 text-[13px] text-text-secondary">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            {t.finalPrice}
          </p>
        </div>
      </SectionCard>

      <SectionCard title={t.reviewEstimate} data-editor-review-estimate>
        <p className="text-[17px] font-bold text-text-primary">
          <bdi>{quote?.priced ? rangeText(quote.price_low_iqd, quote.price_high_iqd, lang) : t.reviewNoEstimate}</bdi>
        </p>
        {coverage && (
          <p className="mt-1 text-[13px] font-semibold text-warning" data-editor-estimate-coverage>
            {coverage}
          </p>
        )}
      </SectionCard>

      <AudiencePanel state={s} t={t} open />

      {edit && s.liveOffers > 0 && (
        <p className="lv-alert lv-alert-warning text-[13px]" role="note">
          {fill(t.liveOffersNote, { n: s.liveOffers })}
        </p>
      )}
      {!edit && !direct && <p className="text-[13px] leading-relaxed text-text-muted">{t.privacyLine}</p>}
    </div>
  );
}
