/**
 * الحزم — the bundles panel (docs/BUNDLES_MYSTERY.md §11.1).
 *
 * A bundle is a real `products` row carrying `composition = 'bundle'`: it has
 * its own ar/en/ckb title, slug, cover, status, display order and price
 * ladder, and its availability is COMPUTED from the members' real inventory.
 *
 * Three rules shape this screen, and all three are about not lying:
 *
 *   NOTHING IS COMPUTED HERE. The component value, the saving, `max_bundles`,
 *   the blocking component and every warning arrive from the server, from the
 *   same functions the storefront, the cart and the door use. A number this
 *   panel calculated could disagree with the one a customer is charged, and
 *   the only way to guarantee it never does is to never calculate one.
 *
 *   NOTHING IS SILENTLY REPAIRED. A refusal is shown verbatim, line by line,
 *   in the admin's own language, with the component it belongs to named. The
 *   panel never "fixes" a discount, a price or a shipping mix and saves
 *   anyway.
 *
 *   WARNINGS SURVIVE A SUCCESSFUL SAVE. They stay on the screen after the
 *   green line, the way the product form keeps its own — a warning that
 *   disappears with the save it belongs to was never read.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
  ImagePlus,
  Sparkles,
  Star,
  Minus,
  ChevronDown,
  Pencil,
} from 'lucide-react';
import * as T from '../adminProducts/theme';
import '../adminProducts/theme.css';
import { api, ApiError, formatIqd, uploadFile, failureText } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import {
  Banner,
  Field,
  Grid,
  Money,
  Qty,
  SectionCard,
  Select,
  TextInput,
  Toggle,
  btnGhost,
  btnPrimary,
  btnDanger,
} from '../adminProducts/form/formUi';
import { TriText } from '../adminProducts/ui';
import ProductPicker from '../adminProducts/form/ProductPicker';
import VariantImg from '../ui/VariantImg';
import CompositionPricing from './CompositionPricing';
import { bundleCover, bundleText, loadMember, type CoverTile, type LineColour, type MemberInfo } from './bundleAutofill';
import type { PickerProduct } from '../adminProducts/form/ProductPicker';

// ------------------------------------------------------------------- types

/** One admin-facing line, exactly as the server sends it (§11.3). */
interface BundleIssue {
  code: string;
  message: string;
  key?: string;
  line?: number;
  ar: string;
  en: string;
  ckb: string;
  component_id?: string;
}

interface ComponentInput {
  id?: string;
  member_product_id: string;
  qty: number;
  optional: boolean;
  option_value_ids: string[];
  color_id: string;
  customer_picks_option: boolean;
  customer_picks_color: boolean;
  /** «لون عشوائي» (0241): the store picks the colour from stock. */
  random_color: boolean;
  sort: number;
  choice_option_value_ids: string[];
  choice_color_ids: string[];
}

interface ConfigInput {
  price_mode: 'fixed' | 'discount_percent' | 'discount_iqd';
  discount_percent: number | null;
  discount_iqd: number | null;
  min_price_iqd: number;
  plus_price_iqd: number | null;
  max_qty_per_order: number;
}

interface OfferInput {
  starts_at: string | null;
  ends_at: string | null;
  required_tiers: string[];
  offer_price_mode: '' | 'fixed' | 'discount_percent' | 'discount_iqd';
  offer_price_iqd: number | null;
  discount_percent: number | null;
  discount_iqd: number | null;
  plus_price_iqd: number | null;
  locked_preview: boolean;
  active: boolean;
  max_per_user: number | null;
  max_global: number | null;
}

interface ComponentPreview {
  component_id: string;
  member_product_id: string;
  name: string;
  qty_per_bundle: number;
  optional: boolean;
  unit_iqd: number;
  line_value_iqd: number;
  available: number | null;
  shipping_type: string;
}

interface Preview {
  component_total_iqd: number;
  bundle_price_iqd: number;
  regular_iqd: number;
  prime_iqd: number | null;
  pro_iqd: number | null;
  plus_iqd: number | null;
  discount_iqd: number;
  saving_percent: number;
  availability: {
    state: string;
    max_bundles: number | null;
    shipping_type: string;
    modes: string[];
    blocking: Array<{ component_id: string; product_id: string; available: number; needed: number; reason: string }>;
  };
  components: ComponentPreview[];
}

interface BundleCard {
  id: string;
  slug: string;
  status: string;
  kind: string;
  name: string;
  name_ar: string;
  name_ku: string;
  image: string;
  display_order: number;
  price_iqd: number;
  component_count: number;
  component_total_iqd: number;
  bundle_price_iqd: number;
  saving_percent: number;
  max_bundles: number | null;
  availability_state: string;
  offer: OfferInput | null;
  /** No complete Pricing V2 write yet (DECISIONS row 251): hidden from customers, «يحتاج تسعيرًا». */
  needs_pricing?: boolean;
  warnings: string[];
  warning_details: BundleIssue[];
}

interface EditorDoc {
  id: string | null;
  slug: string;
  status: 'draft' | 'active' | 'hidden';
  name_ar: string;
  name_en: string;
  name_ckb: string;
  description_ar: string;
  description_en: string;
  description_ckb: string;
  price_iqd: number;
  original_price_iqd: number | null;
  prime_price_iqd: number | null;
  pro_price_iqd: number | null;
  display_order: number;
  is_featured: boolean;
  images: string[];
  updated_at: string;
}

interface RelationsRow {
  values: Array<{ id: string; name_en: string; name_ar?: string; group_id: string; active: number | boolean }>;
  colors: Array<{ id: string; name_en: string; name_ar?: string; name_ckb?: string; hex?: string; image?: string; active: number | boolean }>;
}

/** «لون عشوائي» drawn as a rainbow, the same as on the cover. */
const RAINBOW = 'conic-gradient(#FF3B30, #FF9500, #FFCC00, #34C759, #00C7BE, #007AFF, #AF52DE, #FF2D55, #FF3B30)';

// ------------------------------------------------------------------ helpers

const TIERS = ['plus', 'prime', 'pro'] as const;
const STATES: Record<string, { ar: string; en: string; ckb: string; tone: 'ok' | 'warn' | 'bad' }> = {
  in_stock: { ar: 'متوفرة', en: 'In stock', ckb: 'بەردەستە', tone: 'ok' },
  member_exclusive: { ar: 'حصرية للمشتركين', en: 'Members only', ckb: 'تەنها ئەندامان', tone: 'ok' },
  low: { ar: 'كمية قليلة', en: 'Low', ckb: 'کەمە', tone: 'warn' },
  ending_soon: { ar: 'تنتهي قريبًا', en: 'Ending soon', ckb: 'بەم زووانە کۆتایی دێت', tone: 'warn' },
  preorder: { ar: 'طلب مسبق', en: 'Pre-order', ckb: 'پێش-داواکاری', tone: 'ok' },
  upcoming: { ar: 'لم تبدأ بعد', en: 'Upcoming', ckb: 'هێشتا دەستی پێنەکردووە', tone: 'warn' },
  sold_out: { ar: 'نفدت', en: 'Sold out', ckb: 'تەواو بوو', tone: 'bad' },
  ended: { ar: 'منتهية', en: 'Ended', ckb: 'کۆتایی هات', tone: 'bad' },
  locked: { ar: 'مقفلة', en: 'Locked', ckb: 'داخراوە', tone: 'warn' },
  unconfigured: { ar: 'غير مكتملة', en: 'Not configured', ckb: 'ڕێکنەخراوە', tone: 'bad' },
};

const blankDoc = (): EditorDoc => ({
  id: null,
  slug: '',
  status: 'draft',
  name_ar: '',
  name_en: '',
  name_ckb: '',
  description_ar: '',
  description_en: '',
  description_ckb: '',
  price_iqd: 0,
  original_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  display_order: 0,
  is_featured: false,
  images: [],
  updated_at: '',
});

const blankConfig = (): ConfigInput => ({
  price_mode: 'fixed',
  discount_percent: null,
  discount_iqd: null,
  min_price_iqd: 1,
  plus_price_iqd: null,
  max_qty_per_order: 5,
});

const blankComponent = (sort: number): ComponentInput => ({
  member_product_id: '',
  qty: 1,
  optional: false,
  option_value_ids: [],
  color_id: '',
  customer_picks_option: false,
  customer_picks_color: false,
  random_color: false,
  sort,
  choice_option_value_ids: [],
  choice_color_ids: [],
});

