/**
 * THE LAST LOOK BEFORE IT GOES OUT (plan P1-06; design §8, critique 5, 6).
 *
 * A tall sheet with what the merchants will read — the title and the
 * description, the pictures as pictures (`data-review-thumb`), the links as
 * their cards, every part with its materials, colours and size — and the
 * button in the sheet’s own footer: «انشر» for a draft, «احفظ التعديلات»
 * for a published request (which warns first when standing offers would
 * pause). A request for one store is SENT, not published: «أرسل إلى
 * {store}» opens its conversation and lands its card there
 * (`POST /print/requests/:id/send`). While a file is still uploading the
 * button waits, and says so.
 *
 * Before the button: the delivery and the budget as they will go out (the
 * budget's switch in words), the estimate with what it covers, and «ما يراه
 * الآخرون» OPEN — what becomes public and what stays private
 * (`17.public-private-preview`).
 */
import type { ReactNode } from 'react';
import { Sheet } from '../../../ui/Sheet';
import { useSheetPlacement } from './useKeyboardOpen';
import { Button } from '../../../ui/Button';
import BidiText, { bidiContent } from '../../../ui/BidiText';
import { SourceLinkCard } from '../../links/LinkCard';
import { RequestThumb } from '../RequestFileThumbs';
import { estimateCoverageLine, requestStrings } from '../strings';
import type { CatalogMaterial, Quote } from '../api';
import { GOVERNORATES } from '../../../../lib/governorates';
import { iqdNumber, iqdUnit } from '../../../../lib/money';
import { AudiencePanel } from './AudiencePanel';
import { rangeText } from './estimate';
import { colourWords, materialWords } from './MaterialRow';
import { dimsText, partSize } from './PartCard';
import { isPublishedEdit, type EditorState } from './state';
import { fill, type EditorLang, type EditorStrings } from './strings';

