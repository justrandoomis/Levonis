/**
 * One icon per answer, so a tile is recognised before it is read. Lucide, the
 * app's one icon set; drawn at the same 20 px everywhere in the finder.
 */
import {
  Briefcase,
  Box,
  Cog,
  Gauge,
  HelpCircle,
  Home,
  Layers,
  Palette,
  PersonStanding,
  Sparkles,
  Tag,
  Target,
  Volume1,
  WandSparkles,
  Zap,
  Clock,
  Truck,
  Sprout,
  GraduationCap,
  Award,
  Flame,
  Droplet,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { FinderLevel, FinderPriority, FinderSale, FinderTech, FinderUse } from '../../../packages/catalog/src/discovery';

export const USE_ICON: Record<FinderUse, LucideIcon> = {
  hobby: Home,
  business: Briefcase,
  figures: PersonStanding,
  functional: Cog,
  sell: Tag,
  multicolor: Palette,
  unsure: HelpCircle,
};

export const TECH_ICON: Record<FinderTech, LucideIcon> = {
  any: HelpCircle,
  fdm: Layers,
  resin: Droplet,
  laser: Flame,
};

export const SALE_ICON: Record<FinderSale, LucideIcon> = {
  direct: Truck,
  any: Clock,
};

export const PRIORITY_ICON: Record<FinderPriority, LucideIcon> = {
  quality: Target,
  speed: Zap,
  quiet: Volume1,
  colors: Palette,
  ease: WandSparkles,
  size: Box,
};

export const LEVEL_ICON: Record<FinderLevel, LucideIcon> = {
  beginner: Sprout,
  intermediate: GraduationCap,
  pro: Award,
};

export const BUDGET_ICON: LucideIcon = Wallet;
export const ANY_ICON: LucideIcon = Sparkles;
export const GAUGE_ICON: LucideIcon = Gauge;