/** A refusal's row-level lines, or its sentence when it carried none. */
function issuesOf(e: unknown): BundleIssue[] {
  if (e instanceof ApiError) {
    const raw = (e.details?.errors ?? []) as unknown[];
    const list = raw.filter((x): x is BundleIssue => !!x && typeof x === 'object' && 'code' in (x as object));
    if (list.length) return list;
    return [{ code: e.code ?? 'ERROR', message: e.message, ar: e.message, en: e.message, ckb: e.message }];
  }
  const message = e instanceof Error ? e.message : String(e);
  return [{ code: 'ERROR', message, ar: message, en: message, ckb: message }];
}

/** An ISO instant as the value a `datetime-local` input wants, in Baghdad
 *  time — the zone the store runs in. The server normalises back to UTC. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 3 * 3600_000).toISOString().slice(0, 16);
}

/**
 * WHY A BLOCKING COMPONENT IS BLOCKING, IN THE ADMIN'S OWN LANGUAGE.
 *
 * `availability.blocking[].reason` is a machine code — `OUT_OF_STOCK`,
 * `PREORDER_CAPACITY_EXHAUSTED` — and the preview used to render it verbatim,
 * so an Arabic-first admin read «<product> — المطلوب 1, المتاح 0
 * (PREORDER_CAPACITY_EXHAUSTED)». The ONE fact that distinguishes a full import
 * quota from an empty shelf — a different problem, a different fix, a different
 * screen to go and fix it on — arrived untranslated, on the screen the admin
 * opens to diagnose it. Every other refusal on this panel is a server sentence
 * in three languages (`BundleIssue.ar/en/ckb`); these codes are computed inside
 * `bundleAvailability`, carry no sentence, and this table is where they get one.
 *
 * The raw code is still shown beside the sentence, dimmed: an admin reporting a
 * problem to support quotes the code, and translating it away would take that
 * with it. A code with no entry here falls back to itself rather than to an
 * empty string, so a reason added on the server is never silently swallowed.
 *
 * ckb: THE ARABIC IS DELIBERATELY REPEATED. Kurdish Sorani here is the owner's
 * to write by hand; a generated translation on an admin's diagnostic screen is
 * worse than an honest fallback to a language they read.
 */
const BLOCKING_REASONS: Record<string, { ar: string; en: string }> = {
  OUT_OF_STOCK: { ar: 'نفد المخزون', en: 'out of stock' },
  PREORDER_CAPACITY_EXHAUSTED: { ar: 'حصة الطلب المسبق ممتلئة', en: 'pre-order quota is full' },
  PREORDER_CAPACITY_AMBIGUOUS: {
    ar: 'اختيار واحد يسمّي حصتَي طلب مسبق — اترك الحصة على موديل واحد فقط',
    en: 'one selection names two pre-order quotas — leave the quota on one model only',
  },
  SELECTION_INCOMPLETE: { ar: 'الاختيار غير مكتمل', en: 'selection incomplete' },
  VARIANT_NOT_MODELLED: { ar: 'هذه التوليفة غير معرّفة للبيع', en: 'this combination is not set up for sale' },
  COMPONENT_UNAVAILABLE: { ar: 'هذا المكوّن لم يعد معروضًا للبيع', en: 'this component is no longer on sale' },
};

