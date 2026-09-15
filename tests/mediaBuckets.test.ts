/**
 * THE MEDIA BUCKETS: which binding points where, and what happens when the
 * bucket a binding names does not exist.
 *
 * WHY THIS FILE EXISTS. `wrangler.jsonc` binds `R2_PUBLIC` and `R2_PRIVATE`
 * for production to `levonis-media-public` and `levonis-media-private`, and
 * NEITHER bucket exists on the account. A wrangler config is not validated
 * against the account at deploy time, so nothing anywhere said so.
 *
 * `mediaBucket()` resolves a binding with `env.R2_PUBLIC ?? env.BUCKET`, which
 * answers exactly one question — "is there a binding?" — and a binding to a
 * bucket that was never created is a perfectly ordinary `R2Bucket` object:
 * not null, not undefined. So `??` never fired, the legacy fallback below it
 * was unreachable, and the R2 rejection propagated straight out of
 * `getMediaObject` into a 500 for every image on the page, with a perfectly
 * good legacy copy one line further down.
 *
 * The tests below hold three things still:
 *   1. a bound-but-missing bucket is survivable and is reported;
 *   2. the legacy fallback is LOGGED, so "is the migration finished?" is
 *      answerable from the Worker's logs instead of from belief;
 *   3. the split rule has exactly one implementation, and the migration
 *      workflow imports it rather than restating it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deleteMediaObject,
  getMediaObject,
  headMediaObject,
  mediaBindingName,
  mediaBucket,
  MediaBucketUnavailableError,
  probeMediaBucket,
  putMediaObject,
} from '../worker/lib/mediaStorage';
import { planLegacyMediaKey } from '../worker/lib/mediaMigration';

// --------------------------------------------------------------- R2 stubs

/** A bucket that exists. */
class LiveBucket {
  objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? ({ key, size: value.length } as unknown as R2ObjectBody) : null;
  }
  async head(key: string) {
    const value = this.objects.get(key);
    return value ? ({ key, size: value.length } as unknown as R2Object) : null;
  }
  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    this.objects.set(key, new Uint8Array(value as ArrayBuffer));
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/**
 * A bucket that is BOUND and does not exist. Every operation rejects the way
 * R2 does — which is the whole point: it is indistinguishable from a healthy
 * binding until something actually calls it.
 */
class MissingBucket {
  calls = 0;
  private boom(): never {
    this.calls += 1;
    throw new Error('The specified bucket does not exist.');
  }
  async get(_key: string): Promise<never> { return this.boom(); }
  async head(_key: string): Promise<never> { return this.boom(); }
  async put(_key: string, _value: unknown): Promise<never> { return this.boom(); }
  async delete(_key: string): Promise<never> { return this.boom(); }
}

interface Captured<T> { result: T; warn: string[]; error: string[] }

