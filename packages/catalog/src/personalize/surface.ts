/**
 * THE SURFACE COMPILER (docs/LEVO_PROJECT_PROGRAMME.md §B.1 «The surface
 * compiler», §A C1.46 and C2.8, §F F9): any blueprint → at most 4 tiles + 1
 * door. The studio renders exactly what this declares — never a control of
 * its own — and the count Playwright asserts is tiles + door (≤ 5; exactly 5
 * for the name stand).
 *
 *   slot 1  the main content: the first name > photo > logo > text > qr area
 *   slot 2  Look (colours and themes): a colour target — a region, or a text's
 *           own colour — offers two or more colours, or a piece is optional
 *           (its switch lives in Look's parts rows); themes act only through
 *           such choices, so they add no tile of their own
 *   slot 3  Size: two or more size values the printer can make
 *   an empty slot among the first three is promoted from QR › add-ons
 *   the rest are tiles when they all fit (4 at most) and none is More-only,
 *   else ONE More tile lists them all. More-only: the finish ('look' = the
 *   look axis) and the tier with two or more values, NFC, and an icon area
 *   when there is no name area — an icon rides the Name tile when there is
 *   one (`name_icons`). 'notes', then 'ask' (the community open and the store
 *   taking requests), close an existing More and never open one.
 *
 * `more` lists More's pages in the MorePage order (look tier text photo logo
 * qr icon nfc addons notes ask), areas in spec order, each with `ref`.
 *
 * The door: blocked → disabled, carrying the blocking check code (`fix`, from
 * check.ts `blockingCode`); review → request when the community is open and
 * the store takes requests, else ask; ready and adjusted → add_to_cart when
 * the blueprint sells by cart, else request (ask when requests are closed).
 * Save, share and start over are never in the row (the top bar's ⋯).
 *
 * Pure and config-free: a blueprint compiles to the same surface every time.
 */
import type { Area, Door, MorePage, Paint, Surface, SurfaceItem, TileId, Verdict } from './types';
import type { SpecLike } from './canonical';
import { sizeValuesInBuild } from './rules';

export interface SurfaceState {
  verdict: Verdict;
  /** The blocking check code the disabled door names. */
  fix?: string;
  community_open?: boolean;
  takes_requests?: boolean;
}
export interface SurfacePlan extends Surface {
  /** Icon areas edited inside the Name tile. */
  name_icons: string[];
}

const PAGES: readonly MorePage[] = ['look', 'tier', 'text', 'photo', 'logo', 'qr', 'icon', 'nfc', 'addons', 'notes', 'ask'];
const MAIN = ['name', 'photo', 'logo', 'text', 'qr'];

export function compileSurface(spec: SpecLike, state: SurfaceState): SurfacePlan {
  const areas = spec.areas;
  const choice = (p: Paint): boolean => !Array.isArray(p.allowed) || p.allowed.length > 1;
  const named = areas.some((a) => a.role === 'name');
  const main = MAIN.map((r) => areas.find((a) => a.role === r)).find((a) => a !== undefined);
  const tile = (a: Area): SurfaceItem<TileId> => ({ id: a.role as TileId, ref: a.id });
  const many = (axis?: { values: object }): boolean => !!axis && Object.keys(axis.values).length > 1;

  const tiles: SurfaceItem<TileId>[] = main ? [tile(main)] : [];
  if (spec.regions.some((r) => choice(r.paint) || r.optional) || areas.some((a) => a.text && choice(a.text.paint))) tiles.push({ id: 'look' });
  if (sizeValuesInBuild(spec, 'printer' in spec ? spec.printer : null).length > 1) tiles.push({ id: 'size' });

  const others = areas.filter((a) => a !== main && a.kind !== 'icon');
  const rest: SurfaceItem<TileId>[] = [
    ...others.filter((a) => a.kind === 'qr').map(tile),
    ...(spec.slots.some((s) => s.choice === 'customer') ? [{ id: 'addons' as const }] : []),
    ...others.filter((a) => a.kind !== 'qr').map(tile),
  ];
  while (tiles.length < 3 && (rest[0]?.id === 'qr' || rest[0]?.id === 'addons')) tiles.push(rest.shift()!);

  const only: SurfaceItem<MorePage>[] = [
    ...(many(spec.axes.look) ? [{ id: 'look' as const }] : []),
    ...(many(spec.axes.tier) ? [{ id: 'tier' as const }] : []),
    ...(named ? [] : areas.filter((a) => a.kind === 'icon').map((a) => ({ id: 'icon' as const, ref: a.id }))),
    ...(spec.extras.nfc ? [{ id: 'nfc' as const }] : []),
  ];
  let more: SurfaceItem<MorePage>[] = [];
  if (!only.length && tiles.length + rest.length <= 4) tiles.push(...rest);
  else {
    const items = [...rest.map((t) => ({ id: (t.id === 'name' ? 'text' : t.id) as MorePage, ...(t.ref ? { ref: t.ref } : {}) })), ...only];
    more = PAGES.flatMap((p) => items.filter((i) => i.id === p));
    more.push({ id: 'notes' });
    if (state.community_open && state.takes_requests) more.push({ id: 'ask' });
    tiles.push({ id: 'more' });
  }

  const requestable = !!(state.community_open && state.takes_requests);
  const door: Door =
    state.verdict === 'blocked' ? (state.fix ? { kind: 'disabled', fix: state.fix } : { kind: 'disabled' })
    : state.verdict === 'review' || !spec.sell.cart ? { kind: requestable ? 'request' : 'ask' }
    : { kind: 'add_to_cart' };
  return { tiles, door, more, name_icons: named ? areas.filter((a) => a.kind === 'icon').map((a) => a.id) : [] };
}
