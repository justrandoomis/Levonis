/**
 * THE WORKSPACE'S ONE NAVIGATION TABLE.
 *
 * Every way of getting somewhere in the merchant workspace reads THIS list:
 * the desktop sidebar (grouped, collapsible), the tablet icon rail, the phone
 * bottom tabs and their «More» sheet, and the command palette. A destination
 * added here appears in all five; one removed disappears from all five. There
 * is no second list to forget.
 *
 * Each entry is a workspace SECTION of the addresses contract
 * (packages/contracts/src/merchantRoutes.ts), so its path is never written by
 * hand here — `sectionPath` builds it from `SECTION_PATHS`, the same table the
 * Worker writes notification links with and the router parses.
 *
 * THE CAPABILITY THAT SHOWS AN ENTRY. Today every screen of the dashboard is
 * shown to every store owner — READING NEVER STOPS (MerchantDashboardPage's
 * guarantee): a lapsed or paused store keeps every screen, and it is the
 * CONTROLS inside that say why they are off. So every entry is `always`.
 * The one visibility rule that exists today — the request board is Levo
 * Community, hidden while the community is shut to this merchant — lives
 * where it always did (the link to the board inside the requests screen, and
 * the attention API leaving the matching count out). No new gating is
 * invented here (brief W3-A §2).
 *
 * BADGES are counts from GET /api/merchant/attention — real rows, never a
 * guess; an absent source is no badge, not a zero.
 */
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3, Bell, Calculator, ClipboardList, Wrench, Images, LayoutDashboard, LayoutGrid, MessageCircle, Package,
  Palette, Printer, Settings, ShoppingBag, Star, Tag, Truck, Users, Wallet, Inbox,
} from 'lucide-react';
import { MERCHANT_BASE, SECTION_PATHS, type MerchantSection } from '../../../lib/merchantRoutes';
import { W, type Words } from './strings';
import type { Attention } from './attention';

export type NavGroupId =
  | 'overview'
  | 'sales'
  | 'catalogue'
  | 'workshop'
  | 'store'
  | 'money'
  | 'analytics'
  | 'reviews'
  | 'inbox'
  | 'notifications';

/** Where an entry's badge count comes from (a field of the attention answer). */
export type BadgeSource =
  | 'orders'
  | 'custom_orders'
  | 'requests'
  | 'stock'
  | 'reviews'
  | 'inbox'
  | 'notifications'
  | 'coupons';

/** Who sees the entry. Only the rule that exists today — see the header. */
export type Capability = 'always';

/** The phone's bottom bar: four tabs, then «More». */
export type PhoneTab = 'home' | 'orders' | 'products' | 'store';

export interface NavEntry {
  id: MerchantSection;
  group: NavGroupId;
  label: Words;
  icon: LucideIcon;
  badge?: BadgeSource;
  capability: Capability;
  /** Which phone tab lights up while this section is open («More» when absent). */
  phoneTab?: PhoneTab;
  /** More words the palette should find it by. */
  keywords?: readonly string[];
  /** The screen opens with its own visible heading; the frame's title is then for screen readers only. */
  ownHeading?: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  /** Absent for a group of one: its entry is its own heading. */
  label?: Words;
  entries: NavEntry[];
}

/** The groups, in sidebar order (brief W3-A §2). */
export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; label?: Words }> = [
  { id: 'overview' },
  { id: 'sales', label: W.sales },
  { id: 'catalogue', label: W.catalogue },
  { id: 'workshop', label: W.workshop },
  { id: 'store', label: W.store },
  { id: 'money' },
  { id: 'analytics' },
  { id: 'reviews' },
  { id: 'inbox' },
  { id: 'notifications' },
];

