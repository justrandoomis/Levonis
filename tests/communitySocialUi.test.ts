/**
 * THE SOCIAL ROW (src/components/community/social/**) — what must not quietly
 * come back, in the style of tests/communityHubUi.test.ts.
 *
 *   * No <button> inside a link. A card is one stretched link and its like,
 *     save, follow and «⋯» are siblings above it (`relative z-10`); a button
 *     nested in an anchor is invalid HTML a screen reader reads as nonsense.
 *   * Every toggle says its state: like, save and follow carry `aria-pressed`;
 *     the report sheet's reasons are ONE choice, so they are radios
 *     (`role="radio"`, `aria-checked`) in a labelled radiogroup.
 *   * Every word exists in Arabic, English AND real Sorani (D6): the three
 *     tables have the same keys, and the Sorani is not the Arabic pasted
 *     across for at least nine keys in ten.
 *   * The theme is tokens, never hex, never `dark:`, never a physical
 *     left/right utility.
 *   * The comments sheet is a lazy chunk of the row, so a scrolled feed never
 *     downloads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { SOCIAL_STRINGS, commentsLabel, followersLabel, likesLabel, replyToLabel } from '../src/components/community/social/strings';

const DIR = 'src/components/community/social';
const files = readdirSync(join(ROOT, DIR)).filter((f) => /\.tsx?$/.test(f));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments, so a sentence ABOUT a pattern cannot satisfy or trip a check. */
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('the social folder has every component the contract names', () => {
  for (const f of ['api.ts', 'strings.ts', 'LikeButton.tsx', 'SaveButton.tsx', 'FollowUserButton.tsx', 'PostMenu.tsx', 'ReportSheet.tsx', 'CommentsSheet.tsx', 'ActionRow.tsx', 'SocialContext.tsx']) {
    assert.ok(files.includes(f), `${DIR}/${f} is missing`);
  }
});

test('no <button> inside a link, anywhere in the social components', () => {
  for (const f of files.filter((x) => x.endsWith('.tsx'))) {
    const src = code(`${DIR}/${f}`);
    // Each anchor's extent, from its opening tag to its own closing tag.
    for (const tag of ['a', 'Link']) {
      const open = new RegExp(`<${tag}(?=[\\s>])`, 'g');
      let m: RegExpExecArray | null;
      while ((m = open.exec(src))) {
        const close = src.indexOf(`</${tag}>`, m.index);
        const selfClosed = /^<[^>]*\/>/.test(src.slice(m.index));
        if (selfClosed) continue;
        const inner = src.slice(m.index, close < 0 ? undefined : close);
        assert.doesNotMatch(inner, /<button\b/, `${f}: a <button> inside <${tag}>:\n${inner.slice(0, 160)}`);
      }
    }
  }
});

test('every toggle says its state with aria-pressed, and sits above a card link', () => {
  for (const f of ['CountToggle.tsx', 'FollowUserButton.tsx']) {
    const src = code(`${DIR}/${f}`);
    assert.match(src, /aria-pressed=\{/, `${f}: no aria-pressed`);
    assert.match(src, /relative z-10/, `${f}: not lifted above the stretched link`);
    assert.match(src, /min-h-11/, `${f}: under the 44 px target`);
  }
  const report = code(`${DIR}/ReportSheet.tsx`);
  assert.match(report, /role="radiogroup"/, 'the reasons are one choice');
  assert.match(report, /role="radio"/, 'each reason is a radio');
  assert.match(report, /aria-checked=\{reason === r\}/, 'the reason chips say which is chosen');
  assert.doesNotMatch(report, /aria-pressed/, 'a radio is not a toggle button');
  assert.match(code(`${DIR}/ActionRow.tsx`), /aria-expanded=\{commentsOpen\}/, 'the comments button says whether its sheet is open');
});

test('all three languages carry every key, and the Sorani is not the Arabic', () => {
  const flat = (o: Record<string, unknown>, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') Object.assign(out, flat(v as Record<string, unknown>, `${prefix}${k}.`));
      else out[`${prefix}${k}`] = String(v);
    }
    return out;
  };
  const ar = flat(SOCIAL_STRINGS.ar);
  const en = flat(SOCIAL_STRINGS.en);
  const ckb = flat(SOCIAL_STRINGS.ckb);
  const keys = Object.keys(ar);
  assert.ok(keys.length >= 60, `only ${keys.length} keys`);
  assert.deepEqual(Object.keys(en).sort(), keys.slice().sort(), 'en keys differ from ar');
  assert.deepEqual(Object.keys(ckb).sort(), keys.slice().sort(), 'ckb keys differ from ar');
  let same = 0;
  let kurdish = 0;
  for (const k of keys) {
    for (const [lang, table] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) {
      assert.ok(table[k].trim().length > 0, `${lang}.${k} is empty`);
    }
    if (ckb[k] === ar[k]) same += 1;
    assert.notEqual(ckb[k], en[k], `ckb.${k} is the English`);
    // Sorani is written in the Arabic script's Kurdish letters (ە ۆ ێ ڕ ڵ ڤ گ
    // چ پ ژ, the Kurdish yeh U+06CC and kaf U+06A9). A short word such as
    // «ناردن» can be spelt from shared letters alone, so this is a ratio.
    if (/[ەۆێڕڵڤگچپژیک]/.test(ckb[k])) kurdish += 1;
  }
  assert.ok(same / keys.length <= 0.1, `${same} of ${keys.length} Sorani strings are the Arabic`);
  assert.ok(kurdish / keys.length >= 0.9, `only ${kurdish} of ${keys.length} Sorani strings use a Kurdish letter`);
});

