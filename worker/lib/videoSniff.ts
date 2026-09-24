/**
 * IS THIS REALLY A VIDEO A BROWSER CAN PLAY? — MP4 and WebM, read from their
 * own structure, never from a file name or a declared type.
 *
 * A merchant's product or store-page video is served to every visitor from
 * the platform's own origin (`/files/…`). The upload route already refuses
 * what its magic-byte sniff cannot name; for a merchant video it asks more:
 * the file must BE the container it starts like, all the way through its
 * top-level structure, and carry a video track in a codec browsers play.
 * A text file, an HTML page or an image with an `ftyp` or EBML prefix glued
 * on, a HEIC photograph (an ISO-BMFF file too), an audio-only M4A, or a
 * Matroska file in a codec nothing here plays — each is refused with a
 * reason, never stored.
 *
 *   MP4    the top-level boxes chain from byte 0 to the end of the file (a
 *          final `mdat` of size 0 runs to the end), the first is `ftyp` with a
 *          brand that is not HEIF / AVIF / audio-only, a `moov` is present, and
 *          one of its tracks is a `vide` handler whose sample entry is
 *          avc1/avc3 (H.264), hvc1/hev1 (HEVC), av01 (AV1) or vp09 (VP9).
 *   WebM   an EBML header whose DocType is exactly `webm`, then a Segment,
 *          and in its Tracks a video track (TrackType 1) with CodecID V_VP8,
 *          V_VP9 or V_AV1. Sizes may be "unknown" (a MediaRecorder file): the
 *          element then runs to the end of its parent.
 */

export type VideoSniff =
  | { ok: true; mime: 'video/mp4' | 'video/webm'; ext: 'mp4' | 'webm'; codec: string }
  | { ok: false; reason: 'not_video' | 'malformed' | 'no_video_track' | 'codec_unsupported' | 'audio_only' | 'image_container' };

const MP4_VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09']);
const WEBM_VIDEO_CODECS = new Set(['V_VP8', 'V_VP9', 'V_AV1']);
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

interface Box {
  type: string;
  start: number;
  /** Where the payload starts. */
  body: number;
  end: number;
}

/** The boxes between `from` and `to`, or null when their sizes do not chain exactly. */
function boxes(b: Uint8Array, from: number, to: number, top: boolean): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    if (to - at < 8) return null;
    let size = u32(b, at);
    const type = fourcc(b, at + 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    let header = 8;
    if (size === 1) {
      if (to - at < 16) return null;
      const hi = u32(b, at + 8);
      const lo = u32(b, at + 12);
      if (hi > 0x1fffff) return null;
      size = hi * 0x100000000 + lo;
      header = 16;
    } else if (size === 0) {
      // "to the end of the file" — only legal for the last top-level box.
      if (!top) return null;
      size = to - at;
    }
    if (size < header || at + size > to) return null;
    out.push({ type, start: at, body: at + header, end: at + size });
    at += size;
    if (out.length > 10_000) return null;
  }
  return out;
}

function child(b: Uint8Array, parent: Box, type: string, skip = 0): Box | null {
  const list = boxes(b, parent.body + skip, parent.end, false);
  return list?.find((x) => x.type === type) ?? null;
}