export const NAV: readonly NavEntry[] = [
  { id: 'home', group: 'overview', label: W.overview, icon: LayoutDashboard, capability: 'always', phoneTab: 'home', keywords: ['home', 'dashboard', 'الرئيسية'] },

  { id: 'orders', group: 'sales', label: W.orders, icon: ShoppingBag, badge: 'orders', capability: 'always', phoneTab: 'orders' },
  { id: 'custom_orders', group: 'sales', label: W.customOrders, icon: ClipboardList, badge: 'custom_orders', capability: 'always', phoneTab: 'orders' },
  { id: 'customers', group: 'sales', label: W.customers, icon: Users, capability: 'always' },
  { id: 'coupons', group: 'sales', label: W.coupons, icon: Tag, badge: 'coupons', capability: 'always', keywords: ['discount', 'خصم'] },

  { id: 'products', group: 'catalogue', label: W.products, icon: Package, badge: 'stock', capability: 'always', phoneTab: 'products', keywords: ['stock', 'مخزون', 'sku'], ownHeading: true },
  { id: 'collections', group: 'catalogue', label: W.collections, icon: LayoutGrid, capability: 'always', phoneTab: 'products', keywords: ['collections', 'مجموعات'], ownHeading: true },
  { id: 'services', group: 'catalogue', label: W.services, icon: Wrench, capability: 'always', phoneTab: 'products' },
  { id: 'showcase', group: 'catalogue', label: W.showcase, icon: Images, capability: 'always', phoneTab: 'products' },

  { id: 'printers', group: 'workshop', label: W.printers, icon: Printer, capability: 'always' },
  { id: 'costing', group: 'workshop', label: W.costing, icon: Calculator, capability: 'always' },
  { id: 'requests', group: 'workshop', label: W.requests, icon: Inbox, badge: 'requests', capability: 'always' },

  { id: 'store_design', group: 'store', label: W.storeDesign, icon: Palette, capability: 'always', phoneTab: 'store', keywords: ['theme', 'ثيم', 'layout'] },
  { id: 'store_settings', group: 'store', label: W.storeSettings, icon: Settings, capability: 'always', phoneTab: 'store', keywords: ['settings', 'إعدادات', 'logo', 'شعار'] },
  { id: 'store_delivery', group: 'store', label: W.delivery, icon: Truck, capability: 'always', phoneTab: 'store', keywords: ['shipping', 'شحن', 'governorate', 'محافظة'] },

  { id: 'money', group: 'money', label: W.money, icon: Wallet, capability: 'always', keywords: ['payout', 'سحب', 'ledger', 'finance'] },
  { id: 'analytics', group: 'analytics', label: W.analytics, icon: BarChart3, capability: 'always', keywords: ['stats', 'إحصائيات', 'visitors', 'زوار'] },
  { id: 'reviews', group: 'reviews', label: W.reviews, icon: Star, badge: 'reviews', capability: 'always' },
  { id: 'inbox', group: 'inbox', label: W.inbox, icon: MessageCircle, badge: 'inbox', capability: 'always', keywords: ['chat', 'محادثة', 'inbox'] },
  { id: 'notifications', group: 'notifications', label: W.notifications, icon: Bell, badge: 'notifications', capability: 'always' },
];

/** The four phone tabs and the section each opens. */
export const PHONE_TABS: ReadonlyArray<{ tab: PhoneTab; section: MerchantSection; label: Words }> = [
  { tab: 'home', section: 'home', label: W.overview },
  { tab: 'orders', section: 'orders', label: W.orders },
  { tab: 'products', section: 'products', label: W.products },
  { tab: 'store', section: 'store_design', label: W.store },
];

/** A section's path on this host's base (`/merchant` or `/admin`). */
export function sectionPath(section: MerchantSection, base: string = MERCHANT_BASE): string {
  const path = SECTION_PATHS[section];
  return path ? `${base}/${path}` : base;
}

/** The entries a merchant with these capabilities sees (today: all of them). */
export function visibleNav(_granted: ReadonlySet<Capability> = new Set<Capability>(['always'])): NavEntry[] {
  return NAV.filter((e) => _granted.has(e.capability));
}

/** The sidebar: groups in order, each with its visible entries. */
export function navGroups(entries: readonly NavEntry[] = NAV): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => e.group === g.id) })).filter((g) => g.entries.length > 0);
}

/** Everything the phone's four tabs do not open directly — the «More» sheet. */
export function moreEntries(entries: readonly NavEntry[] = NAV): NavEntry[] {
  const direct = new Set(PHONE_TABS.map((t) => t.section));
  return entries.filter((e) => !direct.has(e.id));
}

/** Which phone tab is lit for a section («more» for the rest). */
export function phoneTabFor(section: MerchantSection): PhoneTab | 'more' {
  return NAV.find((e) => e.id === section)?.phoneTab ?? 'more';
}

export function navEntry(section: MerchantSection): NavEntry | undefined {
  return NAV.find((e) => e.id === section);
}

/**
 * The count on an entry, from the attention answer — or null: no badge.
 * Null, not 0, when the source is absent: a missing count draws nothing.
 */
export function badgeCount(source: BadgeSource | undefined, a: Attention | null | undefined): number | null {
  if (!source || !a) return null;
  switch (source) {
    case 'orders':
      return a.orders ? a.orders.total : null;
    case 'custom_orders':
      return a.custom_orders ? a.custom_orders.total : null;
    case 'requests':
      return a.requests ? a.requests.matching : null;
    case 'stock':
      return a.stock ? a.stock.low + a.stock.out : null;
    case 'reviews':
      return a.reviews && typeof a.reviews.unanswered === 'number' ? a.reviews.unanswered : null;
    case 'inbox':
      return a.inbox ? a.inbox.threads : null;
    case 'notifications':
      return a.notifications ? a.notifications.unread : null;
    case 'coupons':
      return a.coupons ? a.coupons.ending_soon : null;
    default:
      return null;
  }
}
