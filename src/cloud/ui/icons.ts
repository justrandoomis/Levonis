/**
 * EVERY ICON PRINT CLOUD DRAWS, IMPORTED IN ONE PLACE.
 *
 * vite.config.ts moves a lucide icon into the shared `vendor-icons` chunk
 * when TWO lazy modules import it (and tests/motionLazy.test.ts caps that
 * chunk). Imported here once, an icon the rest of the shop already shares
 * costs nothing more, and one only Print Cloud uses stays in Print Cloud's
 * own chunk — however many cloud screens draw it. A cloud screen imports its
 * icons from this module, never from 'lucide-react'; a new icon is added here.
 */
import {
  ArrowLeft,
  ArrowRight,
  Box,
  CalendarClock,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Disc3,
  ExternalLink,
  Eye,
  History,
  Hourglass,
  House,
  Inbox,
  Info,
  Layers,
  Lock,
  LogIn,
  PackageSearch,
  Palette,
  Printer,
  RefreshCw,
  Ruler,
  ShoppingBag,
  Store,
  TriangleAlert,
  Truck,
  Upload,
  User,
  Wallet,
  WifiOff,
  X,
} from 'lucide-react';

export {
  ArrowLeft,
  ArrowRight,
  Box,
  CalendarClock,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Disc3,
  ExternalLink,
  Eye,
  History,
  Hourglass,
  House,
  Inbox,
  Info,
  Layers,
  Lock,
  LogIn,
  PackageSearch,
  Palette,
  Printer,
  RefreshCw,
  Ruler,
  ShoppingBag,
  Store,
  TriangleAlert,
  Truck,
  Upload,
  User,
  Wallet,
  WifiOff,
  X,
};

/** The chevron that points FORWARD in the reading direction (left in Arabic and Sorani). */
export const forwardChevron = (dir: 'rtl' | 'ltr') => (dir === 'rtl' ? ChevronLeft : ChevronRight);
/** The arrow that points BACK in the reading direction. */
export const backArrow = (dir: 'rtl' | 'ltr') => (dir === 'rtl' ? ArrowRight : ArrowLeft);
/** The arrow that points FORWARD in the reading direction. */
export const forwardArrow = (dir: 'rtl' | 'ltr') => (dir === 'rtl' ? ArrowLeft : ArrowRight);
