/**
 * Body size caps (`01-TARGET.md` §3.2 step 5).
 *
 * The default is 1 MB. The exceptions are not guessed: each row names the
 * exact call site in `worker/routes/` and the constant that call site checks,
 * and `test/uploadClasses.test.ts` re-reads both out of the source — a new
 * `c.req.formData()` mount, or a raised constant, fails the suite until this
 * table is updated. That is the "generated from the code rather than guessed"
 * requirement, run as a test instead of a codegen step so it cannot go stale.
 *
 * THE CAP IS ON THE ENVELOPE, NOT THE FILE. `Content-Length` counts the whole
 * multipart body: boundaries, part headers, the other fields. The gateway
 * allows `maxBytes + FORM_OVERHEAD_BYTES` for a multipart class and leaves the
 * exact per-file refusal — with its precise "max 40 MB" message — to the route
 * that already produces it. The gateway stops a body that could not possibly
 * be legitimate before an isolate reads it; it does not duplicate validation.
 *
 * JSON CLASSES EXIST FOR THE SAME REASON. `POST /api/admin/template/apply`
 * carries a self-contained TXT backup, including internal media bytes.
 * Its explicit JSON byte limit matches core: a flat 1 MB cap would refuse a
 * real admin save at the edge, with no route ever seeing it. Admin bodies are
 * authenticated, apex-only and `admin-write` rate-limited, so a larger cap
 * there costs nothing an anonymous surface would pay.
 *
 * `BODY_LIMIT_MODE=log` is the escape hatch: it counts what it would have
 * refused and forwards anyway. It exists so that a body the dark parity corpus
 * finds and this table did not anticipate is a var change, not an incident.
 */

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const FORM_OVERHEAD_BYTES = 256 * 1024;

const MB = 1024 * 1024;

export interface BodyClass {
  /** matched with `startsWith` against the request path */
  prefix: string;
  methods: readonly string[];
  kind: 'multipart' | 'json';
  /** the largest legitimate payload the route accepts */
  maxBytes: number;
  /** `<file>#<constant>` — where the number comes from */
  source: string;
  /** the route file that must still contain the upload call for a multipart row to be justified */
  routeFile?: string;
}

export const UPLOAD_CLASSES: readonly BodyClass[] = [
  { prefix: '/api/uploads', methods: ['POST'], kind: 'multipart', maxBytes: 40 * MB, source: 'worker/routes/uploads.ts#VIDEO_MAX', routeFile: 'uploads.ts' },
  { prefix: '/api/kyc/upload', methods: ['POST'], kind: 'multipart', maxBytes: 8 * MB, source: 'worker/routes/kyc.ts#IMAGE_MAX', routeFile: 'kyc.ts' },
  { prefix: '/api/marketplace/requests', methods: ['POST'], kind: 'multipart', maxBytes: 40 * MB, source: 'worker/lib/attachments.ts#MODEL_MAX_BYTES', routeFile: 'marketplace.ts' },
  { prefix: '/api/reviews/uploads', methods: ['POST'], kind: 'multipart', maxBytes: 40 * MB, source: 'worker/routes/reviews.ts#VIDEO_MAX', routeFile: 'reviews.ts' },
  { prefix: '/api/devices/claims/upload', methods: ['POST'], kind: 'multipart', maxBytes: 40 * MB, source: 'worker/routes/devices.ts#CLAIM_VIDEO_MAX', routeFile: 'devices.ts' },
  { prefix: '/api/admin/import', methods: ['POST'], kind: 'multipart', maxBytes: 40 * MB, source: 'worker/routes/adminImport.ts#MAX_ZIP_BYTES', routeFile: 'adminImport.ts' },
  { prefix: '/api/admin/template/parse-zip', methods: ['POST'], kind: 'multipart', maxBytes: 15 * MB, source: 'worker/routes/template.ts#MAX_ZIP_BYTES', routeFile: 'template.ts' },
];

export const JSON_CLASSES: readonly BodyClass[] = [
  // Self-contained TXT backups carry checked base64 assets; enforce the same JSON byte cap as core.
  { prefix: '/api/admin/template', methods: ['POST'], kind: 'json', maxBytes: 48 * MB, source: 'worker/lib/templateMedia.ts#MAX_TEMPLATE_BODY_BYTES' },
  // Every other admin mutation: apex-only, admin-authenticated, admin-write
  // limited. A product save with every option, colour, variant and translation
  // is the biggest of them and stays far below this.
  { prefix: '/api/admin', methods: ['POST', 'PUT', 'PATCH'], kind: 'json', maxBytes: 4 * MB, source: 'policy: admin surfaces are authenticated and apex-only' },
];

export const BODY_CLASSES: readonly BodyClass[] = [...UPLOAD_CLASSES, ...JSON_CLASSES];

/** The largest body the gateway will forward for this request. */
export function maxBodyBytes(path: string, method: string, classes: readonly BodyClass[] = BODY_CLASSES): number {
  let best: BodyClass | null = null;
  for (const u of classes) {
    if (!path.startsWith(u.prefix)) continue;
    if (!u.methods.includes(method.toUpperCase())) continue;
    if (!best || u.prefix.length > best.prefix.length || (u.prefix.length === best.prefix.length && u.maxBytes > best.maxBytes)) best = u;
  }
  return best ? best.maxBytes + (best.kind === 'multipart' ? FORM_OVERHEAD_BYTES : 0) : DEFAULT_MAX_BODY_BYTES;
}
