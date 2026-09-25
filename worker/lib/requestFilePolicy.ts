/**
 * WHO MAY READ WHAT OF A REQUEST'S FILES — the matrix, in one place (W5-B;
 * audit 03 §2.4, §9 G9, §11 item 18; docs/MERCHANT_PLATFORM.md §4.7).
 *
 *                         original model   picture / document   3D preview
 *   customer (owner)            ✓                  ✓              full mesh
 *   admin                       ✓                  ✓                  —
 *   accepted merchant           ✓                  ✓              full mesh
 *   ELIGIBLE merchant           ✗                  ✓              coarse mesh
 *   anyone else                 ✗                  ✗                  ✗
 *
 * «Eligible» is the live verdict of worker/lib/eligibility.ts for this
 * merchant and this request — the same one that lets them offer — and it is
 * asked only while the request is on the board and Levo Community lets them
 * in (`requestFileAccess`'s `board`). A plain account browsing the board sees
 * the job, not the customer's files.
 *
 * WHY A DRAWING IS A «REFERENCE» AND A MODEL IS NOT. A 3D model is the thing
 * itself: whoever holds the file can print it, so before acceptance a
 * merchant gets a derived preview, never the bytes. A picture or a PDF
 * drawing is what a merchant must read to price the job at all and has no
 * derived form, so an eligible merchant may view it. (DECISIONS row 134 (أ) —
 * the owner may move documents to the «original» column.)
 *
 * EVERY READ IS COUNTED in `request_file_reads` (0132): one row per file,
 * reader, kind of read and hour, its count rising with each read.
 */

import type { Env, SessionUser } from './types';
import { newId } from './crypto';
import { requestFileAccess, type RequestForAccess } from './communityRequests';
import { liveVerdictForUser, type Verdict } from './printMatchingStore';

export type FileReader = 'owner' | 'admin' | 'engaged' | 'eligible';
export type FileClass = 'model' | 'image' | 'document';
export type ReadKind = 'original' | 'inline' | 'preview_link' | 'preview_meta' | 'preview_mesh' | 'costing';
/** What a 3D-preview link grants: the stored mesh, or the coarse one derived from it. */
export type PreviewGrant = 'full' | 'preview';

/** The class of an attachment, from its sniffed kind and type (never its name). */
export function fileClass(kind: string, contentType: string): FileClass {
  if (kind === 'model') return 'model';
  if (String(contentType).startsWith('image/')) return 'image';
  return 'document';
}

/** THE MATRIX: may this reader have this class of file's bytes. */
export function mayReadBytes(reader: FileReader | null, cls: FileClass): boolean {
  if (!reader) return false;
  if (reader === 'owner' || reader === 'admin' || reader === 'engaged') return true;
  return cls !== 'model';
}

/** What a 3D preview this reader may open shows. Null = no preview for them. */
export function previewGrantFor(reader: FileReader | null): PreviewGrant | null {
  if (reader === 'owner' || reader === 'engaged') return 'full';
  if (reader === 'eligible') return 'preview';
  return null;
}

export interface ReaderAnswer {
  reader: FileReader | null;
  /** The only way in was the board, and Levo Community is shut to this caller. */
  gateClosed: boolean;
  /** The live verdict, when one was asked (a merchant on the board). */
  verdict: Verdict | null;
  /** The caller may see the request at all (a party to it, or it is on the board for them). */
  visible: boolean;
}

/**
 * WHO IS THIS CALLER TO THIS REQUEST'S FILES — re-derived on every read. The
 * customer, an admin (when the door allows admins), the accepted merchant,
 * or a merchant whose live verdict is eligible; else nobody.
 */
export async function fileReader(
  env: Env,
  r: RequestForAccess,
  user: SessionUser | null | undefined,
  opts: { allowAdmin: boolean }
): Promise<ReaderAnswer> {
  const base = await requestFileAccess(env, r, user, opts);
  if (base.gateClosed) return { reader: null, gateClosed: true, verdict: null, visible: false };
  if (base.access === 'owner' || base.access === 'admin' || base.access === 'engaged') {
    return { reader: base.access, gateClosed: false, verdict: null, visible: true };
  }
  if (base.access !== 'board' || !user) return { reader: null, gateClosed: false, verdict: null, visible: false };
  const live = await liveVerdictForUser(env, r.id, user.id);
  return { reader: live?.verdict.eligible ? 'eligible' : null, gateClosed: false, verdict: live?.verdict ?? null, visible: true };
}

/** One counted read, for the caller's batch (or `.run()`). */
export function fileReadStatement(
  db: D1Database,
  p: { requestId: string; fileId: string; userId: string; reader: FileReader; what: ReadKind; revision: number },
  ts: string = new Date().toISOString()
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO request_file_reads (id, request_id, file_id, user_id, access, what, revision, hour, count, first_at, last_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)
       ON CONFLICT (file_id, user_id, what, hour) DO UPDATE SET
         count = request_file_reads.count + 1, last_at = excluded.last_at, revision = excluded.revision`
    )
    .bind(newId('rfr'), p.requestId, p.fileId, p.userId, p.reader, p.what, p.revision, ts.slice(0, 13), ts);
}

// ------------------------------------------------------- the coarse preview

/** The most triangles a merchant's pre-acceptance preview carries. */
export const COARSE_PREVIEW_MAX_TRIANGLES = 20_000;

/**
 * THE PREVIEW AN ELIGIBLE MERCHANT SEES — derived from the stored preview
 * mesh (LVM1: 'LVM1', u32 triangle count, 6×f32 box, 9×f32 per triangle),
 * never from the customer's file: at most `COARSE_PREVIEW_MAX_TRIANGLES`
 * triangles (a fixed stride keeps the shape recognisable) and every
 * coordinate snapped to a grid of max(0.25 mm, longest edge / 400). Enough to
 * judge the job — its size, its overhangs, its detail — and not a file
 * anyone would print. Returns null for bytes that are not an LVM1 mesh.
 */
export function coarsePreviewMesh(input: Uint8Array, maxTriangles = COARSE_PREVIEW_MAX_TRIANGLES): Uint8Array | null {
  if (input.byteLength < 32 || input[0] !== 0x4c || input[1] !== 0x56 || input[2] !== 0x4d || input[3] !== 0x31) return null;
  const src = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const count = src.getUint32(4, true);
  if (input.byteLength < 32 + count * 36) return null;
  const box = [0, 1, 2, 3, 4, 5].map((i) => src.getFloat32(8 + i * 4, true));
  const longest = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const grid = Math.max(0.25, (Number.isFinite(longest) ? longest : 0) / 400);
  const snap = (v: number) => Math.round(v / grid) * grid;
  const stride = Math.max(1, Math.ceil(count / Math.max(1, maxTriangles)));
  const kept = Math.floor(count / stride);
  const out = new Uint8Array(32 + kept * 36);
  const dst = new DataView(out.buffer);
  out.set([0x4c, 0x56, 0x4d, 0x31], 0);
  dst.setUint32(4, kept, true);
  box.forEach((v, i) => dst.setFloat32(8 + i * 4, snap(v), true));
  let at = 32;
  for (let k = 0; k < kept; k++) {
    const from = 32 + k * stride * 36;
    for (let j = 0; j < 9; j++) {
      dst.setFloat32(at, snap(src.getFloat32(from + j * 4, true)), true);
      at += 4;
    }
  }
  return out;
}