/** Runs `fn` with console.warn/error captured, and always restores them. */
async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const warn: string[] = [];
  const error: string[] = [];
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = (...args: unknown[]) => { warn.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { error.push(args.join(' ')); };
  try {
    return { result: await fn(), warn, error };
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
}

const KEY = 'products/prd_1/gallery/abc123.webp';
const PRIVATE_KEY = 'chat/u1/attachments/abc123.webp';

// ------------------------------------------------ 1. the bound-missing bucket

test('a binding to a bucket that does not exist is survived, not propagated as a 500', async () => {
  const legacy = new LiveBucket();
  legacy.objects.set(KEY, new Uint8Array([1, 2, 3]));
  const broken = new MissingBucket();
  const env = { BUCKET: legacy, R2_PUBLIC: broken, R2_PRIVATE: new LiveBucket() } as never;

  // `??` cannot see the difference: the binding is present, so `mediaBucket`
  // hands back the broken bucket and the legacy one is never reached by it.
  assert.equal(mediaBucket(env, 'public'), broken as never);
  assert.equal(mediaBindingName(env, 'public'), 'R2_PUBLIC');

  const { result, error } = await capture(() => getMediaObject(env, 'public', KEY));
  assert.ok(result, 'the legacy copy must still be served when the dedicated bucket is missing');
  assert.equal(broken.calls, 1, 'the dedicated bucket must be tried first, exactly once');
  assert.equal(error.length, 1, 'the unusable binding must be reported exactly once');
  assert.match(error[0], /^media_primary_bucket_unavailable /);
  const event = JSON.parse(error[0].slice('media_primary_bucket_unavailable '.length));
  assert.equal(event.reason, 'primary_unavailable');
  assert.equal(event.operation, 'get');
  assert.equal(event.binding, 'R2_PUBLIC');
  assert.equal(event.key, KEY);
  assert.match(event.error, /does not exist/);
});

test('head survives the same way, and a miss in both buckets is still just a miss', async () => {
  const legacy = new LiveBucket();
  const broken = new MissingBucket();
  const env = { BUCKET: legacy, R2_PUBLIC: new LiveBucket(), R2_PRIVATE: broken } as never;

  legacy.objects.set(PRIVATE_KEY, new Uint8Array([9]));
  const found = await capture(() => headMediaObject(env, 'private', PRIVATE_KEY));
  assert.ok(found.result, 'a private object must still be reachable through legacy');
  assert.equal(found.error.length, 1);

  // Nothing anywhere holds this key. That is not a fallback and must not be
  // logged as migration residue.
  const absent = await capture(() => headMediaObject(env, 'private', 'chat/u1/attachments/nope.webp'));
  assert.equal(absent.result, null);
  assert.equal(absent.warn.length, 0, 'a miss in both buckets says nothing about the migration');
});

test('a bucket that does not exist is detectable before a customer finds it', async () => {
  const env = { BUCKET: new LiveBucket(), R2_PUBLIC: new LiveBucket(), R2_PRIVATE: new MissingBucket() } as never;
  const good = await probeMediaBucket(env, 'public');
  assert.deepEqual(
    { binding: good.binding, dedicated: good.dedicated, reachable: good.reachable, error: good.error },
    { binding: 'R2_PUBLIC', dedicated: true, reachable: true, error: null }
  );
  const bad = await probeMediaBucket(env, 'private');
  assert.equal(bad.binding, 'R2_PRIVATE');
  assert.equal(bad.dedicated, true);
  assert.equal(bad.reachable, false, 'a bucket that does not exist must not report as reachable');
  assert.match(String(bad.error), /does not exist/);
});

// ------------------------------------------- 2. the migration-progress signal

test('the legacy fallback is logged when it is used, and silent once the object has moved', async () => {
  const legacy = new LiveBucket();
  const dedicated = new LiveBucket();
  const env = { BUCKET: legacy, R2_PUBLIC: dedicated, R2_PRIVATE: new LiveBucket() } as never;

  // Before the move: only the legacy bucket has it.
  legacy.objects.set(KEY, new Uint8Array([7]));
  const before = await capture(() => getMediaObject(env, 'public', KEY));
  assert.ok(before.result);
  assert.equal(before.warn.length, 1, 'a legacy read is what says the migration is unfinished');
  assert.match(before.warn[0], /^media_legacy_fallback /);
  const event = JSON.parse(before.warn[0].slice('media_legacy_fallback '.length));
  assert.equal(event.reason, 'legacy_hit');
  assert.equal(event.binding, 'R2_PUBLIC');
  assert.equal(event.key, KEY);

  // After the move: the dedicated bucket answers and the log goes quiet. That
  // silence is the owner's "the migration is actually finished" signal.
  dedicated.objects.set(KEY, new Uint8Array([7]));
  const after = await capture(() => getMediaObject(env, 'public', KEY));
  assert.ok(after.result);
  assert.equal(after.warn.length, 0, 'once the object is in its own bucket nothing may still report residue');
  assert.equal(after.error.length, 0);
});

// ---------------------------------------------------- 3. writes never fall back

test('a write NEVER falls back to the legacy bucket, and names the binding when it fails', async () => {
  const legacy = new LiveBucket();
  const broken = new MissingBucket();
  const env = { DB: undefined, BUCKET: legacy, R2_PUBLIC: broken, R2_PRIVATE: new LiveBucket() } as never;

  const { error } = await capture(async () => {
    await assert.rejects(
      () =>
        putMediaObject(
          env,
          { key: KEY, visibility: 'public', domain: 'products', mime: 'image/webp', bytes: 1 },
          new Uint8Array([1])
        ),
      (e: unknown) => {
        assert.ok(e instanceof MediaBucketUnavailableError, 'the failure must name the binding, not just R2');
        assert.equal(e.binding, 'R2_PUBLIC');
        assert.match(e.message, /R2_PUBLIC/);
        return true;
      }
    );
  });

  // The whole point of the migration is to STOP filling the legacy bucket.
  assert.equal(legacy.objects.size, 0, 'a failed dedicated write must never be re-routed into the legacy bucket');
  assert.equal(error.length, 1);
  assert.match(error[0], /^media_primary_bucket_unavailable /);
  assert.equal(JSON.parse(error[0].slice('media_primary_bucket_unavailable '.length)).operation, 'put');
});

test('a delete still clears the legacy copy when the dedicated binding is broken', async () => {
  const legacy = new LiveBucket();
  legacy.objects.set(PRIVATE_KEY, new Uint8Array([4]));
  const broken = new MissingBucket();
  const env = { BUCKET: legacy, R2_PUBLIC: new LiveBucket(), R2_PRIVATE: broken } as never;

  await capture(async () => {
    // No fake success: the caller is told the delete did not fully succeed…
    await assert.rejects(() => deleteMediaObject(env, 'private', PRIVATE_KEY));
  });
  // …but the legacy copy — the one the read-through fallback would have served
  // straight back to the world — is gone all the same.
  assert.equal(legacy.objects.has(PRIVATE_KEY), false, 'stopping at the broken binding would leave the file readable');
});

// -------------------------------------------------------- 4. the split rule

test('ONE split rule decides public vs private, and everything unrecognised is private', () => {
  // Public: only namespaces that are already served to anyone who asks.
  for (const key of [
    'products/prd_1/gallery/a.webp',
    'products/import/abc.webp',
    'avatars/u1/a.webp',
    'community/u1/a.webp',
    'users/u1/avatar/a.webp',
    'merchants/m1/logos/a.webp',
    'ui/levonis/logo/a.webp',
    'UIUx/Logo/a.png',
    'brands/b1/a.webp',
    'services/s1/a.webp',
  ]) {
    assert.equal(planLegacyMediaKey(key, true).visibility, 'public', key);
  }

  // Private: everything authorised per request, and everything unknown.
  for (const key of [
    'chat/u1/attachments/a.webp',
    'receipts/u1/evidence/a.pdf',
    'reviews/r1/a.webp',
    'reviews-evidence/u1/a.webp',
    'kyc/u1/a.pdf',
    'warranty/w1/a.pdf',
    'claims/c1/a.webp',
    'orders/o1/a.webp',
    'imports/i1/a.csv',
    'requests/r1/a.stl',
    'support/s1/a.webp',
    'something-nobody-has-seen-before/a.bin',
  ]) {
    assert.equal(planLegacyMediaKey(key, true).visibility, 'private', key);
  }
});

test('an object keeps its key when it only changes bucket, so D1 references stay valid', () => {
  // This is what lets the migration workflow copy without a single database
  // write: visibility selects the BUCKET and is never encoded in the path.
  for (const key of ['products/prd_1/gallery/a.webp', 'chat/u1/attachments/a.webp', 'receipts/u1/e/a.pdf']) {
    assert.equal(planLegacyMediaKey(key, true).destinationKey, key, key);
  }
  // The one exception is the UIUx rename, and it is exactly why the workflow
  // must not perform it: it needs a matching `settings` rewrite in the same
  // D1 batch, which only the admin apply endpoint does.
  assert.notEqual(planLegacyMediaKey('UIUx/Logo/Levonis-Mark.png', true).destinationKey, 'UIUx/Logo/Levonis-Mark.png');
});

// --------------------------------------------- 5. the binding map, from config

const repoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = (text: string) =>
  text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

/** Every `binding -> bucket_name` pair declared in one slice of a config. */
function bucketBindings(section: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /"binding":\s*"([A-Z0-9_]+)",\s*"bucket_name":\s*"([a-z0-9-]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(section)) !== null) out[match[1]] = match[2];
  return out;
}

function storeConfigSections(): Record<'production' | 'staging' | 'dark', Record<string, string>> {
  const bare = stripComments(repoFile('wrangler.jsonc'));
  const envAt = bare.indexOf('"env"');
  const stagingAt = bare.indexOf('"staging"');
  const darkAt = bare.indexOf('"dark"');
  assert.ok(envAt > 0 && stagingAt > envAt && darkAt > stagingAt, 'wrangler.jsonc no longer has the expected env layout');
  return {
    production: bucketBindings(bare.slice(0, envAt)),
    staging: bucketBindings(bare.slice(stagingAt, darkAt)),
    dark: bucketBindings(bare.slice(darkAt)),
  };
}

/**
 * The seven buckets that exist on this Cloudflare account, read from the
 * owner's R2 dashboard. Anything a config binds that is not here does not
 * exist, and a Worker bound to it fails at request time.
 */
const BUCKETS_ON_THE_ACCOUNT = [
  'levonis',
  'levonis-files',
  'levonis-files-staging',
  'levonis-media-private-staging',
  'levonis-media-public-staging',
  'levonis-studio-files',
  'levonis-studio-files-staging',
];

/** Bound by a config, absent from the account. Each one is a latent 500. */
const BOUND_BUT_NOT_PROVISIONED = [
  'levonis-media-public',
  'levonis-media-private',
  'levonis-files-dark',
  'levonis-media-public-dark',
  'levonis-media-private-dark',
];

test('every binding in every environment points where this repository says it does', () => {
  const store = storeConfigSections();
  assert.deepEqual(store.production, {
    BUCKET: 'levonis-files',
    R2_PUBLIC: 'levonis-media-public',
    R2_PRIVATE: 'levonis-media-private',
  });
  assert.deepEqual(store.staging, {
    BUCKET: 'levonis-files-staging',
    R2_PUBLIC: 'levonis-media-public-staging',
    R2_PRIVATE: 'levonis-media-private-staging',
  });
  assert.deepEqual(store.dark, {
    BUCKET: 'levonis-files-dark',
    R2_PUBLIC: 'levonis-media-public-dark',
    R2_PRIVATE: 'levonis-media-private-dark',
  });

  // Studio is a SEPARATE application with its own account resources. Its two
  // buckets are referenced by something, and it must never be handed the
  // store's — docs/STUDIO_PLAN.md decision 4.
  const studio = stripComments(repoFile('studio/wrangler.jsonc'));
  const studioAt = studio.indexOf('"staging"');
  assert.deepEqual(bucketBindings(studio.slice(0, studioAt)), { BUCKET: 'levonis-studio-files' });
  assert.deepEqual(bucketBindings(studio.slice(studioAt)), { BUCKET: 'levonis-studio-files-staging' });
  for (const name of ['levonis-files', 'levonis-media-public', 'levonis-media-private']) {
    assert.ok(!studio.includes(`"bucket_name": "${name}"`), `Studio must not bind the store bucket ${name}`);
  }
});

test('the Worker that actually serves levonis-iq.com binds only buckets that exist', () => {
  // docs/WORKERS.md: levonis-iq.com is served by `levonis-staging`, which is
  // wrangler.jsonc's env.staging block. This is the one environment where a
  // missing bucket would be a live outage rather than a latent one.
  for (const [binding, bucket] of Object.entries(storeConfigSections().staging)) {
    assert.ok(
      BUCKETS_ON_THE_ACCOUNT.includes(bucket),
      `LIVE binding ${binding} points at ${bucket}, which is not on the account`
    );
  }
});

test('every bucket a config binds is classified as existing or as knowingly unprovisioned', () => {
  // A new binding to a bucket nobody created must not slip in unnoticed again.
  const store = storeConfigSections();
  const bound = new Set<string>([
    ...Object.values(store.production),
    ...Object.values(store.staging),
    ...Object.values(store.dark),
    ...Object.values(bucketBindings(stripComments(repoFile('studio/wrangler.jsonc')))),
  ]);
  for (const bucket of bound) {
    assert.ok(
      BUCKETS_ON_THE_ACCOUNT.includes(bucket) || BOUND_BUT_NOT_PROVISIONED.includes(bucket),
      `${bucket} is bound by a wrangler config but is in neither inventory — say which it is`
    );
  }
  // And the reverse claim the report rests on: `levonis` is bound by nothing.
  for (const config of ['wrangler.jsonc', 'studio/wrangler.jsonc']) {
    assert.ok(
      !/"bucket_name":\s*"levonis"/.test(repoFile(config)),
      `${config} now binds the bucket "levonis", which nothing referenced before`
    );
  }
});

// ------------------------------------------------------- 6. the move workflow

const WORKFLOW = '.github/workflows/media-bucket-move.yml';

/** The runner exactly as the workflow's heredoc writes it to disk. */
function embeddedRunner(): string {
  const text = repoFile(WORKFLOW);
  const lines = text.split('\n').map((line) => line.replace(/^ {10}/, ''));
  const start = lines.findIndex((l) => l.startsWith("cat > ./scripts/media-bucket-move.gen.ts <<'TSEOF'"));
  const end = lines.findIndex((l, i) => i > start && l === 'TSEOF');
  assert.ok(start >= 0 && end > start, 'the workflow no longer embeds a runner the way this test reads it');
  return lines.slice(start + 1, end).join('\n');
}

test('the move workflow is gated twice and job 1 cannot delete anything', () => {
  const text = repoFile(WORKFLOW);
  assert.match(text, /\[ "\$\{\{ inputs\.confirm \}\}" = "MIGRATE-MEDIA" \]/, 'job 1 must be gated on a typed phrase');
  assert.match(text, /\[ "\$\{\{ inputs\.delete_confirm \}\}" = "DELETE-LEGACY-SOURCE" \]/, 'job 2 needs its OWN phrase');
  assert.match(text, /\n {2}prune:\n(?: {4}.*\n)* {4}needs: copy\n/, 'the delete job must depend on the verified copy job');
  assert.match(text, /\n {4}if: \$\{\{ inputs\.delete_confirm != '' \}\}\n/, 'the delete job must be skipped unless the owner asked for it');

  const runner = embeddedRunner();
  // An absent MODE must land in the copy branch, never the delete branch.
  assert.match(runner, /const MODE = process\.env\.MODE === 'prune' \? 'prune' : 'copy';/);

  const copyAt = runner.indexOf("if (MODE === 'copy') {");
  const pruneAt = runner.indexOf('const manifest = JSON.parse(readFileSync(MANIFEST');
  const deleteAt = runner.indexOf("'delete-object'");
  const refuseAt = runner.indexOf('refusing to delete anything');
  assert.ok(copyAt > 0 && pruneAt > copyAt, 'the copy branch must come first');
  assert.ok(deleteAt > pruneAt, 'the only delete must live inside the prune branch');
  assert.ok(refuseAt > pruneAt && refuseAt < deleteAt, 'the prune branch must refuse an unverified manifest BEFORE it deletes');
  assert.equal(runner.split("'delete-object'").length - 1, 1, 'there must be exactly one delete in the whole runner');
  // Buckets are the owner's decision, in the dashboard. Not this workflow's.
  for (const forbidden of ['delete-bucket', 'bucket delete', 'create-bucket', 'bucket create']) {
    assert.ok(!text.includes(forbidden), `the workflow must never ${forbidden}`);
  }
});

test('the workflow verifies every copy before it calls it done', () => {
  const runner = embeddedRunner();
  // Size is necessary and not sufficient; the content proof is the other half.
  assert.match(runner, /ContentLength\) !== source\.size/);
  assert.match(runner, /method: 'etag'/);
  assert.match(runner, /method: 'sha256'/);
  // Re-runnable: an object already at its destination is verified, not re-sent.
  assert.match(runner, /head-object', '--bucket', destination/);
  // A partial listing is a partial migration; the cursor must be followed out.
  assert.match(runner, /NextContinuationToken/);
  assert.match(runner, /--no-paginate/);
});

test('the workflow reuses the repository split rule instead of restating it', () => {
  const runner = embeddedRunner();
  assert.match(runner, /import \{ planLegacyMediaKey \} from '\.\.\/worker\/lib\/mediaMigration';/);
  assert.match(runner, /const plan = planLegacyMediaKey\(object\.key, true\);/);
  assert.match(runner, /plan\.visibility === 'public' \? PUBLIC_BUCKET : PRIVATE_BUCKET/);
  // A second copy of the rule is exactly what must not appear. The prefix
  // tests in `isAnonymousPublicMediaKey` are the shape it would take.
  assert.ok(!/startsWith\(['"]/.test(runner), 'the runner must not carry its own prefix rule');
  assert.ok(!runner.includes('isAnonymousPublicMediaKey'), 'the runner must go through planLegacyMediaKey, not around it');
});

test('the docs the owner follows name the same buckets the config binds', () => {
  const doc = repoFile('docs/MEDIA_STORAGE.md');
  const store = storeConfigSections();
  for (const bucket of [...Object.values(store.production), ...Object.values(store.staging)]) {
    assert.ok(doc.includes(bucket), `docs/MEDIA_STORAGE.md does not mention ${bucket}`);
  }
  assert.ok(doc.includes('MIGRATE-MEDIA'), 'the doc must tell the owner what to type');
  assert.ok(doc.includes('DELETE-LEGACY-SOURCE'), 'the doc must tell the owner the second phrase');
  assert.ok(doc.includes('media_legacy_fallback'), 'the doc must say how to tell the migration is finished');
});

// ------------------------------------------- 7. the folder-marker workflow
//
// `UiUx/Logo/` and `UiUx/Logo/Logo.webp` are two unrelated keys that share a
// prefix; only the first is an empty artefact. A workflow that can remove the
// marker must be structurally incapable of reaching the logo, and "structurally"
// means the set of deletable keys is a constant in the file — not an input, not
// a prefix, not a pattern. These tests are what stop that from being relaxed
// later by someone who reads `--recursive` as a convenience.

const MARKER_WORKFLOW = '.github/workflows/media-folder-markers-remove.yml';

function markerRunner(): string {
  const text = repoFile(MARKER_WORKFLOW);
  const lines = text.split('\n').map((line) => line.replace(/^ {10}/, ''));
  const start = lines.findIndex((l) => l.startsWith("cat > ./scripts/media-folder-markers.gen.ts <<'TSEOF'"));
  const end = lines.findIndex((l, i) => i > start && l === 'TSEOF');
  assert.ok(start >= 0 && end > start, 'the marker workflow no longer embeds a runner the way this test reads it');
  return lines.slice(start + 1, end).join('\n');
}

test('the four deletable keys are a constant, not something anyone can type', () => {
  const text = repoFile(MARKER_WORKFLOW);
  const runner = markerRunner();

  assert.match(text, /\[ "\$\{\{ inputs\.confirm \}\}" = "REMOVE-FOLDER-MARKERS" \]/, 'it must be gated on a typed phrase');

  // The allow-list is in the SCRIPT. If a key ever becomes an input, the four
  // literals stop being the only reachable set and this assertion fails.
  for (const marker of ['UiUx/', 'UiUx/Animation/', 'UiUx/Icons/', 'UiUx/Logo/']) {
    assert.ok(runner.includes(`'${marker}'`), `the runner must name ${marker} literally`);
  }
  assert.ok(!/inputs\.(key|keys|prefix|marker)/.test(text), 'the keys must never come from an input');
  assert.match(runner, /const MARKERS = \[/, 'the allow-list must be a constant');
});

test('the marker workflow can only ever delete one object at a time', () => {
  const text = repoFile(MARKER_WORKFLOW);
  const runner = markerRunner();

  // `delete-object` is singular and takes exactly one --key. Every one of these
  // forms CAN take a prefix, so none of them may appear anywhere in the file.
  for (const recursive of ['delete-objects', '--recursive', 's3 rm', 'delete-bucket', 'bucket delete']) {
    assert.ok(!text.includes(recursive), `the workflow must never use ${recursive}`);
  }
  assert.equal(runner.split("'delete-object'").length - 1, 1, 'there must be exactly one delete call in the whole runner');
  assert.match(runner, /aws\(\['delete-object', '--bucket', BUCKET, '--key', marker\], false\)/,
    'the delete must name a single exact key');
});

test('a marker is proven empty and marker-shaped before it is deleted', () => {
  const runner = markerRunner();
  const headAt = runner.indexOf("awsOrNull(['head-object'");
  const sizeAt = runner.indexOf('if (size !== 0)');
  const shapeAt = runner.indexOf('const shape = markerShape(marker)');
  const beforeAt = runner.indexOf('const before = listUnder(marker)');
  const deleteAt = runner.indexOf("'delete-object'");

  assert.ok(headAt > 0 && headAt < deleteAt, 'the object must be read before it is deleted');
  assert.ok(sizeAt > headAt && sizeAt < deleteAt, 'a non-zero object must be refused BEFORE the delete');
  assert.ok(shapeAt > 0 && shapeAt < deleteAt, 'marker shape must be checked BEFORE the delete');
  assert.ok(beforeAt > 0 && beforeAt < deleteAt, 'the children must be recorded BEFORE the delete, or the check after it proves nothing');

  // The shape test goes through the Worker's own rule, so "is this servable
  // content?" has one answer in this repository.
  assert.match(runner, /import \{ isSafeMediaKey \} from '\.\.\/worker\/lib\/mediaStorage';/);
  assert.ok(!/startsWith\(['"]/.test(runner), 'the runner must not carry its own key rule');
});

test('the marker workflow never opens the destination buckets', () => {
  const text = repoFile(MARKER_WORKFLOW);
  // It reads one bucket. A job that cannot name the public or private bucket
  // cannot damage a verified copy, whatever else goes wrong in it.
  for (const bucket of ['public_bucket', 'private_bucket', 'levonis-media-public', 'levonis-media-private']) {
    assert.ok(!text.includes(bucket), `the marker workflow must not reference ${bucket}`);
  }
});

test('every source delete passes a named per-object gate first', () => {
  const runner = embeddedRunner();
  const gateAt = runner.indexOf('function pruneGate');
  const deleteAt = runner.indexOf("'delete-object'");
  const callAt = runner.indexOf('const refused = pruneGate(row, source)');
  const verifyAt = runner.indexOf('const proof = verify(row.destination, source)');
  assert.ok(gateAt > 0 && gateAt < deleteAt, 'the gate must be defined before the delete');
  assert.ok(callAt > 0 && callAt < deleteAt, 'the gate must be CALLED before the delete');
  assert.ok(verifyAt > callAt && verifyAt < deleteAt, 'the destination is re-proven between the gate and the delete');

  // The five per-object facts. Each is compared, not assumed — a manifest is
  // data, and the one thing a delete must never do is trust it.
  for (const check of [
    'row.verified === true',
    'row.key === source.key',
    'row.destination === PUBLIC_BUCKET || row.destination === PRIVATE_BUCKET',
    'row.destination !== SOURCE',
    'row.destinationKey === row.key',
  ]) {
    assert.ok(runner.includes(check), `the prune gate must check ${check}`);
  }

  // Whole-manifest refusals: one bad row is not a reason to delete the others.
  assert.match(runner, /if \(!manifest\.verified_all \|\| manifestBlocked > 0 \|\| manifestFailed > 0\)/);
  assert.match(runner, /if \(SOURCE === PUBLIC_BUCKET \|\| SOURCE === PRIVATE_BUCKET\)/,
    'deleting from a bucket that is also a destination must be refused outright');

  // The delete names the LEGACY bucket explicitly. Deleting from row.destination
  // would remove the copy this whole workflow exists to create.
  assert.match(runner, /aws\(\['delete-object', '--bucket', SOURCE, '--key', row\.key\], false\)/);
  assert.ok(!runner.includes("'--bucket', row.destination, '--key'") ||
    !/delete-object[^;]*row\.destination/.test(runner), 'nothing may ever delete from a destination bucket');
});

test('the prune re-counts what survived instead of assuming it', () => {
  const runner = embeddedRunner();
  const deleteAt = runner.indexOf("'delete-object'");
  const recountAt = runner.indexOf('const stillInSource = listAll(SOURCE)');
  const destAt = runner.indexOf('PUBLIC DESTINATION OBJECTS MISSING');
  assert.ok(recountAt > deleteAt, 'the source must be re-listed AFTER the deletes, not before');
  assert.ok(destAt > deleteAt, 'the destinations must be re-checked after the deletes');
  assert.match(runner, /throw new Error\('a destination object is missing after the prune/,
    'losing a destination object must fail the run, not be reported as a number and ignored');
});

test('a prune that deleted things can never report that it deleted nothing', () => {
  const runner = embeddedRunner();
  const text = repoFile(WORKFLOW);

  // The count is taken from the rows, not asserted. `LEGACY DELETED: 0` was a
  // literal — true of every copy run and of no prune run, including the one
  // that deletes all eighteen exactly as intended.
  assert.match(runner, /const deleted = rows\.filter\(\(r\) => r\.outcome === 'SOURCE-DELETED'\)\.length;/);
  assert.match(runner, /console\.log\('LEGACY DELETED: ' \+ deleted\)/);
  assert.ok(!runner.includes("'LEGACY DELETED: 0'"), 'the deleted count must never be a literal');

  // "Deletion is refused" and "Nothing has been deleted" are true only in copy
  // mode. Printing either after a partial prune tells someone holding no other
  // copy that their originals are safe.
  for (const claim of ['Nothing has been deleted', 'Deletion is refused', 'Nothing was deleted by this job']) {
    const at = runner.indexOf(claim);
    if (at < 0) continue;
    const window = runner.slice(Math.max(0, at - 400), at);
    assert.match(window, /MODE === 'copy'/, `"${claim}" must be reachable only in copy mode`);
  }

  // The job that deletes is the job that must say how much it deleted.
  assert.match(text, /LEGACY SOURCE DELETED/, 'the prune job needs its own totals step');
  assert.match(text, /\n {6}- name: Print what was actually deleted, last\n {8}if: always\(\)\n/);
});

test('a throw mid-prune still writes the record of what was already deleted', () => {
  const runner = embeddedRunner();
  const tryAt = runner.indexOf('let fatal: string | null = null;');
  const catchAt = runner.indexOf('fatal = describeError(error);');
  const writeAt = runner.indexOf('writeFileSync(MANIFEST, JSON.stringify(');
  const deleteAt = runner.indexOf("'delete-object'");

  assert.ok(tryAt > 0 && tryAt < deleteAt, 'the work must be wrapped before anything is deleted');
  assert.ok(catchAt > deleteAt, 'the catch must cover the delete loop');
  assert.ok(writeAt > catchAt,
    'the manifest write must come AFTER the catch — otherwise an exception uploads job 1s copy manifest, which says nothing was deleted');
  assert.match(runner, /const verifiedAll = !fatal && failures === 0 && blocked\.length === 0;/,
    'a run that stopped early is not a clean run');
  assert.match(runner, /if \(fatal\) console\.error\('The run stopped early: ' \+ fatal\);/);
  assert.match(runner, /process\.exit\(1\)/, 'and it must still fail the job');
});

// ------------------------------------------- 8. the stray-private-logo workflow
//
// This one's risk is the mirror of workflow 39's. There the danger was deleting
// a folder's contents; here it is deleting the ONLY copy of the shop's logo
// because someone pointed the job at the wrong bucket. So the survivor has to be
// proven — from outside, over the internet — before the duplicate is touched.

const STRAY_WORKFLOW = '.github/workflows/media-stray-private-logo-remove.yml';

function strayRunner(): string {
  const text = repoFile(STRAY_WORKFLOW);
  const lines = text.split('\n').map((line) => line.replace(/^ {10}/, ''));
  const start = lines.findIndex((l) => l.startsWith("cat > ./scripts/media-stray-logo.gen.ts <<'TSEOF'"));
  const end = lines.findIndex((l, i) => i > start && l === 'TSEOF');
  assert.ok(start >= 0 && end > start, 'the stray workflow no longer embeds a runner the way this test reads it');
  return lines.slice(start + 1, end).join('\n');
}

test('the stray-logo workflow can delete exactly one key, and only from the private bucket', () => {
  const text = repoFile(STRAY_WORKFLOW);
  const runner = strayRunner();

  assert.match(text, /\[ "\$\{\{ inputs\.confirm \}\}" = "REMOVE-STRAY-PRIVATE-LOGO" \]/, 'it must be gated on its own typed phrase');
  assert.match(runner, /const KEY = 'UiUx\/Logo\/Logo\.webp';/, 'the key is a constant, not an input');
  assert.ok(!/inputs\.(key|keys|prefix)/.test(text), 'the key must never come from an input');

  for (const bulk of ['delete-objects', '--recursive', 's3 rm', 'delete-bucket', 'bucket delete']) {
    assert.ok(!text.includes(bulk), `the workflow must never use ${bulk}`);
  }
  assert.equal(runner.split("'delete-object'").length - 1, 1, 'exactly one delete in the whole runner');
  // The delete names the PRIVATE bucket. Naming the public one would destroy
  // the copy every check above exists to protect.
  assert.match(runner, /aws\(\['delete-object', '--bucket', PRIVATE_BUCKET, '--key', KEY\], false\)/);
  assert.ok(!/delete-object'[^;]*PUBLIC_BUCKET/.test(runner), 'nothing may delete from the public bucket');
});

test('the surviving public copy is proven three ways before the duplicate goes', () => {
  const text = repoFile(STRAY_WORKFLOW);
  const runner = strayRunner();
  const deleteAt = runner.indexOf("'delete-object'");

  // Existence and size, from R2.
  const existsAt = runner.indexOf("check('public copy exists'");
  const sizeAt = runner.indexOf('public copy size is exactly');
  assert.ok(existsAt > 0 && existsAt < deleteAt);
  assert.ok(sizeAt > 0 && sizeAt < deleteAt);
  assert.match(runner, /const EXPECTED_BYTES = 107218;/);

  // Byte-identity, because two different 107218-byte files would pass a size
  // check and only one of them is the duplicate.
  const shaAt = runner.indexOf('the private object is byte-identical to the public one');
  assert.ok(shaAt > 0 && shaAt < deleteAt, 'identity must be proven before the delete');
  assert.match(runner, /const privateDigest = sha256\(PRIVATE_BUCKET, 'private'\);/);

  // And from outside: a step that fails the job before the runner ever starts
  // if a stranger cannot fetch the logo right now.
  assert.match(text, /\n {6}- name: The live site must already serve the logo anonymously\n/);
  const liveAt = text.indexOf('The live site must already serve the logo anonymously');
  const runAt = text.indexOf('Prove the survivor, then remove the duplicate');
  assert.ok(liveAt > 0 && liveAt < runAt, 'the live check must come before the delete step');

  // Refusing is not optional: any failed check aborts before the delete.
  assert.match(runner, /if \(refusals\.length > 0\) \{[\s\S]{0,200}process\.exit\(1\);/);
});