export function ReviewSheet({
  open,
  onClose,
  state,
  catalogue,
  refName,
  working,
  busy,
  error,
  onPublish,
  quote,
  lang,
  t,
}: {
  open: boolean;
  onClose: () => void;
  state: EditorState;
  catalogue: readonly CatalogMaterial[];
  refName: (key: string) => string;
  working: number;
  busy: boolean;
  error: string;
  onPublish: () => void;
  /** The last estimate of the body as it stands. */
  quote: Quote | null;
  lang: EditorLang;
  t: EditorStrings;
}) {
  const sheetPlacement = useSheetPlacement();
  const rs = requestStrings(lang);
  const edit = isPublishedEdit(state);
  const direct = !!state.direct;
  const pictures = state.files.filter((f) => f.inline);
  const links = state.sources.filter((x) => x.kind === 'link');
  const label = edit ? t.saveChanges : direct ? fill(t.sendTo, { store: state.direct!.store_name }) : t.publish;
  const d = state.delivery ?? state.carried;
  const gov = GOVERNORATES.find((g) => g.id === d.governorate);
  const handover = d.handover === 'delivery' ? t.handoverDelivery : d.handover === 'pickup' ? t.handoverPickup : t.handoverEither;
  const coverage = estimateCoverageLine(quote, rs);
  const facts: Array<[string, ReactNode]> = [
    [t.governorate, gov ? gov[lang] : t.notSet],
    [t.handover, handover],
    ...(d.deadline ? ([[t.deadline, <bdi key="d" dir="ltr">{d.deadline}</bdi>]] as Array<[string, ReactNode]>) : []),
    ...(d.budget ? ([[t.budget, `${iqdNumber(d.budget, lang)} ${iqdUnit(lang)}`]] as Array<[string, ReactNode]>) : []),
  ];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={edit ? t.reviewEditTitle : t.reviewTitle}
      {...sheetPlacement}
      detents={['large']}
      testId="editor-review"
      header={<h2 className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary">{edit ? t.reviewEditTitle : t.reviewTitle}</h2>}
      footer={
        <div className="space-y-2 px-4 pb-3 pt-2">
          {error && (
            <p className="lv-field-error" role="alert" data-editor-review-error>
              {error}
            </p>
          )}
          {working > 0 && <p className="text-[12px] text-text-muted">{fill(t.waitUploads, { n: working })}</p>}
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="shrink-0" onClick={onClose}>
              {t.backToEdit}
            </Button>
            <Button variant="primary" className="min-w-0 flex-1" loading={busy} disabled={working > 0} onClick={onPublish} data-editor={direct && !edit ? 'send' : 'publish'}>
              <span className="truncate">
                <bdi>{label}</bdi>
              </span>
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-4 pb-4" data-editor-review>
        <section className="space-y-1">
          <BidiText as="p" text={state.title || '—'} className="text-[15px] font-bold text-text-primary" />
          <BidiText as="div" multiline text={state.description || '—'} className="text-[13px] leading-relaxed text-text-secondary" />
        </section>

        {(pictures.length > 0 || links.length > 0) && (
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text-secondary">{t.reviewSources}</h3>
            {pictures.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label={t.picturesLabel}>
                {pictures.map((f) => (
                  <li key={f.id} data-review-thumb>
                    <RequestThumb url={f.url} size={56} alt={f.file_name} />
                  </li>
                ))}
              </ul>
            )}
            {links.map((x) => (
              <SourceLinkCard key={x.key} url={x.canonical || x.url} />
            ))}
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-[13px] font-semibold text-text-secondary">{t.reviewParts}</h3>
          <ul className="space-y-2">
            {state.parts.map((p, i) => {
              const size = partSize(p, state.files);
              return (
                <li key={p.key} className="lv-surface px-3 py-2" data-review-part={i + 1}>
                  <p className="text-[13.5px] font-semibold text-text-primary">
                    <bdi>{p.name.trim() || fill(rs.partN, { n: i + 1 })}</bdi>
                    {p.perSet > 1 && <span className="ms-2 text-[12px] font-normal text-text-muted">×{p.perSet}</span>}
                  </p>
                  {p.materials.map((m) => (
                    <p key={m.key} className="text-[12.5px] text-text-secondary">
                      {bidiContent(`${materialWords(m.materialId, lang, t, catalogue)} · ${m.colours.map((c) => colourWords(c, lang, t, refName)).join('، ')}`)}
                    </p>
                  ))}
                  {size && <p className="text-[12px] text-text-muted">{bidiContent(fill(t.measured, { dims: dimsText(size) }))}</p>}
                  {p.reviewState === 'needs_technical_review' && <p className="mt-1 text-[12px] font-semibold text-warning">{rs.reviewChip}</p>}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-1" data-editor-review-delivery>
          <h3 className="text-[13px] font-semibold text-text-secondary">{t.reviewDelivery}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-text-muted">{k}</dt>
                <dd className="text-text-primary">{v}</dd>
              </div>
            ))}
          </dl>
          {d.budget ? (
            <p className="text-[12.5px] text-text-secondary" data-editor-review-budget={d.budgetVisible ? 'shown' : 'hidden'}>
              {!d.budgetVisible ? t.budgetOff : direct ? t.budgetOnDirect : t.budgetOn}
            </p>
          ) : null}
        </section>

        <section className="space-y-1" data-editor-review-estimate>
          <h3 className="text-[13px] font-semibold text-text-secondary">{t.reviewEstimate}</h3>
          <p className="text-[14px] font-semibold text-text-primary">
            <bdi>{quote?.priced ? rangeText(quote.price_low_iqd, quote.price_high_iqd, lang) : t.reviewNoEstimate}</bdi>
          </p>
          {coverage && (
            <p className="text-[12px] font-semibold text-warning" data-editor-estimate-coverage>
              {coverage}
            </p>
          )}
        </section>

        <AudiencePanel state={state} t={t} open />

        {edit && state.liveOffers > 0 && (
          <p className="lv-alert lv-alert-warning text-[12.5px]" role="note">
            {fill(t.liveOffersNote, { n: state.liveOffers })}
          </p>
        )}
        {!edit && !direct && <p className="text-[12px] leading-relaxed text-text-muted">{t.privacyLine}</p>}
      </div>
    </Sheet>
  );
}
