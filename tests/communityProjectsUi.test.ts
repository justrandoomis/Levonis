/**
 * THE PROJECTS LIST'S FILTER SHEET (community UI plan C2.1,
 * src/components/community/projects/FilterSheet.tsx): the choices are a
 * draft until «عرض النتائج». The page hands the sheet a new `value` object on
 * every render, so the draft starts from it when the sheet OPENS and only
 * then; following `value` undid the choices not yet applied whenever the page
 * re-rendered under the open sheet (review 2026-11-17).
 *
 * Run: node --import tsx --test tests/communityProjectsUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('the filter sheet resets its draft when it opens, not on every render of the page', () => {
  const sheet = code('src/components/community/projects/FilterSheet.tsx');
  const effect = /useEffect\(\(\) => \{\s*if \(open\) setDraft\(value\);\s*\}, \[([^\]]*)\]\);/.exec(sheet);
  assert.ok(effect, 'the draft is set from the address in one effect');
  assert.equal(effect[1].trim(), 'open', 'the effect follows the sheet opening only, never the new `value` object of each render');
  assert.match(sheet, /const \[draft, setDraft\] = useState\(value\);/);
  assert.match(sheet, /onApply\(draft\)/, '«عرض النتائج» applies the draft');
});

test('the feed card skeleton shares the community skeletons module: alone it was a chunk under 1 KB (tests/motionLazy.test.ts)', () => {
  assert.match(code('src/components/community/directory/Skeletons.tsx'), /export function FeedCardSkeleton\(/);
  assert.match(code('src/components/community/feed/FeedList.tsx'), /import \{ FeedCardSkeleton \} from '\.\.\/directory\/Skeletons';/);
  assert.match(code('src/pages/community/Following.tsx'), /import \{ FeedCardSkeleton \} from '\.\.\/\.\.\/components\/community\/directory\/Skeletons';/);
  assert.equal(existsSync(join(ROOT, 'src/components/community/feed/FeedCardSkeleton.tsx')), false);
});
