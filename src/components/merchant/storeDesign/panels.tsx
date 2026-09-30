/**
 * THE PAGE-WIDE PANELS — the look (a preset, then each token) and the page's
 * top and bottom.
 *
 * Every choice here is an ENUM value from packages/storeLayout/src/tokens.ts
 * or schema.ts: there is no colour picker, no font field, no CSS box, and
 * that is decision 12, not a gap. A token becomes a `data-sf-*` attribute the
 * platform's own stylesheet reads (src/components/storefront/theme.ts).
 * Changing the look never touches a block, a product or a word.
 */
import { useId } from 'react';
import { Check, LayoutTemplate } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import { Button } from '../../ui/Button';
import StoreTheme from '../../storefront/StoreTheme';
import '../../storefront/styles';
import { accentFor } from '../../storefront/theme';
import { AccentSample } from '../AccentSample';
import { FOOTER_VARIANTS, HEADER_VARIANTS, type StoreLayout } from '../../../../packages/storeLayout/src/schema';
import { THEME_NAMES, THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES, type ThemeName, type ThemeTokens } from '../../../../packages/storeLayout/src/tokens';
import { FOOTER_COPY, HEADER_COPY, say, THEME_COPY, TOKEN_COPY, TOKEN_VALUE_COPY } from './catalog';
import { setFooter, setHeader, setPreset, setToken } from './editorModel';
// The Page panel's own fields (P5, storefront L4/L6/L7, B2): the notice line, the footer links, the background.
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { BACKGROUND_MEDIA, FOOTER_LINKS_SPEC, HEADER_FIELDS, MAX_FOOTER_LINKS } from '../../../../packages/storeLayout/src/blocks';
import {
  BACKGROUND_DIMS,
  BACKGROUND_KINDS,
  type BackgroundDim,
  type BackgroundKind,
  type FooterLink,
  type StoreBackground,
} from '../../../../packages/storeLayout/src/schema';
import { EMPTY_TEXT, type LocalizedText } from '../../../../packages/storeLayout/src/text';
import { NO_LINK, type LinkTarget } from '../../../../packages/storeLayout/src/refs';
import type { LayoutIssue } from '../../../../packages/storeLayout/src/normalize';
import type { ChangeSummary, FieldIssue } from './editorModel';
import { SettingControl } from './fields';
import { useMediaStrings, type MediaStrings } from './strings';

// ----------------------------------------------------------- the swatch

/** A small, faithful sample of a preset: its ground, a card, a product tile and the accent. */
export function ThemeSwatch({ tokens, storeAccent, className = 'h-16' }: { tokens: ThemeTokens; storeAccent: unknown; className?: string }) {
  return (
    <StoreTheme tokens={tokens} storeAccent={storeAccent} className={`relative w-full overflow-hidden rounded-lg border border-white/10 p-2 ${className}`}>
      <SwatchBody accent={accentFor(tokens, storeAccent).classes.indicator} />
    </StoreTheme>
  );
}

