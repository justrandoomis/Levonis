/**
 * THE BUNDLE FILLS ITSELF FROM ITS PRODUCTS (owner, 2026-11-18).
 *
 * The owner picks products; the name, the description and the cover come from
 * them. Nothing here is a price: the money stays the server's (the panel's
 * header rule). The text is a starting point the owner can edit, and a
 * language is left EMPTY when any member lacks it, so the save's own
 * translation fills it (`localizeRespectingAuthored`) instead of this file
 * writing one language's words into another language's field.
 */
import { api } from '../../lib/api';

export interface MemberInfo {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  image: string;
  /** The V2 «from» price; null while the product still needs pricing. */
  from_iqd: number | null;
  /** Each colour's own picture: the colour's `image`, else the first gallery photo tagged with it. */
  colour_images: Record<string, string>;
}

export interface BundleText {
  name_ar: string;
  name_en: string;
  name_ckb: string;
  description_ar: string;
  description_en: string;
  description_ckb: string;
}

const NAME_MAX = 300;

/** One product's admin document, reduced to what the bundle needs. */
export async function loadMember(id: string, fromIqd: number | null = null): Promise<MemberInfo> {
  const res = await api.get<{ product: Record<string, unknown> }>(`/api/admin/products-v2/${encodeURIComponent(id)}`);
  const p = res.product ?? {};
  const media = Array.isArray(p.media) ? (p.media as Array<{ url?: string; primary?: boolean }>) : [];
  const cover = media.find((m) => m.primary && m.url) ?? media.find((m) => m.url);
  const text = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const colour_images: Record<string, string> = {};
  for (const m of media as Array<{ url?: string; color_id?: string | null }>) {
    if (m.url && m.color_id && !colour_images[m.color_id]) colour_images[m.color_id] = String(m.url);
  }
  for (const c of (Array.isArray(p.colors) ? p.colors : []) as Array<{ id?: string; image?: string }>) {
    if (c.id && c.image) colour_images[c.id] = c.image;
  }
  return {
    id,
    name_ar: text('name_ar'),
    name_en: text('name_en') || text('name'),
    name_ckb: text('name_ckb') || text('name_ku'),
    image: cover?.url ? String(cover.url) : '',
    from_iqd: fromIqd,
    colour_images,
  };
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** A line's colour as the text needs it: a name in each language, «random», or none. */
export type LineColour = { ar: string; en: string; ckb: string } | 'random' | null;

const RANDOM_WORD = { ar: 'لون عشوائي', en: 'random colour', ckb: 'ڕەنگی هەڕەمەکی' };

/**
 * The name and description in each language. A language is filled only when
 * EVERY member has its name in that language; otherwise it stays empty and the
 * server translates it from the English (or Arabic) one.
 *
 * Lines of ONE product are counted together in the name («5× eSUN PLA+»), and
 * listed one by one with their colour in the description («• 2× eSUN PLA+ — أسود»).
 */
export function bundleText(lines: Array<{ m: MemberInfo; qty: number; colour?: LineColour }>): BundleText {
  type L = 'ar' | 'en' | 'ckb';
  const nameIn = (m: MemberInfo, l: L) => (l === 'ar' ? m.name_ar : l === 'en' ? m.name_en : m.name_ckb);
  const has = (l: L) => lines.every((x) => nameIn(x.m, l));
  const title = (l: L) => {
    const byProduct = new Map<string, { m: MemberInfo; qty: number }>();
    for (const x of lines) {
      const found = byProduct.get(x.m.id);
      if (found) found.qty += x.qty;
      else byProduct.set(x.m.id, { m: x.m, qty: x.qty });
    }
    return [...byProduct.values()].map((x) => (x.qty > 1 ? `${x.qty}× ${nameIn(x.m, l)}` : nameIn(x.m, l))).join(' + ');
  };
  const bullets = (l: L) =>
    lines
      .map((x) => {
        const colour = x.colour === 'random' ? RANDOM_WORD[l] : x.colour ? x.colour[l] || x.colour.en || x.colour.ar : '';
        return `• ${x.qty > 1 ? `${x.qty}× ` : ''}${nameIn(x.m, l)}${colour ? ` — ${colour}` : ''}`;
      })
      .join('\n');
  return {
    name_ar: has('ar') ? cap(`حزمة: ${title('ar')}`, NAME_MAX) : '',
    name_en: has('en') ? cap(`Bundle: ${title('en')}`, NAME_MAX) : '',
    name_ckb: has('ckb') ? cap(`پاکێج: ${title('ckb')}`, NAME_MAX) : '',
    description_ar: has('ar') ? `تضم هذه الحزمة:\n${bullets('ar')}` : '',
    description_en: has('en') ? `This bundle includes:\n${bullets('en')}` : '',
    description_ckb: has('ckb') ? `ئەم پاکێجە پێکهاتووە لە:\n${bullets('ckb')}` : '',
  };
}

/** One tile of the cover: a picture (the colour's own, else the product's), the colour as a swatch when the
 *  picture is not the colour's, «random» as a rainbow «?», and the count on the corner. */
export interface CoverTile {
  url: string;
  hex?: string;
  random?: boolean;
  qty: number;
}

async function bitmapOf(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/**
 * ONE COVER MADE FROM THE BUNDLE'S LINES: a 1200×1200 grid on a light stage (1, 2 side by side, 2×2, or 3×3
 * from five tiles; «+N» on the last tile beyond nine). Each tile is the line's picture — the colour's own
 * when it has one — with the count in a badge on the corner; a pinned colour without its own picture gets a
 * swatch; «لون عشوائي» is a rainbow with «?». Null when nothing could be drawn.
 */
export async function bundleCover(tilesIn: CoverTile[]): Promise<File | null> {
  const all = tilesIn.filter((t) => t.url || t.random);
  if (!all.length) return null;
  const MAX = 9;
  const shown = all.length > MAX ? all.slice(0, MAX - 1) : all;
  const extra = all.length - shown.length;
  const urls = [...new Set(shown.map((t) => t.url).filter(Boolean))];
  const bitmaps = new Map<string, ImageBitmap>();
  await Promise.all(
    urls.map(async (u) => {
      const b = await bitmapOf(u);
      if (b) bitmaps.set(u, b);
    })
  );
  if (!bitmaps.size && !shown.some((t) => t.random)) return null;

  const W = 1200;
  const count = shown.length + (extra > 0 ? 1 : 0);
  const cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const pad = cols === 3 ? 40 : 56;
  const gap = cols === 3 ? 22 : 28;
  const cell = (W - pad * 2 - gap * (cols - 1)) / cols;
  const top = (W - (cell * rows + gap * (rows - 1))) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = W;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bg = ctx.createLinearGradient(0, 0, W, W);
  bg.addColorStop(0, '#F7F4EE');
  bg.addColorStop(1, '#ECE7DE');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, W);

  const rectOf = (i: number): [number, number] => {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? count - r * cols : cols;
    const left = (W - (cell * inRow + gap * (inRow - 1))) / 2;
    return [left + (i % cols) * (cell + gap), top + r * (cell + gap)];
  };
  const card = (x: number, y: number) => {
    ctx.save();
    ctx.shadowColor = 'rgba(40, 30, 10, 0.12)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(x, y, cell, cell, 32);
    ctx.fill();
    ctx.restore();
  };
  const rainbow = (cx: number, cy: number, r: number) => {
    const stops = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#007AFF', '#AF52DE', '#FF2D55', '#FF3B30'];
    const g = ctx.createConicGradient(0, cx, cy);
    stops.forEach((c, k) => g.addColorStop(k / (stops.length - 1), c));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const badge = (x: number, y: number, qty: number) => {
    const r = Math.round(cell * 0.12);
    const cx = x + cell - r - 14;
    const cy = y + r + 14;
    ctx.save();
    ctx.fillStyle = '#1F1A14';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(3, r * 0.12);
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 ${Math.round(r * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(qty), cx, cy + r * 0.04);
    ctx.restore();
  };

  shown.forEach((t, i) => {
    const [x, y] = rectOf(i);
    card(x, y);
    const b = t.url ? bitmaps.get(t.url) : undefined;
    if (b) {
      const room = 0.8;
      const scale = Math.min((cell * room) / b.width, (cell * room) / b.height);
      const dw = b.width * scale;
      const dh = b.height * scale;
      ctx.save();
      if (t.random) ctx.globalAlpha = 0.35;
      ctx.drawImage(b, x + (cell - dw) / 2, y + (cell - dh) / 2, dw, dh);
      ctx.restore();
    }
    if (t.random) {
      const r = cell * (b ? 0.24 : 0.32);
      const cx = x + cell / 2;
      const cy = y + cell / 2;
      rainbow(cx, cy, r);
      ctx.save();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `900 ${Math.round(r * 1.25)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = r * 0.08;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeText('?', cx, cy + r * 0.06);
      ctx.fillText('?', cx, cy + r * 0.06);
      ctx.restore();
    } else if (t.hex) {
      const r = cell * 0.1;
      const cx = x + r + 18;
      const cy = y + cell - r - 18;
      ctx.save();
      ctx.fillStyle = t.hex;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(3, r * 0.18);
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
      ctx.restore();
    }
    badge(x, y, t.qty);
  });
  for (const b of bitmaps.values()) b.close();

  if (extra > 0) {
    const [x, y] = rectOf(shown.length);
    card(x, y);
    ctx.fillStyle = '#3B3328';
    ctx.font = `700 ${Math.round(cell * 0.32)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${extra}`, x + cell / 2, y + cell / 2);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  const out = blob ?? (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9)));
  if (!out) return null;
  const ext = out.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([out], `bundle-cover.${ext}`, { type: out.type });
}
