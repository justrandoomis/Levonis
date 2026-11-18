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
  return {
    id,
    name_ar: text('name_ar'),
    name_en: text('name_en') || text('name'),
    name_ckb: text('name_ckb') || text('name_ku'),
    image: cover?.url ? String(cover.url) : '',
    from_iqd: fromIqd,
  };
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The name and description in each language. A language is filled only when
 * EVERY member has its name in that language; otherwise it stays empty and the
 * server translates it from the English (or Arabic) one.
 */
export function bundleText(lines: Array<{ m: MemberInfo; qty: number }>): BundleText {
  const one = (pick: (m: MemberInfo) => string) =>
    lines.every((l) => pick(l.m)) ? lines.map((l) => (l.qty > 1 ? `${l.qty}× ${pick(l.m)}` : pick(l.m))) : null;
  const ar = one((m) => m.name_ar);
  const en = one((m) => m.name_en);
  const ckb = one((m) => m.name_ckb);
  const bullets = (names: string[] | null) => (names ? names.map((n) => `• ${n}`).join('\n') : '');
  return {
    name_ar: ar ? cap(`حزمة: ${ar.join(' + ')}`, NAME_MAX) : '',
    name_en: en ? cap(`Bundle: ${en.join(' + ')}`, NAME_MAX) : '',
    name_ckb: ckb ? cap(`پاکێج: ${ckb.join(' + ')}`, NAME_MAX) : '',
    description_ar: ar ? `تضم هذه الحزمة:\n${bullets(ar)}` : '',
    description_en: en ? `This bundle includes:\n${bullets(en)}` : '',
    description_ckb: ckb ? `ئەم پاکێجە پێکهاتووە لە:\n${bullets(ckb)}` : '',
  };
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
 * ONE COVER MADE FROM THE MEMBERS' PICTURES: a 1200×1200 grid on a light
 * stage — one picture full, two side by side, three or four in a 2×2 grid,
 * and «+N» on the last tile when there are more. Returns null when no
 * picture could be read (the save then goes ahead without a cover).
 */
export async function bundleCover(urls: string[]): Promise<File | null> {
  const unique = [...new Set(urls.filter(Boolean))];
  const shown = unique.length > 4 ? unique.slice(0, 3) : unique;
  const extra = unique.length - shown.length;
  const bitmaps = (await Promise.all(shown.map(bitmapOf))).filter((b): b is ImageBitmap => !!b);
  if (!bitmaps.length) return null;

  const W = 1200;
  const pad = 56;
  const gap = 28;
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

  const tiles = bitmaps.length + (extra > 0 ? 1 : 0);
  const inner = W - pad * 2;
  const half = (inner - gap) / 2;
  const rects: Array<[number, number, number, number]> =
    tiles === 1
      ? [[pad, pad, inner, inner]]
      : tiles === 2
        ? [
            [pad, (W - half) / 2, half, half],
            [pad + half + gap, (W - half) / 2, half, half],
          ]
        : [
            [pad, pad, half, half],
            [pad + half + gap, pad, half, half],
            tiles === 3 ? [(W - half) / 2, pad + half + gap, half, half] : [pad, pad + half + gap, half, half],
            [pad + half + gap, pad + half + gap, half, half],
          ];

  const card = (x: number, y: number, w: number, h: number) => {
    ctx.save();
    ctx.shadowColor = 'rgba(40, 30, 10, 0.12)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 32);
    ctx.fill();
    ctx.restore();
  };

  bitmaps.forEach((b, i) => {
    const [x, y, w, h] = rects[i];
    card(x, y, w, h);
    const room = tiles === 1 ? 0.86 : 0.82;
    const scale = Math.min((w * room) / b.width, (h * room) / b.height);
    const dw = b.width * scale;
    const dh = b.height * scale;
    ctx.drawImage(b, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    b.close();
  });

  if (extra > 0) {
    const [x, y, w, h] = rects[bitmaps.length];
    card(x, y, w, h);
    ctx.fillStyle = '#3B3328';
    ctx.font = `700 ${Math.round(w * 0.32)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${extra}`, x + w / 2, y + h / 2);
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  const out = blob ?? (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9)));
  if (!out) return null;
  const ext = out.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([out], `bundle-cover.${ext}`, { type: out.type });
}
