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
  return tracksVerdict(b, moov);
}

/** Does this `moov` hold a video track in a codec a browser plays? */
function tracksVerdict(b: Uint8Array, moov: Box): VideoSniff {
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

/**
 * IS THE INDEX IN FRONT OF THE FRAMES? — the «faststart» question.
 *
 * An MP4 plays as it downloads only when its `moov` box (the index: where
 * every frame sits) comes BEFORE its `mdat` (the frames). Most phone cameras
 * and many desktop encoders write the index LAST, because they only know the
 * frame table when recording ends; a browser handed such a file must fetch
 * the whole `mdat` — forty megabytes over Iraqi mobile data — before it can
 * show frame one, and on a range-capable server it does that by seeking to
 * the end and back. The fix is the encoder's own «fast start» / «web
 * optimized» option (ffmpeg `-movflags +faststart`), which moves the index,
 * so the upload route WARNS rather than refuses: the file is playable, it is
 * merely slow to start, and the merchant can re-export it when they see the
 * hint (`VIDEO_NOT_FASTSTART`, src/lib/refusalStrings.ts).
 *
 * Only meaningful for an MP4 `sniffVideo` accepted. `true` for anything that
 * is not an MP4 with both boxes (a WebM streams by construction; an MP4
 * without `mdat` has nothing to wait for), so a caller can ask
 * unconditionally and warn only on a false.
 */
export function mp4IsFastStart(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || fourcc(bytes, 4) !== 'ftyp') return true;
  const top = boxes(bytes, 0, bytes.length, true);
  if (!top) return true;
  const moov = top.findIndex((x) => x.type === 'moov');
  const mdat = top.findIndex((x) => x.type === 'mdat');
  if (moov < 0 || mdat < 0) return true;
  return moov < mdat;
}

/**
 * FAST START, DECIDED FROM THE FIRST BYTES ALONE (an ad must be: DECISIONS row
 * 300). `mp4IsFastStart` needs the whole chain of top-level boxes, so on a head
 * it answers true for what it cannot see; this one walks the box headers in order
 * and stops at the first of `moov` or `mdat`, which is the question. False for
 * `mdat` first, and false when neither is reached (nothing shows the index is
 * near the front, so a phone cannot be promised it is).
 */
export function mp4IndexComesFirst(head: Uint8Array): boolean {
  if (head.length < 16 || fourcc(head, 4) !== 'ftyp') return false;
  let at = 0;
  while (at + 8 <= head.length) {
    const type = fourcc(head, at + 4);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    let size = u32(head, at);
    if (size === 1) {
      if (at + 16 > head.length) return false;
      size = u32(head, at + 8) * 0x100000000 + u32(head, at + 12);
    }
    if (size < 8) return false;
    at += size;
  }
  return false;
}

/** No film's index is this large (a 47-second film's is a few KiB): beyond it, it is not read into memory. */
const MOOV_READ_CAP = 8 * 1024 * 1024;

/**
 * IS THIS STORED MP4 WHOLE, AND A FILM? — WITHOUT READING THE FILM (owner's ad,
 * DECISIONS row 300).
 *
 * The session door stores files far too large to read back whole, so it proves a
 * head, and a head cannot chain to the end of the file: for a merchant's clip it
 * then takes the container on trust and warns. An ad is what a customer must watch
 * to the end to be paid, so it asks what the whole-body door's `sniffVideo` asks:
 *
 *   whole    every top-level box up to and including the first `mdat` ends inside
 *            the bytes that arrived: a file cut off mid-way declares frames it
 *            does not have, and could never reach its end on a phone;
 *   a film   its `moov` holds a video track in a codec browsers play, not sound
 *            alone. A `moov` past the head is read on its own, so this costs at
 *            most a few small ranges of a file of any size.
 *
 * It answers only for an MP4 whose index comes first (`mp4IndexComesFirst`, which
 * both doors ask before this).
 */
export async function sniffStoredMp4(
  head: Uint8Array,
  bytes: number,
  read: (offset: number, length: number) => Promise<Uint8Array>
): Promise<VideoSniff> {
  const malformed: VideoSniff = { ok: false, reason: 'malformed' };
  if (head.length < 16 || fourcc(head, 4) !== 'ftyp') return malformed;
  const major = fourcc(head, 8);
  if (IMAGE_BRANDS.has(major)) return { ok: false, reason: 'image_container' };
  if (AUDIO_BRANDS.has(major)) return { ok: false, reason: 'audio_only' };

  let moov: { start: number; end: number } | null = null;
  let frames = false;
  let at = 0;
  // A real film reaches its frames in a handful of boxes; a chain that does not is not one.
  for (let step = 0; step < 64 && at < bytes && !frames; step++) {
    const wanted = Math.min(16, bytes - at);
    const header = at + wanted <= head.length ? head.subarray(at, at + wanted) : await read(at, wanted);
    if (header.length < 8) return malformed;
    const type = fourcc(header, 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return malformed;
    let size = u32(header, 0);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return malformed;
      size = u32(header, 8) * 0x100000000 + u32(header, 12);
      headerSize = 16;
    } else if (size === 0) {
      // "To the end of the file": only the last box may say so, which is what it then is.
      size = bytes - at;
    }
    if (size < headerSize || at + size > bytes) return malformed;
    if (type === 'moov' && !moov) moov = { start: at, end: at + size };
    if (type === 'mdat') frames = true;
    at += size;
  }
  if (!moov || !frames) return malformed;

  const length = moov.end - moov.start;
  if (length > MOOV_READ_CAP) return malformed;
  const index = moov.end <= head.length ? head.subarray(moov.start, moov.end) : await read(moov.start, length);
  if (index.length !== length) return malformed;
  const headerSize = u32(index, 0) === 1 ? 16 : 8;
  return tracksVerdict(index, { type: 'moov', start: 0, body: headerSize, end: length });
}