function sniffMp4(b: Uint8Array): VideoSniff {
  const top = boxes(b, 0, b.length, true);
  if (!top || !top.length) return { ok: false, reason: 'malformed' };
  const ftyp = top[0];
  if (ftyp.type !== 'ftyp' || ftyp.end - ftyp.body < 8) return { ok: false, reason: 'malformed' };
  const major = fourcc(b, ftyp.body);
  if (IMAGE_BRANDS.has(major)) return { ok: false, reason: 'image_container' };
  if (AUDIO_BRANDS.has(major)) return { ok: false, reason: 'audio_only' };
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return { ok: false, reason: 'malformed' };
  const traks = (boxes(b, moov.body, moov.end, false) ?? []).filter((x) => x.type === 'trak');
  let sawVideo = false;
  for (const trak of traks) {
    const mdia = child(b, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = child(b, mdia, 'hdlr');
    // hdlr: version+flags (4), pre_defined (4), handler_type (4)
    if (!hdlr || hdlr.end - hdlr.body < 12 || fourcc(b, hdlr.body + 8) !== 'vide') continue;
    sawVideo = true;
    const minf = child(b, mdia, 'minf');
    const stbl = minf ? child(b, minf, 'stbl') : null;
    const stsd = stbl ? child(b, stbl, 'stsd') : null;
    // stsd: version+flags (4), entry_count (4), then sample entries (boxes)
    const entry = stsd ? boxes(b, stsd.body + 8, stsd.end, false)?.[0] : null;
    if (entry && MP4_VIDEO_CODECS.has(entry.type)) return { ok: true, mime: 'video/mp4', ext: 'mp4', codec: entry.type };
  }
  return { ok: false, reason: sawVideo ? 'codec_unsupported' : 'no_video_track' };
}

// ----------------------------------------------------------------- WebM

/** An EBML variable-length integer: its value and its length, or null. */
function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  if (at >= b.length) return null;
  const first = b[at];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface Element {
  id: number;
  body: number;
  end: number;
}

function elements(b: Uint8Array, from: number, to: number, stopAtCluster: boolean): Element[] | null {
  const out: Element[] = [];
  let at = from;
  while (at < to) {
    const id = vint(b, at, true);
    if (!id) return null;
    const size = vint(b, at + id.length, false);
    if (!size) return null;
    const body = at + id.length + size.length;
    const end = size.unknown ? to : body + size.value;
    if (end > to) {
      // A truncated last element is tolerated only for a Cluster (the media).
      if (id.value === 0x1f43b675) {
        out.push({ id: id.value, body, end: to });
        return out;
      }
      return null;
    }
    out.push({ id: id.value, body, end });
    if (stopAtCluster && id.value === 0x1f43b675) return out;
    at = end;
    if (out.length > 100_000) return null;
  }
  return out;
}

function sniffWebm(b: Uint8Array): VideoSniff {
  const top = elements(b, 0, b.length, true);
  if (!top || top[0]?.id !== 0x1a45dfa3) return { ok: false, reason: 'malformed' };
  const header = elements(b, top[0].body, top[0].end, false);
  const docType = header?.find((e) => e.id === 0x4282);
  if (!docType || new TextDecoder().decode(b.subarray(docType.body, docType.end)) !== 'webm') return { ok: false, reason: 'not_video' };
  const segment = top.find((e) => e.id === 0x18538067);
  if (!segment) return { ok: false, reason: 'malformed' };
  const children = elements(b, segment.body, segment.end, true);
  if (!children) return { ok: false, reason: 'malformed' };
  const tracks = children.find((e) => e.id === 0x1654ae6b);
  if (!tracks) return { ok: false, reason: 'no_video_track' };
  let sawVideo = false;
  for (const entry of (elements(b, tracks.body, tracks.end, false) ?? []).filter((e) => e.id === 0xae)) {
    const fields = elements(b, entry.body, entry.end, false) ?? [];
    const type = fields.find((e) => e.id === 0x83);
    if (!type || b[type.end - 1] !== 1) continue;
    sawVideo = true;
    const codec = fields.find((e) => e.id === 0x86);
    const name = codec ? new TextDecoder().decode(b.subarray(codec.body, codec.end)) : '';
    if (WEBM_VIDEO_CODECS.has(name)) return { ok: true, mime: 'video/webm', ext: 'webm', codec: name };
  }
  return { ok: false, reason: sawVideo ? 'codec_unsupported' : 'no_video_track' };
}

export function sniffVideo(bytes: Uint8Array): VideoSniff {
  if (bytes.length < 16) return { ok: false, reason: 'not_video' };
  if (fourcc(bytes, 4) === 'ftyp') return sniffMp4(bytes);
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return sniffWebm(bytes);
  return { ok: false, reason: 'not_video' };
}