function SwatchBody({ accent }: { accent: string }) {
  return (
    <div className="flex h-full gap-1.5" aria-hidden="true">
      <div className="sf-tile h-full w-8">
        <div className="sf-well h-2/3" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="sf-card h-5" />
        <div className="sf-card flex h-5 items-center px-1.5">
          <span className={`h-1.5 w-6 rounded-full ${accent}`} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ choices

/** A radio group of chips that wraps — for token lists too long for one pill. */
export function ChoiceChips<T extends string>({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  render?: (v: T) => React.ReactNode;
}) {
  const id = useId();
  const move = (e: React.KeyboardEvent, i: number) => {
    const rtl = document.dir === 'rtl' || document.documentElement.dir === 'rtl';
    const fwd = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    if (!fwd && !back) return;
    e.preventDefault();
    const j = (i + (fwd ? 1 : -1) + options.length) % options.length;
    onChange(options[j]);
    requestAnimationFrame(() => document.getElementById(`${id}-${j}`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o, i) => {
        const on = o === value;
        return (
          <button
            key={o}
            id={`${id}-${i}`}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o)}
            onKeyDown={(e) => move(e, i)}
            className="lv-choice inline-flex min-h-10 items-center gap-1.5 px-3 text-[12.5px] font-medium"
          >
            {render ? render(o) : o}
            {on && <Check className="h-3.5 w-3.5 text-gold" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ theme

export function ThemePanel({
  layout,
  storeAccent,
  onChange,
  onStarter,
}: {
  layout: StoreLayout;
  storeAccent: unknown;
  onChange: (l: StoreLayout) => void;
  onStarter: () => void;
}) {
  const { loc } = useLanguage();
  const word = (v: string | number) => say(loc, TOKEN_VALUE_COPY[String(v)], String(v));
  const presetMatches = TOKEN_KEYS.every((k) => layout.tokens[k] === THEME_PRESETS[layout.theme][k]);

  return (
    <div className="space-y-6" data-sd-theme>
      <section aria-labelledby="sd-presets" className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 id="sd-presets" className="text-[13px] font-bold text-text-primary">
            {loc('النمط', 'Style')}
          </h3>
          {!presetMatches && <span className="text-[11.5px] text-text-muted">{loc('— معدّل', '— adjusted')}</span>}
        </div>
        <p className="text-[12px] leading-relaxed text-text-muted">{loc('يغيّر الألوان والأشكال فقط — أقسامك ومحتواها كما هي.', 'Changes colours and shapes only — your sections and their content stay.')}</p>
        <div role="radiogroup" aria-labelledby="sd-presets" className="grid grid-cols-2 gap-2">
          {THEME_NAMES.map((t) => {
            const selected = layout.theme === t;
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={selected}
                data-sd-preset={t}
                onClick={() => onChange(setPreset(layout, t))}
                className="lv-choice flex flex-col gap-2 p-2.5 text-start"
              >
                <ThemeSwatch tokens={THEME_PRESETS[t]} storeAccent={storeAccent} />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-bold text-text-primary">{say(loc, THEME_COPY[t].name)}</span>
                  <span className="line-clamp-2 block text-[11px] leading-snug text-text-muted">{say(loc, THEME_COPY[t].line)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" icon={<LayoutTemplate className="h-4 w-4" aria-hidden="true" />} onClick={onStarter}>
          {loc('ابدأ من قالب كامل…', 'Start from a full template…')}
        </Button>
      </section>

      <section aria-labelledby="sd-tokens" className="space-y-4">
        <h3 id="sd-tokens" className="text-[13px] font-bold text-text-primary">
          {loc('التفاصيل', 'Details')}
        </h3>
        {TOKEN_KEYS.map((key) => {
          const values = TOKEN_VALUES[key] as readonly (string | number)[];
          const label = say(loc, TOKEN_COPY[key]);
          const current = layout.tokens[key];
          const set = (v: string | number) => onChange(setToken(layout, key, (key === 'grid_columns' ? Number(v) : v) as ThemeTokens[typeof key]));
          return (
            <div key={key} className="space-y-1.5" data-sd-token={key}>
              <p className="text-[12.5px] font-medium text-text-secondary">{label}</p>
              {key === 'accent' ? (
                <ChoiceChips
                  label={label}
                  value={String(current)}
                  options={values.map(String)}
                  onChange={set}
                  render={(v) => (
                    <>
                      {/* The colour as the page wears it, in a store island: a bare
                          dot took the app's light theme and could not tell the
                          three gold-dotted presets apart. */}
                      <AccentSample accent={v === 'store' ? (accentFor({ ...layout.tokens, accent: 'store' }, storeAccent).name ?? 'default') : v} />
                      {word(v)}
                    </>
                  )}
                />
              ) : values.length <= 3 ? (
                <Segmented size="sm" group={`sd-token-${key}`} label={label} value={String(current)} onChange={set} items={values.map((v) => ({ id: String(v), label: word(v) }))} />
              ) : (
                <ChoiceChips label={label} value={String(current)} options={values.map(String)} onChange={set} render={(v) => word(v)} />
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

// ------------------------------------------------------------ page

// ------------------------------------------------------ page-level edits

/** The notice line's words (L6); blank in every language = no bar. */
export function setNotice(layout: StoreLayout, notice: LocalizedText): StoreLayout {
  return { ...layout, header: { ...layout.header, notice: { ...EMPTY_TEXT, ...notice } } };
}

/** Where the notice goes when tapped. */
export function setNoticeLink(layout: StoreLayout, link: LinkTarget): StoreLayout {
  return { ...layout, header: { ...layout.header, notice_link: link } };
}

/** The notice's window: a bound set to '' is taken away (absent = no bound), as the normaliser writes it. */
export function setNoticeWindow(layout: StoreLayout, patch: { from?: string; until?: string }): StoreLayout {
  const header = { ...layout.header };
  if (patch.from !== undefined) {
    if (patch.from) header.notice_from = patch.from;
    else delete header.notice_from;
  }
  if (patch.until !== undefined) {
    if (patch.until) header.notice_until = patch.until;
    else delete header.notice_until;
  }
  return { ...layout, header };
}

/** The footer links (L7), never more than the schema keeps. */
export function setFooterLinks(layout: StoreLayout, links: readonly FooterLink[]): StoreLayout {
  return { ...layout, footer: { ...layout.footer, links: links.slice(0, MAX_FOOTER_LINKS).map((l) => ({ label: { ...EMPTY_TEXT, ...l.label }, link: l.link })) } };
}

export function addFooterLink(layout: StoreLayout): StoreLayout {
  if (layout.footer.links.length >= MAX_FOOTER_LINKS) return layout;
  return setFooterLinks(layout, [...layout.footer.links, { label: { ...EMPTY_TEXT }, link: { ...NO_LINK } }]);
}

export function moveFooterLink(layout: StoreLayout, index: number, delta: -1 | 1): StoreLayout {
  const links = [...layout.footer.links];
  const j = index + delta;
  if (index < 0 || index >= links.length || j < 0 || j >= links.length) return layout;
  [links[index], links[j]] = [links[j], links[index]];
  return setFooterLinks(layout, links);
}

export function removeFooterLink(layout: StoreLayout, index: number): StoreLayout {
  if (index < 0 || index >= layout.footer.links.length) return layout;
  return setFooterLinks(layout, layout.footer.links.filter((_, i) => i !== index));
}

/**
 * The page background (L4). Changing the KIND clears the file (a picture's key
 * under «video» would be refused as the wrong kind, and the reverse), and a
 * poster lives only beside a video — the same rules the normaliser applies,
 * so what the panel holds is what will be saved.
 */
export function setBackground(layout: StoreLayout, patch: Partial<StoreBackground>): StoreLayout {
  const cur = layout.background;
  const kind: BackgroundKind = patch.kind && (BACKGROUND_KINDS as readonly string[]).includes(patch.kind) ? patch.kind : cur.kind;
  const kindChanged = kind !== cur.kind;
  const media = kind === 'none' ? '' : patch.media !== undefined ? patch.media : kindChanged ? '' : cur.media;
  const poster = kind !== 'video' ? '' : patch.poster !== undefined ? patch.poster : kindChanged ? '' : cur.poster;
  const dim: BackgroundDim = patch.dim && (BACKGROUND_DIMS as readonly string[]).includes(patch.dim) ? patch.dim : cur.dim;
  const phones = typeof patch.phones === 'boolean' ? patch.phones : cur.phones;
  return { ...layout, background: { kind, media, poster, dim, phones } };
}

/**
 * What publishing would change, with the page's own keys counted.
 * `summarizeChanges` (editorModel.ts) compares the header and footer VARIANTS
 * only, so a draft whose only change is its notice, its footer links or its
 * background read «nothing to publish» and the Publish button stayed off. A
 * notice or window counts as the header; the links as the footer; the
 * background — which ChangeList has no row for yet — as the header too, so the
 * dialog lists something rather than «no changes».
 */
export function withPageChanges(changes: ChangeSummary | null, live: StoreLayout, next: StoreLayout): ChangeSummary | null {
  if (!changes) return changes;
  const header = changes.header || JSON.stringify(live.header) !== JSON.stringify(next.header);
  const footer = changes.footer || JSON.stringify(live.footer) !== JSON.stringify(next.footer);
  const background = JSON.stringify(live.background ?? null) !== JSON.stringify(next.background ?? null);
  if (header === changes.header && footer === changes.footer && !background) return changes;
  return { ...changes, header: header || background, footer, none: false };
}

/** The gate's issues about one part of the page (`header`, `footer`, `background`), as the field kit reads them. */
export function pageIssues(page: readonly LayoutIssue[], prefix: string): FieldIssue[] {
  return page
    .filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))
    .map((i) => ({ ...i, field: i.path === prefix ? '' : i.path.slice(prefix.length + 1) }));
}

const under = (issues: readonly FieldIssue[], field: string) =>
  issues
    .filter((i) => i.field === field || i.field.startsWith(`${field}.`) || i.field.startsWith(`${field}[`))
    .map((i) => ({ ...i, field: i.field === field ? '' : i.field.slice(field.length + 1).replace(/^\./, '') }));

/** Before `until`, or no window at all. */
function outOfOrder(from: string | undefined, until: string | undefined): boolean {
  return !!from && !!until && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(until)) && Date.parse(until) <= Date.parse(from);
}

// ------------------------------------------------------------ page

export function PagePanel({
  layout,
  onChange,
  page = [],
}: {
  layout: StoreLayout;
  /** `key` coalesces keystrokes into one undo step. */
  onChange: (l: StoreLayout, key?: string | null) => void;
  /** The gate's issues about the page itself (Validation.page). */
  page?: readonly LayoutIssue[];
}) {
  const { loc } = useLanguage();
  const t = useMediaStrings();
  return (
    <div className="space-y-6" data-sd-page>
      <VariantCards
        title={loc('رأس الصفحة', 'Page header')}
        value={layout.header.variant}
        options={HEADER_VARIANTS}
        copy={HEADER_COPY}
        onChange={(v) => onChange(setHeader(layout, v))}
      />
      <NoticeFields layout={layout} onChange={onChange} issues={pageIssues(page, 'header')} t={t} />
      <VariantCards
        title={loc('تذييل الصفحة', 'Page footer')}
        value={layout.footer.variant}
        options={FOOTER_VARIANTS}
        copy={FOOTER_COPY}
        onChange={(v) => onChange(setFooter(layout, v))}
      />
      <FooterLinkFields layout={layout} onChange={onChange} issues={pageIssues(page, 'footer')} t={t} />
      <BackgroundFields layout={layout} onChange={onChange} issues={pageIssues(page, 'background')} t={t} />
      <p className="text-[12px] leading-relaxed text-text-muted">
        {loc(
          'اسم المتجر وشعاره وغلافه ووصفه وروابطه تُعدَّل من «إعدادات المتجر»، فتبقى واحدة في كل مكان.',
          'Your store name, logo, cover, description and links are edited in «Store settings», so they stay the same everywhere.'
        )}
      </p>
    </div>
  );
}

type PartProps = { layout: StoreLayout; onChange: (l: StoreLayout, key?: string | null) => void; issues: FieldIssue[]; t: MediaStrings };

/** «شريط الإعلان» (L6): the words, where they go, and when they show. */
function NoticeFields({ layout, onChange, issues, t }: PartProps) {
  const id = useId();
  const h = layout.header;
  const bad = outOfOrder(h.notice_from, h.notice_until);
  return (
    <section aria-labelledby={id} className="space-y-3" data-sd-notice>
      <h3 id={id} className="text-[13px] font-bold text-text-primary">
        {t.page.notice}
      </h3>
      <SettingControl
        name="notice"
        spec={HEADER_FIELDS.notice}
        value={h.notice}
        path="page.header.notice"
        issues={under(issues, 'notice')}
        label={t.page.noticeText}
        hint={t.page.noticeHint}
        onChange={(v, k) => onChange(setNotice(layout, v as LocalizedText), k ?? null)}
      />
      <SettingControl
        name="notice_link"
        spec={HEADER_FIELDS.notice_link}
        value={h.notice_link}
        path="page.header.notice_link"
        issues={under(issues, 'notice_link')}
        label={t.page.noticeLink}
        onChange={(v, k) => onChange(setNoticeLink(layout, v as LinkTarget), k ?? null)}
      />
      {/* One under the other: the panel is a narrow column at every width, and a date-and-time field needs its whole line. */}
      <div className="grid gap-3">
        <SettingControl
          name="notice_from"
          spec={{ t: 'date' }}
          value={h.notice_from ?? ''}
          path="page.header.notice_from"
          issues={[]}
          label={t.page.from}
          onChange={(v) => onChange(setNoticeWindow(layout, { from: typeof v === 'string' ? v : '' }))}
        />
        <SettingControl
          name="notice_until"
          spec={{ t: 'date' }}
          value={h.notice_until ?? ''}
          path="page.header.notice_until"
          issues={[]}
          label={t.page.until}
          onChange={(v) => onChange(setNoticeWindow(layout, { until: typeof v === 'string' ? v : '' }))}
        />
      </div>
      {bad ? (
        <p className="lv-field-error" data-sd-notice-order>
          {t.page.windowOrder}
        </p>
      ) : (
        <p className="text-[12px] text-text-muted">{t.page.windowHint}</p>
      )}
    </section>
  );
}

/** «روابط التذييل» (L7): up to six, each a label and a destination, in the merchant's order. */
function FooterLinkFields({ layout, onChange, issues, t }: PartProps) {
  const id = useId();
  const links = layout.footer.links;
  return (
    <section aria-labelledby={id} className="space-y-2" data-sd-footer-links>
      <div className="flex items-center gap-2">
        <h3 id={id} className="text-[13px] font-bold text-text-primary">
          {t.page.links}
        </h3>
        <span className="ms-auto text-[12px] tabular-nums text-text-muted" dir="ltr">
          {links.length}/{MAX_FOOTER_LINKS}
        </span>
      </div>
      {layout.footer.variant === 'none' && links.length > 0 && <p className="text-[12px] text-warning">{t.page.linksNone}</p>}
      {links.map((l, i) => {
        const at = `links[${i}]`;
        const mine = under(issues, at);
        const blank = !l.label.ar.trim() && !l.label.en.trim() && !l.label.ckb.trim();
        return (
          <div key={i} className="space-y-3 rounded-xl border border-border-subtle p-3" data-sd-footer-link={i}>
            <div className="flex items-center gap-1">
              <span className="text-[12px] font-semibold tabular-nums text-text-muted">{i + 1}</span>
              <span className="ms-auto flex">
                <IconButton icon={<ArrowUp className="h-4 w-4" />} label={t.page.moveUp} disabled={i === 0} onClick={() => onChange(moveFooterLink(layout, i, -1))} />
                <IconButton icon={<ArrowDown className="h-4 w-4" />} label={t.page.moveDown} disabled={i === links.length - 1} onClick={() => onChange(moveFooterLink(layout, i, 1))} />
                <IconButton icon={<Trash2 className="h-4 w-4" />} label={t.page.removeLink} onClick={() => onChange(removeFooterLink(layout, i))} />
              </span>
            </div>
            <SettingControl
              name="label"
              spec={FOOTER_LINKS_SPEC.item.label}
              value={l.label}
              path={`page.footer.${at}.label`}
              issues={under(mine, 'label')}
              label={t.page.linkLabel}
              onChange={(v, k) => onChange(setFooterLinks(layout, links.map((x, j) => (j === i ? { ...x, label: v as LocalizedText } : x))), k ?? null)}
            />
            <SettingControl
              name="link"
              spec={FOOTER_LINKS_SPEC.item.link}
              value={l.link}
              path={`page.footer.${at}.link`}
              issues={under(mine, 'link')}
              label={t.page.linkTarget}
              onChange={(v, k) => onChange(setFooterLinks(layout, links.map((x, j) => (j === i ? { ...x, link: v as LinkTarget } : x))), k ?? null)}
            />
            {blank && <p className="text-[12px] text-warning">{t.page.linkIncomplete}</p>}
          </div>
        );
      })}
      {links.length < MAX_FOOTER_LINKS && (
        <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => onChange(addFooterLink(layout))} data-sd-add-footer-link>
          {t.page.addLink}
        </Button>
      )}
    </section>
  );
}

/** «الخلفية» (L4): the kind, its file (and a video's poster), the dim, and whether phones play the video. */
function BackgroundFields({ layout, onChange, issues, t }: PartProps) {
  const id = useId();
  const bg = layout.background;
  const set = (patch: Partial<StoreBackground>) => onChange(setBackground(layout, patch));
  return (
    <section aria-labelledby={id} className="space-y-3" data-sd-background={bg.kind}>
      <h3 id={id} className="text-[13px] font-bold text-text-primary">
        {t.page.background}
      </h3>
      <p className="text-[12px] leading-relaxed text-text-muted">{t.page.backgroundHint}</p>
      <Segmented
        size="sm"
        group="sd-bg-kind"
        label={t.page.kindLabel}
        value={bg.kind}
        onChange={(v) => set({ kind: v as BackgroundKind })}
        items={BACKGROUND_KINDS.map((k) => ({ id: k, label: t.page.kind[k] }))}
      />
      {bg.kind === 'image' && (
        <SettingControl
          name="media"
          spec={BACKGROUND_MEDIA.image}
          value={bg.media}
          path="page.background.media"
          issues={under(issues, 'media')}
          label={t.page.image}
          hint={t.page.imageHint}
          onChange={(v) => set({ media: typeof v === 'string' ? v : '' })}
        />
      )}
      {bg.kind === 'video' && (
        <>
          <SettingControl
            name="media"
            spec={BACKGROUND_MEDIA.video}
            value={bg.media}
            path="page.background.media"
            issues={under(issues, 'media')}
            label={t.page.video}
            poster={{ value: bg.poster, maxBytes: BACKGROUND_MEDIA.poster.max_bytes, setBoth: (media, poster) => set({ media, poster }) }}
            onChange={(v) => set({ media: typeof v === 'string' ? v : '' })}
          />
          <SettingControl
            name="poster"
            spec={BACKGROUND_MEDIA.poster}
            value={bg.poster}
            path="page.background.poster"
            issues={under(issues, 'poster')}
            label={t.page.poster}
            hint={t.page.posterHint}
            onChange={(v) => set({ poster: typeof v === 'string' ? v : '' })}
          />
          {bg.media && !bg.poster && (
            <p className="lv-field-error" data-sd-poster-required>
              {t.library.posterRequired}
            </p>
          )}
          <Switch checked={bg.phones} onChange={(v) => set({ phones: v })} label={t.page.phones} description={t.page.phonesHint} />
        </>
      )}
      {bg.kind !== 'none' && (
        <div className="space-y-1.5">
          <p className="text-[12.5px] font-medium text-text-secondary">{t.page.dim}</p>
          <Segmented
            size="sm"
            group="sd-bg-dim"
            label={t.page.dim}
            value={bg.dim}
            onChange={(v) => set({ dim: v as BackgroundDim })}
            items={BACKGROUND_DIMS.map((d) => ({ id: d, label: t.page.dims[d] }))}
          />
        </div>
      )}
    </section>
  );
}

function VariantCards<T extends string>({
  title,
  value,
  options,
  copy,
  onChange,
}: {
  title: string;
  value: T;
  options: readonly T[];
  copy: Record<T, { name: readonly [string, string]; line: readonly [string, string] }>;
  onChange: (v: T) => void;
}) {
  const { loc } = useLanguage();
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-[13px] font-bold text-text-primary">
        {title}
      </h3>
      <div role="radiogroup" aria-labelledby={id} className="space-y-1.5">
        {options.map((o) => {
          const on = o === value;
          return (
            <button key={o} type="button" role="radio" aria-checked={on} onClick={() => onChange(o)} className="lv-choice flex w-full items-center gap-3 px-3 py-2.5 text-start">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-text-primary">{say(loc, copy[o].name)}</span>
                <span className="block text-[11.5px] text-text-muted">{say(loc, copy[o].line)}</span>
              </span>
              {on && <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export type { ThemeName };