export default function AdminBundles() {
  const { lang, dir } = useLanguage();
  const loc = useCallback(
    (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar),
    [lang]
  );
  const say = useCallback((i: BundleIssue) => (lang === 'en' ? i.en : lang === 'ckb' ? i.ckb : i.ar), [lang]);
  /** One blocking code, as a sentence. `ckb` falls back to the Arabic on
   *  purpose — see BLOCKING_REASONS. */
  const whyBlocked = useCallback(
    (code: string) => {
      const found = BLOCKING_REASONS[code];
      if (!found) return code;
      return lang === 'en' ? found.en : found.ar;
    },
    [lang]
  );

  const [rows, setRows] = useState<BundleCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [ok, setOk] = useState<string | null>(null);

  // A sequence guard so a slow reload cannot overwrite a newer one.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (search.trim()) q.set('search', search.trim());
      if (statusFilter) q.set('status', statusFilter);
      const res = await api.get<{ bundles: BundleCard[] }>(`/api/admin/bundles${q.size ? `?${q}` : ''}`);
      if (mine !== seq.current) return;
      setRows(res.bundles ?? []);
      setLoadErr(null);
    } catch (e) {
      if (mine === seq.current) setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ------------------------------------------------------------- editor state
  const [editing, setEditing] = useState<null | {
    doc: EditorDoc;
    config: ConfigInput;
    components: ComponentInput[];
    offer: OfferInput | null;
  }>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [issues, setIssues] = useState<BundleIssue[]>([]);
  const [warnings, setWarnings] = useState<BundleIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [openSection, setOpenSection] = useState(1);

  const [relations, setRelations] = useState<Record<string, RelationsRow>>({});
  /** Each member's names, cover and «from» price — the source of the auto-fill. */
  const [members, setMembers] = useState<Record<string, MemberInfo>>({});
  /** Printers are never components: they are bundled through «خصص طابعتك». */
  const [printerIds, setPrinterIds] = useState<ReadonlySet<string>>(new Set());
  /** While true, the name and description follow the products. Typing in either turns it off. */
  const [autoText, setAutoText] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState<Record<number, boolean>>({});
  const [imageBusy, setImageBusy] = useState<string | null>(null);
  const [imageErr, setImageErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ printers: Array<{ id: string }> }>('/api/admin/products-v2/printer-options')
      .then((res) => {
        if (!cancelled) setPrinterIds(new Set((res.printers ?? []).map((x) => x.id)));
      })
      .catch(() => {
        // Without the list the picker still works; the server refuses nothing here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMemberInfo = useCallback(async (id: string, fromIqd: number | null = null) => {
    if (!id) return;
    try {
      const m = await loadMember(id, fromIqd);
      setMembers((prev) => ({ ...prev, [id]: { ...m, from_iqd: fromIqd ?? prev[id]?.from_iqd ?? null } }));
    } catch {
      // A member that cannot be read keeps its row; the save names the problem.
    }
  }, []);

  const loadRelations = useCallback(
    async (productId: string) => {
      if (!productId || relations[productId]) return;
      try {
        const res = await api.get<RelationsRow>(`/api/admin/products/${productId}/relations`);
        setRelations((prev) => ({ ...prev, [productId]: { values: res.values ?? [], colors: res.colors ?? [] } }));
      } catch {
        setRelations((prev) => ({ ...prev, [productId]: { values: [], colors: [] } }));
      }
    },
    [relations]
  );

  // «يحتاج تسعيرًا» links here (`?tab=bundles&edit=<id>&section=3`): the bundle opens on its section.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    const q = new URLSearchParams(window.location.search);
    const id = q.get('edit');
    if (!id) return;
    const section = Number(q.get('section'));
    void openExisting(id).then(() => {
      if (section >= 1 && section <= 5) setOpenSection(section);
    });
    // Once, on arrival: `openExisting` reads the bundle fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = async () => {
    setEditing({ doc: blankDoc(), config: blankConfig(), components: [], offer: null });
    setPreview(null);
    setIssues([]);
    setWarnings([]);
    setOpenSection(1);
    setAutoText(true);
    setTextOpen(false);
    setMoreOpen({});
    setImageErr(null);
  };

  const openExisting = async (id: string) => {
    try {
      const res = await api.get<{
        product: Record<string, unknown>;
        config: ConfigInput;
        components: ComponentInput[];
        offer: OfferInput | null;
        preview: Preview;
        updated_at: string;
        warning_details: BundleIssue[];
      }>(`/api/admin/bundles/${id}`);
      const p = res.product;
      setEditing({
        doc: {
          id: String(p.id ?? ''),
          slug: String(p.slug ?? ''),
          status: (p.status as EditorDoc['status']) ?? 'draft',
          name_ar: String(p.name_ar ?? ''),
          name_en: String(p.name_en ?? ''),
          name_ckb: String(p.name_ckb ?? ''),
          description_ar: String(p.description_ar ?? ''),
          description_en: String(p.description_en ?? ''),
          description_ckb: String(p.description_ckb ?? ''),
          price_iqd: Number(p.price_iqd ?? 0),
          original_price_iqd: p.original_price_iqd === null || p.original_price_iqd === undefined ? null : Number(p.original_price_iqd),
          prime_price_iqd: p.prime_price_iqd === null || p.prime_price_iqd === undefined ? null : Number(p.prime_price_iqd),
          pro_price_iqd: p.pro_price_iqd === null || p.pro_price_iqd === undefined ? null : Number(p.pro_price_iqd),
          display_order: Number(p.display_order ?? 0),
          is_featured: !!p.is_featured,
          images: (Array.isArray(p.media) ? (p.media as Array<{ url?: string }>) : [])
            .map((m) => String(m.url ?? ''))
            .filter(Boolean),
          updated_at: res.updated_at ?? '',
        },
        config: res.config,
        components: res.components.map((c) => ({ ...c, random_color: !!c.random_color })),
        offer: res.offer,
      });
      setPreview(res.preview);
      setWarnings(res.warning_details ?? []);
      setIssues([]);
      setOpenSection(1);
      setAutoText(false);
      setTextOpen(false);
      setMoreOpen({});
      setImageErr(null);
      for (const c of res.components) {
        void loadRelations(c.member_product_id);
        void loadMemberInfo(c.member_product_id);
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  };

  const colourOf = (c: ComponentInput) => relations[c.member_product_id]?.colors.find((x) => x.id === c.color_id);
  /** Each line as the text needs it: its product, count and colour (a name, «random», or none). */
  const textLines = (list: ComponentInput[]) =>
    list
      .filter((c) => members[c.member_product_id])
      .map((c) => {
        const col = colourOf(c);
        const colour: LineColour = c.random_color
          ? 'random'
          : col && !c.customer_picks_color
            ? { ar: col.name_ar || '', en: col.name_en, ckb: col.name_ckb || '' }
            : null;
        return { m: members[c.member_product_id], qty: c.qty, colour };
      });
  /** Each line as a cover tile: the colour's own picture when it has one, else the product's with a swatch. */
  const coverTiles = (list: ComponentInput[]): CoverTile[] =>
    list
      .filter((c) => c.member_product_id)
      .map((c) => {
        const col = c.customer_picks_color || c.random_color ? undefined : colourOf(c);
        const own = col ? col.image || members[c.member_product_id]?.colour_images[col.id] || '' : '';
        return {
          url: own || members[c.member_product_id]?.image || '',
          hex: !own && col?.hex ? col.hex : undefined,
          random: c.random_color,
          qty: c.qty,
        };
      });

  /** Builds the cover from the lines (colour pictures, counts, a rainbow for «random») and uploads it. */
  const makeCover = async (tiles: CoverTile[]): Promise<string | null> => {
    setImageBusy(loc('جارٍ صنع صورة الحزمة من صور المنتجات…', 'Making the bundle picture from the product pictures…', 'دروستکردنی وێنەی پاکێج لە وێنەی بەرهەمەکان…'));
    setImageErr(null);
    try {
      const file = await bundleCover(tiles);
      if (!file) {
        setImageErr(loc('تعذّر قراءة صور المنتجات — ارفع صورة بنفسك.', 'Could not read the product pictures — upload one yourself.', 'وێنەی بەرهەمەکان نەخوێنرانەوە — خۆت وێنەیەک باربکە.'));
        return null;
      }
      const res = await uploadFile(file, 'product');
      return res.url;
    } catch (e) {
      setImageErr(failureText(e, loc('فشل رفع الصورة', 'Upload failed', 'بارکردن سەرنەکەوت')));
      return null;
    } finally {
      setImageBusy(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setIssues([]);
    setOk(null);
    try {
      const chosen = editing.components.filter((c) => c.member_product_id);
      let doc = editing.doc;
      // No name typed and none generated yet: take it from the products now.
      if (!doc.name_ar.trim() && !doc.name_en.trim() && !doc.name_ckb.trim()) {
        const lines = textLines(chosen);
        if (lines.length) doc = { ...doc, ...bundleText(lines) };
      }
      // No picture: make the cover from the products' pictures before saving.
      if (doc.images.length === 0) {
        const tiles = coverTiles(chosen);
        if (tiles.some((t) => t.url || t.random)) {
          const url = await makeCover(tiles);
          if (url) doc = { ...doc, images: [url] };
        }
      }
      if (doc !== editing.doc) setEditing({ ...editing, doc });
      const body: Record<string, unknown> = {
        ...doc,
        images: doc.images.map((url) => ({ url })),
        media: doc.images.map((url, i) => ({ id: `img_${i}`, url, primary: i === 0 })),
        components: chosen.map((c, i) => ({ ...c, sort: i })),
        config: editing.config,
        offer: editing.offer,
        ...(doc.id ? { expected_updated_at: doc.updated_at } : {}),
      };
      // DECISIONS row 251: the panel types no dinar price — the bundle is priced in section ٣ (Pricing V2),
      // and an absent price keeps the stored one (a new bundle is born «يحتاج تسعيرًا»).
      for (const k of ['price_iqd', 'original_price_iqd', 'prime_price_iqd', 'pro_price_iqd']) delete body[k];
      const res = doc.id
        ? await api.put<{ product: Record<string, unknown>; preview: Preview; warning_details: BundleIssue[] }>(
            `/api/admin/bundles/${doc.id}`,
            body
          )
        : await api.post<{ product: Record<string, unknown>; preview: Preview; warning_details: BundleIssue[] }>(
            '/api/admin/bundles',
            body
          );
      setPreview(res.preview);
      // The warnings STAY on the screen after a successful save.
      setWarnings(res.warning_details ?? []);
      setOk(loc('حُفظت الحزمة', 'Bundle saved', 'پاکێجەکە پاشەکەوت کرا'));
      await reload();
      const id = String((res.product as { id?: unknown }).id ?? '');
      if (id) await openExisting(id);
    } catch (e) {
      setIssues(issuesOf(e));
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setIssues([]);
    setOk(null);
    try {
      await fn();
      setOk(done);
      await reload();
    } catch (e) {
      setIssues(issuesOf(e));
    }
  };

  const move = async (index: number, delta: number) => {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
    await act(
      () => api.put('/api/admin/bundles/reorder', { order: next.map((b) => b.id) }),
      loc('تم الترتيب', 'Reordered', 'ڕیزکرا')
    );
  };

  // While the text follows the products, every change of products or quantities rewrites it.
  useEffect(() => {
    if (!editing || !autoText) return;
    const lines = textLines(editing.components);
    if (!lines.length) return;
    const next = bundleText(lines);
    const d = editing.doc;
    if ((Object.keys(next) as Array<keyof typeof next>).every((k) => d[k] === next[k])) return;
    setEditing({ ...editing, doc: { ...d, ...next } });
    // `textLines` reads `members` and `relations`, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, autoText, members, relations]);

  const totalWarnings = useMemo(() => rows.reduce((n, b) => n + (b.warnings?.length ?? 0), 0), [rows]);

  // ==================================================================== list

  if (!editing) {
    return (
      <div className={`${T.AP} space-y-4`} dir={dir} data-panel="bundles">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold leading-tight flex items-center gap-2 text-[var(--ap-text-1)]">
              <Boxes className="w-5 h-5 text-[var(--ap-accent,#6B46FF)]" aria-hidden />
              {loc('الحزم', 'Bundles', 'پاکێجەکان')}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--ap-text-3)] max-w-[70ch]">
              {loc(
                'الحزمة منتج حقيقي مكوّن من منتجات الكتالوج. لا مخزون لها: توفّرها يُحسب من أندر مكوّن، وسعرها وخصمها وتوفّرها تحسبها الخوادم — لا شيء في هذه الشاشة يُحسب في المتصفح.',
                'A bundle is a real product made of catalogue products. It has no stock of its own: availability is the scarcest component, and every price, saving and count on this screen is computed by the server.',
                'پاکێج بەرهەمێکی ڕاستەقینەیە لە بەرهەمەکانی کەتەلۆگ. کۆگای خۆی نییە: بەردەستی لە کەمترین پێکهاتەوە دەژمێردرێت، و هەموو نرخ و داشکاندنێک لەلایەن سێرڤەرەوە دەژمێردرێت.'
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={T.btnIconLg} onClick={() => void reload()} aria-label={loc('تحديث', 'Refresh', 'نوێکردنەوە')}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
            <button type="button" className={btnPrimary} onClick={() => void openNew()} data-bundles-new>
              <Plus className="w-4 h-4" aria-hidden /> {loc('حزمة جديدة', 'New bundle', 'پاکێجی نوێ')}
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 max-w-sm">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-[var(--ap-text-3)]" aria-hidden />
            <input
              className={`${T.input} ps-8`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={loc('بحث بالاسم أو الرابط', 'Search by name or slug', 'گەڕان بە ناو یان لینک')}
              aria-label={loc('بحث', 'Search', 'گەڕان')}
            />
          </div>
          <select
            className={T.select}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label={loc('الحالة', 'Status', 'دۆخ')}
          >
            <option value="">{loc('كل الحالات', 'All statuses', 'هەموو دۆخەکان')}</option>
            <option value="active">{loc('منشورة', 'Published', 'بڵاوکراوە')}</option>
            <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
            <option value="hidden">{loc('مخفية', 'Hidden', 'شاراوە')}</option>
          </select>
          {totalWarnings > 0 && (
            <span className={`${T.badgeBase} lv-chip border-transparent [--chip:var(--color-warning)]`}>
              {loc('تنبيهات', 'Warnings', 'ئاگادارییەکان')}: {totalWarnings}
            </span>
          )}
        </div>

        <div role="status" aria-live="polite" className="sr-only">
          {ok ?? loadErr ?? ''}
        </div>
        {ok && <Banner kind="ok">{ok}</Banner>}
        {loadErr && <Banner kind="error">{loadErr}</Banner>}
        {issues.length > 0 && (
          <Banner kind="error">
            <ul className="space-y-1">
              {issues.map((i, k) => (
                <li key={k}>{say(i)}</li>
              ))}
            </ul>
          </Banner>
        )}

        {loading && rows.length === 0 ? (
          <p className="text-[13px] text-[var(--ap-text-3)] py-6">{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-[var(--ap-text-3)] py-6">
            {loc('لا توجد حزم بعد.', 'No bundles yet.', 'هێشتا هیچ پاکێجێک نییە.')}
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((b, i) => {
              const state = STATES[b.availability_state] ?? STATES.unconfigured;
              return (
                <article key={b.id} className={`${T.surface} p-3 min-w-0`} data-bundle={b.id}>
                  <div className="flex flex-wrap items-start gap-3 min-w-0">
                    {b.image ? (
                      <VariantImg sizes="64px" src={b.image} alt="" className={T.thumb} loading="lazy" />
                    ) : (
                      <span className={`${T.thumb} grid place-items-center text-[var(--ap-text-3)]`} aria-hidden>
                        <Boxes className="w-4 h-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <h2 className="text-[14px] font-bold truncate text-[var(--ap-text-1)]">
                          {lang === 'en' ? b.name || b.name_ar : lang === 'ckb' ? b.name_ku || b.name_ar : b.name_ar || b.name}
                        </h2>
                        <span className={`${T.badgeBase} ${T.badge[(b.status as 'active' | 'draft' | 'hidden') ?? 'draft']}`}>
                          {b.status}
                        </span>
                        <span
                          className={`${T.badgeBase} ${
                            state.tone === 'ok'
                              ? 'lv-chip border-transparent [--chip:var(--color-success)]'
                              : state.tone === 'warn'
                                ? 'lv-chip border-transparent [--chip:var(--color-warning)]'
                                : 'lv-chip border-transparent [--chip:var(--color-danger)] [--chip-ink:var(--color-error-ink)]'
                          }`}
                        >
                          {loc(state.ar, state.en, state.ckb)}
                        </span>
                        {b.needs_pricing && (
                          <span className={`${T.badgeBase} lv-chip border-transparent [--chip:var(--color-warning)]`} data-bundle-needs-pricing>
                            {loc('يحتاج تسعيرًا', 'Needs pricing', 'پێویستی بە نرخدانانە')}
                          </span>
                        )}
                        {b.offer && b.offer.required_tiers.length > 0 && (
                          <span className={`${T.badgeBase} lv-chip border-transparent [--chip:var(--color-gold)]`}>
                            {b.offer.required_tiers.join(' · ').toUpperCase()}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] text-[var(--ap-text-3)] flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>
                          {loc('المكوّنات', 'Components', 'پێکهاتەکان')}: {b.component_count}
                        </span>
                        <span>
                          {loc('قيمة المكوّنات', 'Parts value', 'نرخی پارچەکان')}: {formatIqd(b.component_total_iqd)}
                        </span>
                        {!b.needs_pricing && (
                          <span>
                            {loc('سعر الحزمة', 'Bundle price', 'نرخی پاکێج')}: {formatIqd(b.bundle_price_iqd)}
                          </span>
                        )}
                        {b.saving_percent > 0 && (
                          <span className="text-emerald-400">
                            {loc('توفير', 'Saving', 'پاشەکەوت')} {b.saving_percent}%
                          </span>
                        )}
                        <span>
                          {loc('أقصى عدد حزم', 'Max bundles', 'زۆرترین پاکێج')}:{' '}
                          {b.max_bundles === null ? loc('غير محدود', 'unbounded', 'بێ سنوور') : b.max_bundles}
                        </span>
                      </p>
                      {b.warnings.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {b.warning_details.map((w, k) => (
                            <li key={k} className="text-[11.5px] text-amber-300">
                              • {say(w)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() => void move(i, -1)}
                        aria-label={loc('أعلى', 'Move up', 'بۆ سەرەوە')}
                      >
                        <ArrowUp className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() => void move(i, 1)}
                        aria-label={loc('أسفل', 'Move down', 'بۆ خوارەوە')}
                      >
                        <ArrowDown className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() =>
                          void act(
                            () =>
                              api.patch(`/api/admin/bundles/${b.id}/status`, {
                                action: b.status === 'active' ? 'disable' : 'enable',
                              }),
                            b.status === 'active' ? loc('أُخفيت', 'Hidden', 'شاردرایەوە') : loc('نُشرت', 'Published', 'بڵاوکرایەوە')
                          )
                        }
                        aria-label={b.status === 'active' ? loc('إخفاء', 'Disable', 'شاردنەوە') : loc('نشر', 'Enable', 'بڵاوکردنەوە')}
                      >
                        {b.status === 'active' ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
                      </button>
                      <button
                        type="button"
                        className={T.btnIcon}
                        onClick={() =>
                          void act(
                            () => api.post(`/api/admin/bundles/${b.id}/duplicate`, {}),
                            loc('نُسخت', 'Duplicated', 'لەبەرگیرایەوە')
                          )
                        }
                        aria-label={loc('نسخ', 'Duplicate', 'لەبەرگرتنەوە')}
                      >
                        <Copy className="w-4 h-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIconDanger}
                        onClick={() => {
                          if (!window.confirm(loc('حذف أو أرشفة هذه الحزمة؟', 'Delete or archive this bundle?', 'ئەم پاکێجە بسڕدرێتەوە؟'))) return;
                          void act(() => api.delete(`/api/admin/bundles/${b.id}`), loc('تمت الأرشفة', 'Archived', 'ئەرشیف کرا'));
                        }}
                        aria-label={loc('حذف', 'Delete', 'سڕینەوە')}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden />
                      </button>
                      <button type="button" className={btnGhost} onClick={() => void openExisting(b.id)}>
                        {loc('تحرير', 'Edit', 'دەستکاری')}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ================================================================== editor

  const { doc, config, components, offer } = editing;
  const setDoc = (patch: Partial<EditorDoc>) => setEditing({ ...editing, doc: { ...doc, ...patch } });
  const setConfig = (patch: Partial<ConfigInput>) => setEditing({ ...editing, config: { ...config, ...patch } });
  const setOffer = (patch: Partial<OfferInput> | null) =>
    setEditing({
      ...editing,
      offer:
        patch === null
          ? null
          : {
              starts_at: null,
              ends_at: null,
              required_tiers: [],
              offer_price_mode: '',
              offer_price_iqd: null,
              discount_percent: null,
              discount_iqd: null,
              plus_price_iqd: null,
              locked_preview: true,
              active: true,
              max_per_user: null,
              max_global: null,
              ...(offer ?? {}),
              ...patch,
            },
    });
  const setComponent = (i: number, patch: Partial<ComponentInput>) => {
    const next = components.map((c, k) => (k === i ? { ...c, ...patch } : c));
    setEditing({ ...editing, components: next });
  };

  const nameOf = (id: string) => {
    const m = members[id];
    if (!m) return id;
    return lang === 'en' ? m.name_en || m.name_ar : lang === 'ckb' ? m.name_ckb || m.name_ar || m.name_en : m.name_ar || m.name_en;
  };
  /** The price a member sells at alone: the picker's V2 «from», else the server preview's unit. */
  const unitOf = (id: string): number | null =>
    members[id]?.from_iqd ?? preview?.components.find((x) => x.member_product_id === id)?.unit_iqd ?? null;
  const required = components.filter((c) => c.member_product_id && !c.optional);
  const priceBefore = required.length && required.every((c) => unitOf(c.member_product_id) !== null)
    ? required.reduce((n, c) => n + (unitOf(c.member_product_id) ?? 0) * c.qty, 0)
    : null;
  const tilesNow = coverTiles(components);
  const colourName = (v: RelationsRow['colors'][number]) =>
    lang === 'en' ? v.name_en : lang === 'ckb' ? v.name_ckb || v.name_ar || v.name_en : v.name_ar || v.name_en;
  /** The colour menu: «customer picks», «random», or one colour pinned. */
  const setColour = (i: number, value: string) =>
    setComponent(
      i,
      value === '__pick'
        ? { customer_picks_color: true, random_color: false, color_id: '' }
        : value === '__random'
          ? { customer_picks_color: false, random_color: true, color_id: '', choice_color_ids: [] }
          : { customer_picks_color: false, random_color: false, color_id: value, choice_color_ids: [] }
    );
  /** «لون آخر»: the same product again, same model, the next colour no line has pinned yet (else random). */
  const addSibling = (i: number) => {
    const src = components[i];
    const rel = relations[src.member_product_id];
    const used = new Set(components.filter((c) => c.member_product_id === src.member_product_id).map((c) => c.color_id));
    const next = (rel?.colors ?? []).find((x) => !!x.active && !used.has(x.id));
    const line: ComponentInput = {
      ...blankComponent(components.length),
      member_product_id: src.member_product_id,
      option_value_ids: [...src.option_value_ids],
      customer_picks_option: src.customer_picks_option,
      color_id: next ? next.id : '',
      random_color: !next,
    };
    // A first line still on «customer picks» becomes its own first colour, so the two lines differ.
    const first = !src.color_id && !src.random_color && src.customer_picks_color && next
      ? (rel?.colors ?? []).find((x) => !!x.active && x.id !== next.id && !used.has(x.id))
      : undefined;
    const list = components.map((c, k) =>
      k === i && first ? { ...c, customer_picks_color: false, color_id: first.id } : c
    );
    if (first) {
      const after = (rel?.colors ?? []).find((x) => !!x.active && x.id !== first.id && !used.has(x.id));
      line.color_id = after ? after.id : '';
      line.random_color = !after;
    }
    list.splice(i + 1, 0, line);
    setEditing({ ...editing, components: list });
    setMoreOpen({});
  };
  const shownName = lang === 'en' ? doc.name_en || doc.name_ar : lang === 'ckb' ? doc.name_ckb || doc.name_ar || doc.name_en : doc.name_ar || doc.name_en;
  const shownDescription =
    lang === 'en' ? doc.description_en || doc.description_ar : lang === 'ckb' ? doc.description_ckb || doc.description_ar || doc.description_en : doc.description_ar || doc.description_en;

  /** Typing in a name or description stops the auto-fill: the owner's words win. */
  const editText = (patch: Partial<EditorDoc>) => {
    setAutoText(false);
    setDoc(patch);
  };
  const pushImages = (urls: string[], front = false) =>
    setEditing((prev) =>
      prev
        ? { ...prev, doc: { ...prev.doc, images: front ? [...urls, ...prev.doc.images] : [...prev.doc.images, ...urls] } }
        : prev
    );
  const uploadPictures = async (files: File[]) => {
    setImageErr(null);
    for (const [k, file] of files.entries()) {
      setImageBusy(loc(`جارٍ رفع الصورة ${k + 1} من ${files.length}…`, `Uploading picture ${k + 1} of ${files.length}…`, `بارکردنی وێنەی ${k + 1} لە ${files.length}…`));
      try {
        const res = await uploadFile(file, 'product');
        pushImages([res.url]);
      } catch (e) {
        setImageErr(failureText(e, loc('فشل رفع الصورة', 'Upload failed', 'بارکردن سەرنەکەوت')));
      }
    }
    setImageBusy(null);
  };

  /** A pick adds a line (or one more of a line already there). A product with
   *  models or colours lets the customer choose them — all its options come along. */
  const addProduct = async (id: string, p: PickerProduct | null) => {
    if (!id) return;
    const at = components.findIndex((c) => c.member_product_id === id);
    const known = relations[id];
    if (at >= 0 && known && (known.colors.some((v) => !!v.active) || known.values.some((v) => !!v.active))) {
      // Another line of the same product: its own colour, the same model.
      addSibling(at);
      return;
    }
    if (at >= 0) {
      setComponent(at, { qty: Math.min(99, components[at].qty + 1) });
      return;
    }
    void loadMemberInfo(id, p?.from_iqd ?? null);
    let rel = relations[id];
    if (!rel) {
      try {
        const res = await api.get<RelationsRow>(`/api/admin/products/${id}/relations`);
        rel = { values: res.values ?? [], colors: res.colors ?? [] };
      } catch {
        rel = { values: [], colors: [] };
      }
      const got = rel;
      setRelations((prev) => ({ ...prev, [id]: got }));
    }
    const picksOption = rel.values.some((v) => !!v.active);
    const picksColor = rel.colors.some((v) => !!v.active);
    setEditing((prev) =>
      prev && !prev.components.some((c) => c.member_product_id === id)
        ? {
            ...prev,
            components: [
              ...prev.components,
              { ...blankComponent(prev.components.length), member_product_id: id, customer_picks_option: picksOption, customer_picks_color: picksColor },
            ],
          }
        : prev
    );
  };

  const issuesFor = (componentId: string | undefined, index: number) =>
    issues.filter((x) => (componentId && x.component_id === componentId) || x.line === index + 1);

  return (
    <div className={`${T.AP} space-y-3`} dir={dir} data-panel="bundles-editor">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px] font-bold flex items-center gap-2 text-[var(--ap-text-1)]">
          <Boxes className="w-5 h-5 text-[var(--ap-accent,#6B46FF)]" aria-hidden />
          {doc.id ? loc('تحرير حزمة', 'Edit bundle', 'دەستکاری پاکێج') : loc('حزمة جديدة', 'New bundle', 'پاکێجی نوێ')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              setEditing(null);
              setIssues([]);
              void reload();
            }}
          >
            <X className="w-4 h-4" aria-hidden /> {loc('إغلاق', 'Close', 'داخستن')}
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()} data-bundles-save>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
            {loc('حفظ', 'Save', 'پاشەکەوت')}
          </button>
        </div>
      </header>

      <div role="status" aria-live="polite" className="sr-only">
        {ok ?? (issues.length ? issues.map(say).join(' · ') : '')}
      </div>
      {ok && <Banner kind="ok">{ok}</Banner>}
      {issues.length > 0 && (
        <Banner kind="error">
          <p className="font-bold mb-1">{loc('لم تُحفظ الحزمة:', 'The bundle was not saved:', 'پاکێجەکە پاشەکەوت نەکرا:')}</p>
          <ul className="space-y-1">
            {issues.map((i, k) => (
              <li key={k}>
                <span className="font-mono text-[11px] opacity-70">{i.code}</span> — {say(i)}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {warnings.length > 0 && (
        <Banner kind="warn">
          <ul className="space-y-1">
            {warnings.map((w, k) => (
              <li key={k}>
                <span className="font-mono text-[11px] opacity-70">{w.code}</span> — {say(w)}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/* 1 — the products. Everything else on this screen follows from them. */}
      <SectionCard
        n={1}
        ar="المنتجات"
        en="Products"
        count={components.length}
        open={openSection === 1}
        onToggle={() => setOpenSection(openSection === 1 ? 0 : 1)}
      >
        <div className="space-y-3 min-w-0" data-bundle-products>
          <Field
            ar="أضف منتجًا من المتجر"
            en="Add a product from the store"
            hint={loc(
              'الاسم والوصف والصورة تُملأ من المنتجات. الطابعات لا تُضاف هنا: تُباع مع إضافاتها من «خصص طابعتك».',
              'The name, description and picture come from the products. Printers are not added here: they are sold with their extras from «Customize your printer».',
              'ناو و وەسف و وێنە لە بەرهەمەکانەوە دێن. چاپکەرەکان لێرە زیاد ناکرێن: لە «چاپکەرەکەت ڕێکبخە» دەفرۆشرێن.'
            )}
            span
          >
            <ProductPicker
              value=""
              keepOpen
              excludeIds={printerIds}
              ariaLabel={loc('أضف منتجًا', 'Add a product', 'بەرهەمێک زیاد بکە')}
              placeholder={loc('ابحث واختر منتجًا…', 'Search and pick a product…', 'بگەڕێ و بەرهەمێک هەڵبژێرە…')}
              onChange={(id, p) => void addProduct(id, p)}
            />
          </Field>

          {components.length === 0 ? (
            <p className="text-[12.5px] text-[var(--ap-text-3)] py-2">
              {loc('لم تُختر منتجات بعد.', 'No products picked yet.', 'هێشتا هیچ بەرهەمێک هەڵنەبژێردراوە.')}
            </p>
          ) : (
            <ul className="space-y-2">
              {components.map((c, i) => {
                const rel = relations[c.member_product_id];
                const rowIssues = issuesFor(c.id, i);
                const m = members[c.member_product_id];
                const unit = unitOf(c.member_product_id);
                const activeValues = (rel?.values ?? []).filter((v) => !!v.active);
                const activeColours = (rel?.colors ?? []).filter((v) => !!v.active);
                const pinnedColour = activeColours.find((x) => x.id === c.color_id);
                const colourPicture = pinnedColour ? pinnedColour.image || m?.colour_images[pinnedColour.id] || '' : '';
                const thumb = colourPicture || m?.image || '';
                const colourValue = c.random_color ? '__random' : c.customer_picks_color ? '__pick' : c.color_id;
                const modelValue = c.customer_picks_option ? '__pick' : c.option_value_ids[0] ?? '';
                return (
                  <li
                    key={c.id ?? `new_${c.member_product_id}_${i}`}
                    className={`rounded-lg border p-2.5 min-w-0 ${rowIssues.length ? 'border-red-500/50 bg-red-500/[0.04]' : 'border-[var(--ap-border)]'}`}
                    data-bundle-line={c.member_product_id}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="relative shrink-0">
                        {c.random_color ? (
                          <span className={`${T.thumb} grid place-items-center text-white font-bold`} style={{ background: RAINBOW, fontSize: 18 }} aria-hidden>
                            ?
                          </span>
                        ) : thumb ? (
                          <VariantImg sizes="48px" src={thumb} alt="" className={T.thumb} loading="lazy" />
                        ) : (
                          <span className={`${T.thumb} grid place-items-center text-[var(--ap-text-3)]`} aria-hidden>
                            <Boxes className="w-4 h-4" />
                          </span>
                        )}
                        {pinnedColour && !colourPicture && pinnedColour.hex && (
                          <span
                            className="absolute rounded-full"
                            style={{ background: pinnedColour.hex, width: 16, height: 16, bottom: -4, insetInlineStart: -4, border: '2px solid #fff' }}
                            aria-hidden
                          />
                        )}
                        <span
                          className="absolute rounded-full text-white font-bold grid place-items-center"
                          style={{ top: -6, insetInlineEnd: -6, minWidth: 20, height: 20, padding: '0 4px', fontSize: 11, background: '#111', border: '1px solid #fff' }}
                        >
                          {c.qty}
                        </span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-bold truncate text-[var(--ap-text-1)]">{nameOf(c.member_product_id)}</p>
                        <p className="mt-0.5 text-[11.5px] text-[var(--ap-text-3)] flex flex-wrap gap-x-2 gap-y-0.5">
                          <span>{unit === null ? loc('بلا سعر بعد', 'not priced yet', 'هێشتا نرخی نییە') : formatIqd(unit)}</span>
                          {c.optional && <span>· {loc('اختياري', 'optional', 'ئارەزوومەندانە')}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" role="group" aria-label={loc('الكمية', 'Quantity', 'بڕ')}>
                        <button
                          type="button"
                          className={T.btnIcon}
                          disabled={c.qty <= 1}
                          onClick={() => setComponent(i, { qty: Math.max(1, c.qty - 1) })}
                          aria-label={loc('إنقاص', 'Less', 'کەمتر')}
                        >
                          <Minus className="w-4 h-4" aria-hidden />
                        </button>
                        <span className="min-w-[2ch] text-center text-[13px] font-bold tabular-nums">{c.qty}</span>
                        <button
                          type="button"
                          className={T.btnIcon}
                          onClick={() => setComponent(i, { qty: Math.min(99, c.qty + 1) })}
                          aria-label={loc('زيادة', 'More', 'زیاتر')}
                        >
                          <Plus className="w-4 h-4" aria-hidden />
                        </button>
                      </div>
                      <button
                        type="button"
                        className={T.btnIcon}
                        aria-expanded={!!moreOpen[i]}
                        onClick={() => setMoreOpen((prev) => ({ ...prev, [i]: !prev[i] }))}
                        aria-label={loc('المزيد', 'More settings', 'زیاتر')}
                      >
                        <ChevronDown className={`w-4 h-4 transition-transform ${moreOpen[i] ? 'rotate-180' : ''}`} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={T.btnIconDanger}
                        onClick={() => {
                          setEditing({ ...editing, components: components.filter((_, k) => k !== i) });
                          setMoreOpen({});
                        }}
                        aria-label={loc('إزالة المنتج', 'Remove product', 'لابردنی بەرهەم')}
                      >
                        <Trash2 className="w-4 h-4" aria-hidden />
                      </button>
                    </div>

                    {(activeValues.length > 0 || activeColours.length > 0) && (
                      <div className="mt-2.5 flex flex-wrap items-end gap-2 min-w-0">
                        {activeValues.length > 0 && (
                          <label className="flex-1" style={{ minWidth: 150 }}>
                            <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{loc('الموديل', 'Model', 'مۆدێل')}</span>
                            <Select
                              value={modelValue}
                              onChange={(e) =>
                                setComponent(
                                  i,
                                  e.target.value === '__pick'
                                    ? { customer_picks_option: true, option_value_ids: [] }
                                    : { customer_picks_option: false, option_value_ids: e.target.value ? [e.target.value] : [], choice_option_value_ids: [] }
                                )
                              }
                              data-bundle-model
                            >
                              <option value="__pick">{loc('الزبون يختار', 'Customer picks', 'کڕیار هەڵدەبژێرێت')}</option>
                              {activeValues.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {lang === 'en' ? v.name_en : v.name_ar || v.name_en}
                                </option>
                              ))}
                            </Select>
                          </label>
                        )}
                        {activeColours.length > 0 && (
                          <label className="flex-1" style={{ minWidth: 150 }}>
                            <span className="block text-[11px] text-[var(--ap-text-3)] mb-1">{loc('اللون', 'Colour', 'ڕەنگ')}</span>
                            <Select
                              value={colourValue}
                              onChange={(e) => setColour(i, e.target.value)}
                              data-bundle-colour
                            >
                              <option value="__pick">{loc('الزبون يختار', 'Customer picks', 'کڕیار هەڵدەبژێرێت')}</option>
                              <option value="__random">{loc('🌈 لون عشوائي (المتجر يختار)', '🌈 Random colour (store picks)', '🌈 ڕەنگی هەڕەمەکی (فرۆشگا هەڵدەبژێرێت)')}</option>
                              {activeColours.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {colourName(v)}
                                </option>
                              ))}
                            </Select>
                          </label>
                        )}
                        {activeColours.length > 0 && (
                          <button type="button" className={btnGhost} onClick={() => addSibling(i)} data-bundle-add-colour>
                            <Plus className="w-4 h-4" aria-hidden /> {loc('لون آخر', 'Another colour', 'ڕەنگێکی تر')}
                          </button>
                        )}
                      </div>
                    )}

                    {moreOpen[i] && (
                      <div className="mt-2.5 pt-2.5 border-t border-[var(--ap-border)]">
                        <Toggle
                          checked={c.optional}
                          onChange={(v) => setComponent(i, { optional: v })}
                          label={loc('اختياري: يمكن للمشتري استبعاده', 'Optional: the buyer may decline it', 'ئارەزوومەندانە: کڕیار دەتوانێت لایبنێت')}
                        />
                      </div>
                    )}

                    {rowIssues.length > 0 && (
                      <ul className="mt-2 space-y-1 text-[11.5px] text-red-300">
                        {rowIssues.map((x, k) => (
                          <li key={k}>{say(x)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {components.length > 0 && (
            <p className="text-[12px] text-[var(--ap-text-2)]" data-bundle-pieces>
              {loc('عدد القطع في الحزمة', 'Pieces in the bundle', 'ژمارەی پارچەکان لە پاکێجدا')}: <b>{components.reduce((n, c) => n + c.qty, 0)}</b>
            </p>
          )}

          {components.length > 0 && (
            <div className={`${T.surface} px-3 py-2 flex flex-wrap items-center justify-between gap-2`} data-bundle-price-before>
              <span className="text-[12px] text-[var(--ap-text-3)]">
                {loc('السعر قبل الحزمة (المنتجات منفردة)', 'Price before the bundle (products bought separately)', 'نرخ بەبێ پاکێج (بەرهەمەکان جیا)')}
              </span>
              <span className="text-[14px] font-bold text-[var(--ap-text-1)]">
                {priceBefore === null
                  ? loc('بعض المنتجات بلا سعر بعد', 'some products are not priced yet', 'هەندێک بەرهەم هێشتا نرخیان نییە')
                  : formatIqd(priceBefore)}
              </span>
            </div>
          )}
        </div>
      </SectionCard>

      {/* 2 — name, description and picture, filled from the products */}
      <SectionCard
        n={2}
        ar="الاسم والصورة"
        en="Name and picture"
        summary={autoText ? loc('تُملأ تلقائيًا من المنتجات', 'filled from the products', 'لە بەرهەمەکانەوە پڕدەکرێتەوە') : undefined}
        open={openSection === 2}
        onToggle={() => setOpenSection(openSection === 2 ? 0 : 2)}
      >
        <div className="space-y-3 min-w-0" data-bundle-identity>
          <div className={`${T.surface} p-3 min-w-0`}>
            <div className="flex items-start justify-between gap-2 min-w-0">
              <div className="min-w-0">
                <p className="text-[14px] font-bold text-[var(--ap-text-1)] break-words">
                  {shownName || (
                    <span className="font-normal text-[var(--ap-text-3)]">
                      {loc('اختر المنتجات وسيُكتب الاسم تلقائيًا.', 'Pick the products and the name writes itself.', 'بەرهەمەکان هەڵبژێرە و ناوەکە خۆی دەنووسرێت.')}
                    </span>
                  )}
                </p>
                {shownDescription && (
                  <p className="mt-1 text-[12px] text-[var(--ap-text-2)] whitespace-pre-line line-clamp-5">{shownDescription}</p>
                )}
              </div>
              <button type="button" className={btnGhost} aria-expanded={textOpen} onClick={() => setTextOpen(!textOpen)}>
                <Pencil className="w-4 h-4" aria-hidden /> {loc('تعديل النص', 'Edit text', 'دەستکاری دەق')}
              </button>
            </div>
            <p className="mt-2 text-[11.5px] text-[var(--ap-text-3)]">
              {autoText
                ? loc(
                    'الاسم والوصف يتبعان المنتجات. أي لغة ناقصة تُترجم تلقائيًا عند الحفظ.',
                    'The name and description follow the products. Any missing language is translated when you save.',
                    'ناو و وەسف بەدوای بەرهەمەکاندا دەچن. هەر زمانێکی کەم لە پاشەکەوتدا وەردەگێڕدرێت.'
                  )
                : loc('النص مكتوب يدويًا.', 'The text is written by hand.', 'دەقەکە بە دەست نووسراوە.')}{' '}
              {!autoText && components.length > 0 && (
                <button type="button" className="underline text-[var(--ap-accent,#6B46FF)]" onClick={() => setAutoText(true)}>
                  {loc('أعد كتابته من المنتجات', 'Rewrite it from the products', 'لە بەرهەمەکانەوە دووبارە بینووسەوە')}
                </button>
              )}
            </p>
          </div>

          {textOpen && (
            <div className="space-y-3">
              <TriText
                labelAr="الاسم"
                labelEn="Name"
                ar={doc.name_ar}
                en={doc.name_en}
                ckb={doc.name_ckb}
                onAr={(v) => editText({ name_ar: v })}
                onEn={(v) => editText({ name_en: v })}
                onCkb={(v) => editText({ name_ckb: v })}
              />
              <TriText
                textarea
                labelAr="الوصف"
                labelEn="Description"
                ar={doc.description_ar}
                en={doc.description_en}
                ckb={doc.description_ckb}
                onAr={(v) => editText({ description_ar: v })}
                onEn={(v) => editText({ description_en: v })}
                onCkb={(v) => editText({ description_ckb: v })}
              />
            </div>
          )}

          <Field
            ar="الصور"
            en="Pictures"
            hint={loc(
              'الأولى هي الغلاف. إن لم تضف صورة، تُصنع صورة الحزمة من صور المنتجات عند الحفظ.',
              'The first is the cover. Without one, the bundle picture is made from the product pictures when you save.',
              'یەکەم بەرگەکەیە. ئەگەر وێنە زیاد نەکەیت، لە پاشەکەوتدا لە وێنەی بەرهەمەکان دروست دەکرێت.'
            )}
            span
          >
            <div className="space-y-2 min-w-0" data-bundle-images>
              <div className="flex flex-wrap gap-2">
                {doc.images.map((url, k) => (
                  <div key={url} className="relative">
                    <VariantImg sizes="96px" src={url} alt="" className="w-24 h-24 rounded-lg object-contain bg-[var(--ap-surface-2)] border border-[var(--ap-border)]" loading="lazy" />
                    {k === 0 ? (
                      <span className="absolute top-1 start-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-black/60 text-white">
                        {loc('الغلاف', 'Cover', 'بەرگ')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="absolute top-1 start-1 rounded bg-black/60 p-1 text-white"
                        onClick={() => setDoc({ images: [url, ...doc.images.filter((x) => x !== url)] })}
                        aria-label={loc('اجعلها الغلاف', 'Make cover', 'بیکە بە بەرگ')}
                      >
                        <Star className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    )}
                    <button
                      type="button"
                      className="absolute top-1 end-1 rounded bg-black/60 p-1 text-white"
                      onClick={() => setDoc({ images: doc.images.filter((x) => x !== url) })}
                      aria-label={loc('إزالة الصورة', 'Remove picture', 'لابردنی وێنە')}
                    >
                      <X className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={btnGhost} disabled={!!imageBusy} onClick={() => fileInput.current?.click()}>
                  <ImagePlus className="w-4 h-4" aria-hidden /> {loc('رفع صورة', 'Upload picture', 'بارکردنی وێنە')}
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={!!imageBusy || !tilesNow.some((t) => t.url || t.random)}
                  onClick={() =>
                    void makeCover(tilesNow).then((url) => {
                      if (url) pushImages([url], true);
                    })
                  }
                  data-bundle-make-cover
                >
                  <Sparkles className="w-4 h-4" aria-hidden /> {loc('صنع صورة من المنتجات', 'Make a picture from the products', 'وێنە لە بەرهەمەکان دروست بکە')}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void uploadPictures(files);
                  }}
                />
              </div>
              {imageBusy && (
                <p className="text-[12px] text-[var(--ap-text-3)] flex items-center gap-1.5" role="status">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> {imageBusy}
                </p>
              )}
              {imageErr && <Banner kind="error">{imageErr}</Banner>}
            </div>
          </Field>

          <Grid cols={3}>
            <Field ar="الحالة" en="Status">
              <Select value={doc.status} onChange={(e) => setDoc({ status: e.target.value as EditorDoc['status'] })}>
                <option value="draft">{loc('مسودة', 'Draft', 'ڕەشنووس')}</option>
                <option value="active">{loc('منشورة', 'Published', 'بڵاوکراوە')}</option>
                <option value="hidden">{loc('مخفية', 'Hidden', 'شاراوە')}</option>
              </Select>
            </Field>
            <Field ar="الترتيب" en="Display order">
              <Qty value={doc.display_order} onChange={(v) => setDoc({ display_order: v ?? 0 })} placeholder="0" />
            </Field>
            <Field ar="مميّزة" en="Featured">
              <Toggle
                checked={doc.is_featured}
                onChange={(v) => setDoc({ is_featured: v })}
                label={loc('تظهر في الواجهة', 'Featured rail', 'لە ڕیزی سەرەکی')}
              />
            </Field>
          </Grid>
        </div>
      </SectionCard>

      {/* 3 — pricing */}
      <SectionCard
        n={3}
        ar="السعر"
        en="Price"
        open={openSection === 3}
        onToggle={() => setOpenSection(openSection === 3 ? 0 : 3)}
      >
        {/* DECISIONS row 251: priced like an ordinary product — the product form's own section ٣. */}
        {doc.id ? (
          <CompositionPricing productId={doc.id} loc={loc} onSaved={() => void (async () => { await reload(); await openExisting(doc.id!); })()} />
        ) : (
          <p className="lv-alert lv-alert-info mb-3 px-3 py-2 text-[12px] leading-snug text-text-primary" data-bundle-price-after-save>
            {loc(
              'احفظ الحزمة أولًا، ثم سعّرها هنا كأي منتج: من التكلفة أو بسعر بالدولار. لا يراها الزبائن حتى تُسعَّر.',
              'Save the bundle first, then price it here like any product: from cost or a dollar price. Customers do not see it until it is priced.',
              'سەرەتا پاکێجەکە پاشەکەوت بکە، پاشان لێرە وەک هەر بەرهەمێک نرخی بۆ دابنێ: لە تێچوونەوە یان بە نرخێکی دۆلار. تا نرخی بۆ دانەنرێت کڕیاران نایبینن.'
            )}
          </p>
        )}
        <div className="h-3" />
        <Grid cols={3}>
          <Field ar="أقصى كمية في الطلب" en="Max qty per order">
            <Qty value={config.max_qty_per_order} onChange={(v) => setConfig({ max_qty_per_order: v ?? 5 })} placeholder="5" />
          </Field>
        </Grid>
      </SectionCard>

      {/* 4 — the offer window */}
      <SectionCard
        n={4}
        ar="العرض والجدولة"
        en="Offer and schedule"
        open={openSection === 4}
        onToggle={() => setOpenSection(openSection === 4 ? 0 : 4)}
      >
        <Toggle
          checked={!!offer}
          onChange={(v) => setOffer(v ? {} : null)}
          label={loc('لهذه الحزمة نافذة عرض', 'this bundle has an offer window', 'ئەم پاکێجە پەنجەرەی ئۆفەری هەیە')}
          sub={loc('جدولة، عضوية، حدود', 'schedule, membership, limits', 'خشتە، ئەندامێتی، سنوور')}
        />
        {offer && (
          <>
            <div className="h-3" />
            <Grid cols={2}>
              <Field ar="يبدأ" en="Starts" hint={loc('بتوقيت بغداد', 'Baghdad time', 'کاتی بەغدا')}>
                <TextInput
                  type="datetime-local"
                  value={toLocalInput(offer.starts_at)}
                  onChange={(e) => setOffer({ starts_at: e.target.value || null })}
                />
              </Field>
              <Field ar="ينتهي" en="Ends" hint={loc('بتوقيت بغداد', 'Baghdad time', 'کاتی بەغدا')}>
                <TextInput
                  type="datetime-local"
                  value={toLocalInput(offer.ends_at)}
                  onChange={(e) => setOffer({ ends_at: e.target.value || null })}
                />
              </Field>
            </Grid>
            <div className="h-3" />
            <Field
              ar="العضويات المسموح لها"
              en="Allowed memberships"
              hint={loc(
                'اتركها فارغة ليراها الجميع. PRO يرث PLUS؛ PRIME لا.',
                'empty = public, guests included. PRO inherits PLUS; PRIME does not.',
                'بەتاڵ = گشتی. PRO لە PLUS وەردەگرێت؛ PRIME نا.'
              )}
              span
            >
              <div className="flex flex-wrap gap-2">
                {TIERS.map((t) => {
                  const on = offer.required_tiers.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      className={`${T.chip} ${on ? 'bg-iris/15 border-iris/50 text-white' : ''}`}
                      onClick={() =>
                        setOffer({
                          required_tiers: on ? offer.required_tiers.filter((x) => x !== t) : [...offer.required_tiers, t],
                        })
                      }
                    >
                      {t.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="h-3" />
            <Grid cols={3}>
              <Field ar="سعر العرض" en="Offer price mode">
                <Select
                  value={offer.offer_price_mode}
                  onChange={(e) => setOffer({ offer_price_mode: e.target.value as OfferInput['offer_price_mode'] })}
                >
                  <option value="">{loc('لا يغيّر السعر', 'changes no price', 'نرخ ناگۆڕێت')}</option>
                  <option value="discount_percent">{loc('نسبة', 'Percent', 'ڕێژە')}</option>
                  <option value="discount_iqd">{loc('مبلغ', 'Dinars', 'دینار')}</option>
                </Select>
              </Field>
              {offer.offer_price_mode === 'discount_percent' && (
                <Field ar="نسبة الخصم %" en="Discount %" hint="1–90">
                  <Qty value={offer.discount_percent} onChange={(v) => setOffer({ discount_percent: v })} />
                </Field>
              )}
              {offer.offer_price_mode === 'discount_iqd' && (
                <Field ar="مبلغ الخصم" en="Discount (IQD)">
                  <Money value={offer.discount_iqd} onChange={(v) => setOffer({ discount_iqd: v })} />
                </Field>
              )}
              <Field ar="حد لكل عميل" en="Per-customer limit">
                <Qty value={offer.max_per_user} onChange={(v) => setOffer({ max_per_user: v })} />
              </Field>
              <Field ar="حد إجمالي" en="Global limit">
                <Qty value={offer.max_global} onChange={(v) => setOffer({ max_global: v })} />
              </Field>
              <Field ar="بطاقة مقفلة مزخرفة" en="Polished locked card">
                <Toggle
                  checked={offer.locked_preview}
                  onChange={(v) => setOffer({ locked_preview: v })}
                  label={loc('غير المشترك يرى البطاقة مقفلة', 'a non-member sees a locked card', 'ناوەندامان کارتی داخراو دەبینن')}
                />
              </Field>
              <Field ar="العرض فعّال" en="Offer active">
                <Toggle checked={offer.active} onChange={(v) => setOffer({ active: v })} label={loc('فعّال', 'active', 'چالاک')} />
              </Field>
            </Grid>
          </>
        )}
      </SectionCard>

      {/* 5 — the server's own preview */}
      <SectionCard
        n={5}
        ar="المعاينة من الخادم"
        en="Server preview"
        summary={loc('كل رقم هنا حسبه الخادم', 'every number here was computed by the server', 'هەموو ژمارەیەک لەلایەن سێرڤەرەوە ژمێردراوە')}
        open={openSection === 5}
        onToggle={() => setOpenSection(openSection === 5 ? 0 : 5)}
      >
        {!preview ? (
          <p className="text-[12.5px] text-[var(--ap-text-3)]">
            {loc('احفظ لرؤية المعاينة.', 'Save to see the preview.', 'پاشەکەوت بکە بۆ بینینی پێشبینین.')}
          </p>
        ) : (
          <div className="space-y-3 min-w-0">
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
              <Stat label={loc('قيمة المكوّنات', 'Parts value', 'نرخی پارچەکان')} value={formatIqd(preview.component_total_iqd)} />
              <Stat label={loc('سعر الحزمة', 'Bundle price', 'نرخی پاکێج')} value={formatIqd(preview.bundle_price_iqd)} />
              <Stat
                label={loc('التوفير', 'Saving', 'پاشەکەوت')}
                value={`${formatIqd(preview.discount_iqd)} · ${preview.saving_percent}%`}
              />
              <Stat
                label={loc('أقصى عدد حزم', 'Max bundles', 'زۆرترین پاکێج')}
                value={
                  preview.availability.max_bundles === null
                    ? loc('غير محدود', 'unbounded', 'بێ سنوور')
                    : String(preview.availability.max_bundles)
                }
              />
              <Stat label={loc('الحالة', 'State', 'دۆخ')} value={preview.availability.state} />
              <Stat label={loc('نوع الشحن', 'Shipping', 'گەیاندن')} value={preview.availability.shipping_type} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead className={T.tableHead}>
                  <tr>
                    <th className="px-2 py-1.5 text-start">{loc('المكوّن', 'Component', 'پێکهاتە')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('الكمية', 'Qty', 'بڕ')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('سعر الوحدة', 'Unit', 'یەکە')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('القيمة', 'Value', 'نرخ')}</th>
                    <th className="px-2 py-1.5 text-start">{loc('المتاح', 'Available', 'بەردەست')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.components.map((cp) => (
                    <tr key={cp.component_id || cp.member_product_id} className={T.tableRow}>
                      <td className="px-2 py-1.5">
                        {cp.name}
                        {cp.optional && (
                          <span className="ms-1.5 text-[10px] text-[var(--ap-text-3)]">{loc('اختياري', 'optional', 'ئارەزوومەندانە')}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{cp.qty_per_bundle}</td>
                      <td className="px-2 py-1.5">{formatIqd(cp.unit_iqd)}</td>
                      <td className="px-2 py-1.5">{formatIqd(cp.line_value_iqd)}</td>
                      <td className="px-2 py-1.5">
                        {cp.available === null ? loc('غير متتبَّع', 'untracked', 'نەپشکنراو') : cp.available}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.availability.blocking.length > 0 && (
              <Banner kind="warn">
                <ul className="space-y-1">
                  {preview.availability.blocking.map((b, k) => (
                    <li key={k}>
                      {b.product_id} — {loc('المطلوب', 'needed', 'پێویست')} {b.needed}, {loc('المتاح', 'available', 'بەردەست')}{' '}
                      {b.available} — {whyBlocked(b.reason)}{' '}
                      <span className="text-[10px] text-[var(--ap-text-3)]" dir="ltr">
                        ({b.reason})
                      </span>
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
          </div>
        )}
      </SectionCard>

      <div className="flex items-center justify-end gap-2 pb-6">
        <button type="button" className={btnDanger} onClick={() => setEditing(null)}>
          {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
        </button>
        <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
          {loc('حفظ', 'Save', 'پاشەکەوت')}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${T.surface} px-3 py-2 min-w-0`}>
      <p className="text-[11px] text-[var(--ap-text-3)] truncate">{label}</p>
      <p className="text-[13.5px] font-bold text-[var(--ap-text-1)] truncate">{value}</p>
    </div>
  );
}