test('counted nouns agree with their number in Arabic and read naturally elsewhere', () => {
  assert.equal(likesLabel(1, 'ar'), 'إعجاب واحد');
  assert.equal(likesLabel(2, 'ar'), 'إعجابان');
  assert.equal(likesLabel(5, 'ar'), '5 إعجابات');
  assert.equal(likesLabel(12, 'ar'), '12 إعجابًا');
  assert.equal(likesLabel(100, 'ar'), '100 إعجاب');
  assert.equal(likesLabel(1, 'en'), '1 like');
  assert.equal(likesLabel(3, 'en'), '3 likes');
  assert.equal(likesLabel(3, 'ckb'), '3 لایک');
  assert.equal(commentsLabel(2, 'ar'), 'تعليقان');
  assert.equal(commentsLabel(11, 'ar'), '11 تعليقًا');
  assert.equal(followersLabel(7, 'ar'), '7 متابعين');
  assert.equal(followersLabel(1, 'en'), '1 follower');
  assert.equal(replyToLabel(SOCIAL_STRINGS.en, 'Sara'), 'Reply to Sara');
});

test('tokens only: no hex, no dark: variant, no physical left/right utility, no native dialog', () => {
  const physical = /(?:^|[\s"'`{])(?:[a-z-]+:)*(?:pl|pr|ml|mr|left|right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)-[\w[\]/.-]+/;
  for (const f of files) {
    const src = code(`${DIR}/${f}`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} hard-codes a hex colour`);
    assert.doesNotMatch(src, /(?:^|[\s"'`{])(?:[a-z-]+:)*dark:[a-z-]/, `${f} uses the dark: variant`);
    assert.doesNotMatch(src, physical, `${f} uses a physical left/right utility`);
    assert.doesNotMatch(src, /window\.(confirm|alert|prompt)\(/, `${f} uses a native dialog`);
    assert.doesNotMatch(src, /\bwindow\.open\(/, `${f} opens a window by script`);
  }
});

test('springs come from useMotion, the comments sheet is a lazy chunk, and the writes are idempotent verbs', () => {
  for (const f of ['CountToggle.tsx', 'FollowUserButton.tsx']) {
    const src = code(`${DIR}/${f}`);
    assert.match(src, /useMotion\(\)/, `${f} does not use the motion kit`);
    assert.doesNotMatch(src, /transition=\{\{\s*duration/, `${f} invents a duration`);
  }
  const row = code(`${DIR}/ActionRow.tsx`);
  assert.match(row, /React\.lazy\(loadComments\)/, 'the comments sheet is not lazy');
  assert.doesNotMatch(row, /^import .*CommentsSheet/m, 'the comments sheet is statically imported');
  const api = code(`${DIR}/api.ts`);
  assert.match(api, /api\.put<[^>]*>\(`\/api\/community\/posts\/\$\{enc\(postId\)\}\/like`\)/, 'a like is a PUT');
  assert.match(api, /api\.delete<[^>]*>\(`\/api\/community\/posts\/\$\{enc\(postId\)\}\/like`\)/, 'an unlike is a DELETE');
  assert.match(api, /api\.put<[^>]*>\(`\/api\/community\/users\/\$\{enc\(userId\)\}\/follow`\)/, 'a follow is a PUT');
  assert.match(api, /client_id/, 'a comment carries its client id');
  assert.doesNotMatch(api, /user_id|reporter_id|author_id/, 'the client never names a user id in a body');
});

test('the pages mount the row where the contract says', () => {
  const project = code('src/pages/community/Project.tsx');
  assert.match(project, /<ActionRow\b/, 'the project page has no action row');
  assert.match(project, /<FollowUserButton\b/, 'the project byline has no follow');
  for (const mark of ['data-project-author', 'data-project-print', 'data-project-consent', 'data-project-publish', 'data-project-action-bar']) {
    assert.match(project, new RegExp(mark), `the project page lost its ${mark} marker`);
  }
  const creator = code('src/pages/community/Creator.tsx');
  assert.match(creator, /<FollowUserButton\b/, 'the creator header has no follow');
  assert.match(creator, /data-creator-followers/, 'the creator header has no follower count');
  assert.match(creator, /\{ id: 'posts', label: ss\.posts \}/, 'the creator page has no posts tab');
  assert.match(creator, /<ReportSheet\b/, 'a creator cannot be reported');
  const app = code('src/App.tsx');
  assert.match(app, /<Route path="\/community\/saved" element=\{<ProtectedRoute><CommunityGate><CommunitySaved \/><\/CommunityGate><\/ProtectedRoute>\} \/>/);
  assert.match(app, /<SocialProvider>/, 'the customer shell does not mount SocialProvider');
  const bell = code('src/components/notifications/NotificationBell.tsx');
  for (const kind of ['post_liked', 'post_commented', 'comment_replied', 'new_follower', 'portfolio_consent']) {
    assert.match(bell, new RegExp(`case '${kind}':`), `the bell has no icon for ${kind}`);
  }
});
