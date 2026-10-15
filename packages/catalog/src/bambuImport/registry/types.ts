/**
 * The product type of a source product, from its backend category route
 * `P.currentAllIdRoute` (source-analysis §8): level 1 names the type, level 2
 * the sub-type. Category NAMES are not on the page; the reviewed taxonomy map
 * (§D) places a product. This type only decides which spec keys are EXPECTED
 * (§C.6) and which parsing rules apply.
 */
export type ProductType = 'printer' | 'laser_machine' | 'ams' | 'filament' | 'plate' | 'hotend' | 'tool' | 'accessory' | 'part' | 'makers_supply' | 'laser_material' | 'other';

const L1_MACHINES = '552709755391528960';
const L2_AMS = '552709755685130240';
const L1_FILAMENT = '552709755819347968';
const L1_ACCESSORIES = '552709757765505024';
const L2_PLATES = '552709757794865152';
const L2_HOTENDS = '552709757979414528';
const L2_TOOLS = '750510267545833472';
const L1_SPARE_PARTS = '552709758222684160';
const L1_MAKERS_SUPPLY = '552709760852512768';
const L1_LASER_MATERIAL = '578424673239986176';
const L1_LASER_MACHINE = '777329586458394624';

export function productTypeOf(route: string): ProductType {
  const [l1 = '', l2 = ''] = route.split('>').map((s) => s.trim());
  if (l1 === L1_MACHINES) return l2 === L2_AMS ? 'ams' : 'printer';
  if (l1 === L1_FILAMENT) return 'filament';
  if (l1 === L1_ACCESSORIES) {
    if (l2 === L2_PLATES) return 'plate';
    if (l2 === L2_HOTENDS) return 'hotend';
    if (l2 === L2_TOOLS) return 'tool';
    return 'accessory';
  }
  if (l1 === L1_SPARE_PARTS) return 'part';
  if (l1 === L1_MAKERS_SUPPLY) return 'makers_supply';
  if (l1 === L1_LASER_MATERIAL) return 'laser_material';
  if (l1 === L1_LASER_MACHINE) return 'laser_machine';
  return 'other';
}

/** A machine whose box ships by region (the §C.6 region rule and the §B.7 US-only CBM rule apply). */
export const isMachine = (t: ProductType) => t === 'printer' || t === 'laser_machine';

/** The route ids this file names (the P0 report lists every route id it does not). */
export const KNOWN_ROUTE_L1: ReadonlySet<string> = new Set([L1_MACHINES, L1_FILAMENT, L1_ACCESSORIES, L1_SPARE_PARTS, L1_MAKERS_SUPPLY, L1_LASER_MATERIAL, L1_LASER_MACHINE]);
