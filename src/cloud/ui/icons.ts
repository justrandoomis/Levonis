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
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Bell,
  Box,
  Boxes,
  CalendarClock,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock,
  Copy,
  Disc3,
  Download,
  ExternalLink,
  Eye,
  Folder,
  HandCoins,
  Headphones,
  History,
  Hourglass,
  House,
  Inbox,
  Info,
  Layers,
  Link2,
  Lock,
  LogIn,
  MapPin,
  MessageSquare,
  Package,
  PackageSearch,
  Palette,
  Pause,
  Pencil,
  Printer,
  RefreshCw,
  Ruler,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Trash2,
  TriangleAlert,
  Truck,
  Undo2,
  Upload,
  User,
  Wallet,
  WifiOff,
  X,
} from 'lucide-react';

export {
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Bell,
  Box,
  Boxes,
  CalendarClock,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleX,
  Clock,
  Copy,
  Disc3,
  Download,
  ExternalLink,
  Eye,
  Folder,
  HandCoins,
  Headphones,
  History,
  Hourglass,
  House,
  Inbox,
  Info,
  Layers,
  Link2,
  Lock,
  LogIn,
  MapPin,
  MessageSquare,
  Package,
  PackageSearch,
  Palette,
  Pause,
  Pencil,
  Printer,
  RefreshCw,
  Ruler,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Trash2,
  TriangleAlert,
  Truck,
  Undo2,
  Upload,
  User,
  Wallet,
  WifiOff,
  X,
};

// The store's own (src/cloud/pages/store): quantities, search, a chosen chip, orders.
// Each icon here is also an export of the shell chunk's module namespace (PrintCloudApp re-exports
// the ui barrel), so the store reuses the set above wherever one fits (Check is there already).
import { Minus, Plus, Receipt, Search } from 'lucide-react';

export { Minus, Plus, Receipt, Search };

/** The chevron that points FORWARD in the reading direction (left in Arabic and Sorani). */
export const forwardChevron = (dir: 'rtl' | 'ltr') => (dir === 'rtl' ? ChevronLeft : ChevronRight);
/** The arrow that points BACK in the reading direction. */
export const backArrow = (dir: 'rtl' | 'ltr') => (dir === 'rtl' ? ArrowRight : ArrowLeft);
/** The arrow that points FORWARD in the reading direction. */
export const forwardArrow = (dir: 'rtl' | 'ltr') => (dir === 'rtl' ? ArrowLeft : ArrowRight);
