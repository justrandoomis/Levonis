/**
 * THE SPEC KEY REGISTRY (spec §C.6). One entry per canonical key: its group,
 * data type and stored unit, its three-language label (authored, §C.8), the
 * source labels that mean it (synonyms unify meaning; `original_label` keeps
 * the words), the product types it applies to, its template-field mirror, and
 * the flags the storefront reads (facet, compare, expected, card key) and the
 * region rule reads (regionDependent).
 */
import { labelKey } from '../normalize';
import { tri, type Tri } from './labels';
import { isMachine, type ProductType } from './types';

export type SpecDataType = 'string' | 'number' | 'boolean' | 'enum' | 'range' | 'list' | 'date' | 'object';

export interface SpecKey {
  key: string;
  group: string;
  type: SpecDataType;
  /** The stored unit ('' for none). Lengths are mm, masses g. */
  unit: string;
  labels: Tri;
  synonyms: readonly string[];
  /** Types the key belongs to; empty = any. A synonym shared by two keys resolves by type. */
  appliesTo: readonly ProductType[];
  templateField?: string;
  facet?: boolean;
  compare?: boolean;
  /** Types for which an absent value is written as `not_found` (§C.6). */
  expectedFor?: readonly ProductType[];
  cardKeyFor?: readonly ProductType[];
  /** 'always' (electrical.*) or 'printer' (package and shipment measures of a printer): the §C.6 region rule. */
  regionDependent?: 'always' | 'printer';
  /** Visible to the owner only (manufacturer warranty notes L-19, CBM L-4). */
  ownerOnly?: boolean;
}

type Opts = Omit<SpecKey, 'key' | 'group' | 'type' | 'unit' | 'labels' | 'synonyms' | 'appliesTo'> & { appliesTo?: readonly ProductType[] };
const k = (key: string, type: SpecDataType, unit: string, labels: Tri, synonyms: string[], opts: Opts = {}): SpecKey => ({
  key,
  group: key.split('.')[0] === 'product' || key.split('.')[0] === 'package' || key.split('.')[0] === 'shipment' || key.split('.')[0] === 'carton'
    ? 'logistics'
    : key.split('.')[0],
  type,
  unit,
  labels,
  synonyms,
  appliesTo: opts.appliesTo ?? [],
  ...opts,
});

const PRINTER: ProductType[] = ['printer'];
const FILAMENT: ProductType[] = ['filament'];
/** Every type but the machines and filament: generic part labels ("Shape", "Type", "Max Temperature") never touch a printer table. */
const PARTS: ProductType[] = ['part', 'accessory', 'tool', 'makers_supply', 'plate', 'hotend', 'laser_material', 'other'];

export const SPEC_KEYS: readonly SpecKey[] = [
  // ---- printing ---------------------------------------------------------
  k('printing.technology', 'string', '', tri('تقنية الطباعة', 'Printing technology', 'تەکنەلۆژیای چاپ'), ['Printing Technology', 'Technology', 'Print Technology'], { templateField: 'technology' }),
  k('printing.build_volume', 'object', 'mm', tri('حجم الطباعة', 'Build volume', 'قەبارەی چاپ'),
    ['Build Volume', 'Print Volume', 'Printing volume', 'Build volume (W×D×H)', 'Build Volume (W*D*H)', 'Build Volume(W*D*H)', 'Printing Volume', 'Print Size', 'Build Size'],
    { templateField: 'build_volume', facet: true, compare: true, expectedFor: PRINTER, cardKeyFor: PRINTER }),
  k('printing.layer_height', 'range', 'mm', tri('ارتفاع الطبقة', 'Layer height', 'بەرزیی چین'), ['Layer Height', 'Layer Thickness', 'Layer Height Range'], { templateField: 'layer_height_range' }),
  k('printing.build_plate', 'list', '', tri('صفيحة الطباعة', 'Build plate', 'پلێتی چاپ'),
    ['Build Plate', 'Build Plate Type', 'Supported Build Plate', 'Supported Build Plate Type', 'Build Plate Surface Compatibility'], { templateField: 'build_plate' }),
  k('printing.supported_filament', 'list', '', tri('الخيوط المدعومة', 'Supported filament', 'فیلامێنتە پشتگیریکراوەکان'),
    ['Supported Filament', 'Supported Filament Type', 'Supported Filament Types', 'Filament Supported', 'Compatible Filament', 'Supported Materials', 'Filament Compatibility', 'Supported Filaments'], { templateField: 'supported_filaments' }),
  k('printing.unsupported_filament', 'list', '', tri('خيوط غير مدعومة', 'Filament not supported', 'فیلامێنتە پشتگیرینەکراوەکان'), ['Filament Not Supported', 'Unsupported Filament', 'Unsupported Filaments']),
  k('printing.camera', 'string', '', tri('كاميرا المراقبة', 'Monitoring camera', 'کامێرای چاودێری'),
    ['Chamber Monitoring Camera', 'Camera', 'Live View Camera'], { templateField: 'camera' }),
  // One key per camera: a table listing three cameras is three facts, not one key and two leftovers.
  k('printing.camera_toolhead', 'string', '', tri('كاميرا رأس الطباعة', 'Toolhead camera', 'کامێرای سەری چاپ'), ['Toolhead Camera'], { appliesTo: PRINTER }),
  k('printing.camera_nozzle', 'string', '', tri('كاميرا النوزل', 'Nozzle camera', 'کامێرای نۆزڵ'), ['Nozzle Camera'], { appliesTo: PRINTER }),
  k('printing.camera_birdseye', 'string', '', tri('كاميرا BirdsEye', 'BirdsEye camera', 'کامێرای BirdsEye'), ['BirdsEye Camera'], { appliesTo: PRINTER }),
  k('printing.filament_runout_sensor', 'boolean', '', tri('حساس نفاد الخيط', 'Filament run-out sensor', 'هەستەوەری تەواوبوونی فیلامێنت'),
    ['Filament Run Out Sensor', 'Filament Runout Sensor', 'Filament Run-Out Sensor', 'Filament Run-out Detection'], { templateField: 'filament_sensor' }),
  k('printing.filament_odometry', 'boolean', '', tri('قياس طول الخيط', 'Filament odometry', 'پێوانی درێژیی فیلامێنت'), ['Filament Odometry']),
  k('printing.power_loss_recovery', 'boolean', '', tri('الاستئناف بعد انقطاع الكهرباء', 'Power loss recovery', 'بەردەوامبوونەوە دوای بڕانی کارەبا'),
    ['Power Loss Recover', 'Power Loss Recovery'], { templateField: 'power_loss_recovery' }),
  k('printing.filament_tangle_sensor', 'boolean', '', tri('حساس تشابك الخيط', 'Filament tangle sensor', 'هەستەوەری ئاڵۆزبوونی فیلامێنت'), ['Filament Tangle Sensor', 'Filament Tangle Detection']),
  k('printing.auto_leveling', 'string', '', tri('التسوية التلقائية', 'Automatic bed levelling', 'ڕێکخستنی خۆکاری پلێت'),
    ['Auto Bed Leveling', 'Bed Leveling', 'Auto-leveling', 'Auto Leveling', 'Automatic Bed Leveling'], { templateField: 'auto_leveling' }),
  k('printing.multi_color', 'string', '', tri('الطباعة متعددة الألوان', 'Multi-colour printing', 'چاپی فرەڕەنگ'),
    ['Multi-color Printing', 'Multi-Color Printing', 'Multicolor Printing', 'Multi-colour Printing'], { templateField: 'multi_color' }),
  // ---- motion -----------------------------------------------------------
  k('motion.max_speed', 'number', 'mm/s', tri('أقصى سرعة لرأس الطباعة', 'Max toolhead speed', 'زۆرترین خێرایی سەری چاپ'),
    ['Max Speed of Tool Head', 'Max Speed of Toolhead', 'Max Print Speed', 'Maximum Speed', 'Max Speed', 'Toolhead Max Speed', 'Max Toolhead Speed'],
    { templateField: 'max_print_speed', compare: true, expectedFor: PRINTER }),
  k('motion.max_acceleration', 'number', 'mm/s²', tri('أقصى تسارع لرأس الطباعة', 'Max toolhead acceleration', 'زۆرترین خێرابوونی سەری چاپ'),
    ['Max Acceleration of Tool Head', 'Max Acceleration of Toolhead', 'Max Acceleration', 'Acceleration', 'Max Toolhead Acceleration'], { templateField: 'max_acceleration', compare: true }),
  k('motion.max_flow', 'number', 'mm³/s', tri('أقصى معدل تدفق', 'Max volumetric flow', 'زۆرترین ڕێژەی ڕۆیشتن'),
    ['Max Hot End Flow', 'Maximum Volumetric Speed', 'Max Flow Rate', 'Max Flow', 'Max Volumetric Flow', 'Max Flow for Hotend', 'Max Flow for Hotend (Standard Flow Hotend)'],
    { templateField: 'max_flow_rate' }),
  k('motion.max_flow_high_flow', 'number', 'mm³/s', tri('أقصى معدل تدفق مع رأس صهر عالي التدفق', 'Max volumetric flow (high-flow hotend)', 'زۆرترین ڕێژەی ڕۆیشتن بە سەری تواندنەوەی ڕۆیشتنی بەرز'),
    ['Max Flow for Hotend (Optional High Flow Hotend)'], { appliesTo: PRINTER }),
  // ---- extrusion --------------------------------------------------------
  k('extrusion.hotend', 'string', '', tri('رأس الصهر (Hotend)', 'Hotend', 'سەری تواندنەوە (Hotend)'), ['Hot End', 'Hotend'], { appliesTo: PRINTER, templateField: 'hotend_type' }),
  k('extrusion.extruder_gear', 'string', '', tri('ترس الدافع', 'Extruder gear', 'چەرخی پاڵنەر'), ['Extruder Gear']),
  k('extrusion.nozzle_material', 'string', '', tri('مادة النوزل', 'Nozzle material', 'کەرەستەی نۆزڵ'), ['Nozzle', 'Nozzle Material'], { appliesTo: PRINTER, templateField: 'nozzle_material' }),
  k('extrusion.nozzle_diameter', 'number', 'mm', tri('قطر النوزل المرفق', 'Included nozzle diameter', 'تیرەی نۆزڵی لەگەڵدا'),
    ['Nozzle Diameter', 'Included Nozzle Diameter', 'Nozzle Diameter (Included)'], { appliesTo: PRINTER, templateField: 'nozzle_diameter' }),
  k('extrusion.supported_nozzle_diameters', 'list', '', tri('أقطار النوزل المدعومة', 'Supported nozzle diameters', 'تیرەکانی نۆزڵی پشتگیریکراو'),
    ['Supported Nozzle Diameter', 'Supported Nozzle Diameters', 'Optional Nozzle Diameter'], { templateField: 'supported_nozzle_sizes' }),
  k('extrusion.filament_diameter', 'number', 'mm', tri('قطر الخيط', 'Filament diameter', 'تیرەی فیلامێنت'), ['Filament Diameter'],
    { appliesTo: ['printer', 'ams', 'hotend', 'part', 'accessory', 'other'], templateField: 'filament_diameter', expectedFor: PRINTER }),
  k('extrusion.extruder_motor', 'string', '', tri('محرك الدافع', 'Extruder motor', 'بزوێنەری پاڵنەر'), ['Extruder Motor']),
  // ---- thermal ----------------------------------------------------------
  k('thermal.max_nozzle_temp', 'number', '°C', tri('أقصى حرارة للنوزل', 'Max nozzle temperature', 'زۆرترین پلەی گەرمیی نۆزڵ'),
    ['Max Hot End Temperature', 'Max Hotend Temperature', 'Max Printing Temp', 'Max Printing Temperature', 'Max Nozzle Temperature', 'Maximum Nozzle Temperature', 'Nozzle Max Temperature', 'Hotend Max Temperature'],
    { templateField: 'nozzle_temp_max', compare: true, expectedFor: PRINTER }),
  k('thermal.max_bed_temp', 'number', '°C', tri('أقصى حرارة لصفيحة الطباعة', 'Max build plate temperature', 'زۆرترین پلەی گەرمیی پلێتی چاپ'),
    ['Max Build Plate Temperature', 'Max Heatbed Temperature', 'Max Heated Bed Temperature', 'Heatbed Max Temperature', 'Max Bed Temperature', 'Max Build Plate Temperature (Heatbed)'],
    { templateField: 'bed_temp_max', compare: true, expectedFor: PRINTER }),
  k('thermal.chamber_temp', 'number', '°C', tri('حرارة حجرة الطباعة', 'Chamber temperature', 'پلەی گەرمیی ژووری چاپ'),
    ['Chamber Temperature', 'Max Chamber Temperature', 'Chamber Max Temperature', 'Chamber Temperature Regulation'], { templateField: 'chamber_temp_max' }),
  k('thermal.chamber_heating', 'boolean', '', tri('تسخين نشط لحجرة الطباعة', 'Active chamber heating', 'گەرمکردنی چالاکی ژووری چاپ'), ['Active Chamber Heating', 'Chamber Heating'], { appliesTo: PRINTER }),
  k('thermal.heat_deflection_temp', 'number', '°C', tri('درجة حرارة الانحراف الحراري', 'Heat deflection temperature', 'پلەی گەرمیی لاربوونەوە'), ['Heat Deflection Temperature', 'HDT'], { appliesTo: FILAMENT, templateField: 'heat_deflection' }),
  k('thermal.vicat_softening', 'number', '°C', tri('درجة حرارة تليّن فيكات', 'Vicat softening temperature', 'پلەی نەرمبوونی ڤیکات'), ['Vicat Softening Temperature', 'Vicat Softening Point'], { appliesTo: FILAMENT }),
  k('thermal.melting_temp', 'number', '°C', tri('درجة الانصهار', 'Melting temperature', 'پلەی توانەوە'), ['Melting Temperature', 'Melting Point'], { appliesTo: FILAMENT }),
  k('thermal.glass_transition', 'number', '°C', tri('درجة التحول الزجاجي', 'Glass transition temperature', 'پلەی گۆڕانی شووشەیی'), ['Glass Transition Temperature', 'Tg'], { appliesTo: FILAMENT }),
  // ---- electrical (region-dependent) ------------------------------------
  k('electrical.voltage', 'string', '', tri('الجهد الكهربائي', 'Voltage', 'ڤۆڵتیە'),
    ['Voltage', 'Input Voltage', 'Rated Voltage', 'Voltage Range', 'Power Supply', 'Operating Voltage', 'Working Voltage', 'Voltage / Operation Voltage'],
    { templateField: 'voltage', regionDependent: 'always', expectedFor: PRINTER }),
  k('electrical.max_power', 'number', 'W', tri('أقصى قدرة', 'Max power', 'زۆرترین توانا'), ['Max Power', 'Max Power*', 'Maximum Power', 'Peak Power'], { regionDependent: 'always' }),
  k('electrical.rated_power', 'number', 'W', tri('القدرة المقدّرة', 'Rated power', 'توانای دیاریکراو'),
    ['Rated Power', 'Power', 'Average Power', 'Power Consumption', 'Typical Power', 'Output Power'], { templateField: 'rated_power', regionDependent: 'always' }),
  k('electrical.current', 'string', '', tri('التيار', 'Current', 'تەزوو'), ['Current', 'Rated Current', 'Electricity', 'Electric Current', 'Working Current'], { templateField: 'current', regionDependent: 'always' }),
  k('electrical.frequency', 'string', '', tri('التردد', 'Frequency', 'لەرەلەر'), ['Frequency', 'Input Frequency'], { regionDependent: 'always' }),
  k('electrical.battery', 'string', '', tri('البطارية', 'Battery', 'پاتری'), ['Battery', 'Batteries', 'Battery Capacity', 'Battery Type'], { templateField: 'battery', regionDependent: 'always' }),
  k('electrical.connector', 'string', '', tri('الموصل', 'Connector', 'گەیەنەر'), ['Connector', 'Connector Type', 'Port', 'Interface Type'], { regionDependent: 'always' }),
  k('electrical.standby_power', 'number', 'W', tri('قدرة الاستعداد', 'Standby power', 'توانای چاوەڕوانی'), ['Standby Power'], { regionDependent: 'always' }),
  // ---- connectivity -----------------------------------------------------
  k('connectivity.wifi', 'string', '', tri('الواي فاي', 'Wi-Fi', 'وایفای'), ['Wi-Fi', 'WiFi', 'Wireless', 'Wi-Fi Frequency Range']),
  k('connectivity.bluetooth', 'string', '', tri('البلوتوث', 'Bluetooth', 'بلووتووس'), ['Bluetooth']),
  k('connectivity.storage', 'string', '', tri('وسائط التخزين', 'Storage', 'بیرگە'), ['Storage', 'Storage Media', 'MicroSD', 'Micro SD Card', 'USB Storage', 'Built-in Storage'], { templateField: 'storage' }),
  k('connectivity.display', 'string', '', tri('الشاشة', 'Display', 'شاشە'), ['Display', 'Screen', 'Touch Screen', 'Touchscreen'], { templateField: 'display' }),
  k('connectivity.interface', 'string', '', tri('المنافذ', 'Interfaces', 'دەرچەکان'), ['Interface', 'Ports', 'Interfaces'], { templateField: 'interface' }),
  // ---- physical ---------------------------------------------------------
  k('physical.chassis', 'string', '', tri('الهيكل والغلاف', 'Chassis & shell', 'چوارچێوە و ڕووپۆش'), ['Chassis', 'Chassis & Shell', 'Body Material', 'Shell', 'Housing Material', 'Frame']),
  k('physical.recommended_space', 'object', 'mm', tri('المساحة الموصى بها', 'Recommended space', 'ئەو شوێنەی پێشنیار دەکرێت'), ['Recommended Space', 'Recommended Space for Printer']),
  k('physical.noise', 'string', '', tri('مستوى الضجيج', 'Noise level', 'ئاستی دەنگەدەنگ'), ['Noise Level', 'Noise']),
  k('physical.operating_temp', 'string', '', tri('حرارة التشغيل', 'Operating temperature', 'پلەی گەرمیی کارکردن'), ['Operating Temperature', 'Working Temperature', 'Operating Environment Temperature', 'Working Environment Temperature']),
  // ---- logistics (§B.7; never products.package_* / net_weight_g) -------
  k('product.length', 'number', 'mm', tri('طول المنتج', 'Product length', 'درێژیی بەرهەم'), ['Length', 'Product Length', 'L (mm) Length']),
  k('product.width', 'number', 'mm', tri('عرض المنتج', 'Product width', 'پانیی بەرهەم'), []),
  k('product.height', 'number', 'mm', tri('ارتفاع المنتج', 'Product height', 'بەرزیی بەرهەم'), []),
  k('product.net_weight', 'number', 'g', tri('الوزن الصافي', 'Net weight', 'کێشی پوخت'),
    ['Net Weight', 'Weight', 'Product Weight', 'Net weight (Printer)', 'Printer Weight', 'Item Weight'],
    { appliesTo: ['printer', 'ams', 'hotend', 'plate', 'tool', 'accessory', 'part', 'makers_supply', 'laser_material', 'other'], templateField: 'net_weight', expectedFor: ['printer', 'ams'] }),
  k('package.weight', 'number', 'g', tri('وزن العبوة', 'Package weight', 'کێشی پاکەت'), ['Packaging Weight', 'Package Weight', 'Packaged Weight', 'Packing Weight'], { regionDependent: 'printer' }),
  k('package.length', 'number', 'mm', tri('طول العبوة', 'Package length', 'درێژیی پاکەت'), [], { regionDependent: 'printer' }),
  k('package.width', 'number', 'mm', tri('عرض العبوة', 'Package width', 'پانیی پاکەت'), [], { regionDependent: 'printer' }),
  k('package.height', 'number', 'mm', tri('ارتفاع العبوة', 'Package height', 'بەرزیی پاکەت'), [], { regionDependent: 'printer' }),
  k('package.volume_m3', 'number', 'm³', tri('حجم العبوة (م³)', 'Package volume (m³)', 'قەبارەی پاکەت (م³)'), [], { ownerOnly: true }),
  k('shipment.gross_weight', 'number', 'g', tri('الوزن الإجمالي للشحنة', 'Shipment gross weight', 'کێشی گشتی بارەکە'), ['Gross Weight'], { regionDependent: 'printer' }),
  k('carton.pieces', 'number', '', tri('عدد القطع في الكرتونة', 'Pieces per carton', 'ژمارەی پارچە لە کارتۆنێکدا'), ['Pieces per Carton', 'Quantity per Carton', 'Carton Quantity', 'PCS/CTN']),
  k('carton.length', 'number', 'mm', tri('طول الكرتونة', 'Carton length', 'درێژیی کارتۆن'), []),
  k('carton.width', 'number', 'mm', tri('عرض الكرتونة', 'Carton width', 'پانیی کارتۆن'), []),
  k('carton.height', 'number', 'mm', tri('ارتفاع الكرتونة', 'Carton height', 'بەرزیی کارتۆن'), []),
  k('carton.weight', 'number', 'g', tri('وزن الكرتونة', 'Carton weight', 'کێشی کارتۆن'), ['Carton Weight', 'Carton Gross Weight']),
  // ---- contents ---------------------------------------------------------
  { ...k('package.contents', 'list', '', tri('محتويات العلبة', 'In the box', 'ناوەڕۆکی سندوق'), ['In the Box', 'Package Contents', 'Packing List', "What's in the box"], { templateField: 'in_the_box' }), group: 'contents' },
  // ---- material (filament) ----------------------------------------------
  k('material.type', 'string', '', tri('نوع المادة', 'Material', 'جۆری کەرەستە'), ['Material', 'Material Type', 'Filament Type'], { appliesTo: FILAMENT, templateField: 'material_type', cardKeyFor: FILAMENT }),
  k('material.diameter', 'number', 'mm', tri('القطر', 'Diameter', 'تیرە'), ['Diameter', 'Filament Diameter'], { appliesTo: FILAMENT, templateField: 'diameter', facet: true, compare: true, expectedFor: FILAMENT, cardKeyFor: FILAMENT }),
  k('material.diameter_tolerance', 'number', 'mm', tri('تفاوت القطر المسموح', 'Diameter tolerance', 'ڕێژەی جیاوازیی تیرە'), ['Diameter Tolerance', 'Tolerance'], { appliesTo: FILAMENT, templateField: 'tolerance' }),
  k('material.net_weight', 'number', 'g', tri('الوزن الصافي', 'Net weight', 'کێشی پوخت'), ['Net Weight', 'Filament Weight', 'Net Filament Weight'],
    { appliesTo: FILAMENT, templateField: 'net_weight', compare: true, expectedFor: FILAMENT, cardKeyFor: FILAMENT }),
  k('material.density', 'number', 'g/cm³', tri('الكثافة', 'Density', 'چڕی'), ['Density'], { appliesTo: FILAMENT, templateField: 'density', compare: true, expectedFor: FILAMENT }),
  k('material.spool_type', 'string', '', tri('نوع البكرة', 'Spool', 'جۆری ماسوورە'), ['Spool Type'], { appliesTo: FILAMENT, templateField: 'spool_type' }),
  k('material.length', 'number', 'mm', tri('طول الخيط', 'Filament length', 'درێژیی فیلامێنت'), ['Filament Length'], { appliesTo: FILAMENT, templateField: 'filament_length' }),
  // ---- mechanical (TDS; curated) ----------------------------------------
  k('mechanical.tensile_strength', 'number', 'MPa', tri('مقاومة الشد', 'Tensile strength', 'بەرگەی ڕاکێشان'), ['Tensile Strength'], { appliesTo: FILAMENT, templateField: 'tensile_strength', compare: true }),
  k('mechanical.elongation_at_break', 'number', '%', tri('الاستطالة عند الكسر', 'Elongation at break', 'درێژبوونەوە لە کاتی شکاندا'), ['Elongation at Break', 'Breaking Elongation'], { appliesTo: FILAMENT, templateField: 'elongation' }),
  k('mechanical.flexural_strength', 'number', 'MPa', tri('مقاومة الانحناء', 'Flexural strength', 'بەرگەی چەمانەوە'), ['Flexural Strength', 'Bending Strength'], { appliesTo: FILAMENT }),
  k('mechanical.flexural_modulus', 'number', 'MPa', tri('معامل الانحناء', 'Flexural modulus', 'هاوکۆلکەی چەمانەوە'), ['Flexural Modulus', 'Bending Modulus'], { appliesTo: FILAMENT }),
  k('mechanical.impact_strength', 'number', 'kJ/m²', tri('مقاومة الصدمات', 'Impact strength', 'بەرگەی لێدان'), ['Impact Strength', 'Charpy Impact Strength', 'Izod Impact Strength'], { appliesTo: FILAMENT }),
  k('mechanical.hardness', 'string', '', tri('الصلادة', 'Hardness', 'ڕەقی'), ['Hardness', 'Shore Hardness'], { appliesTo: FILAMENT, templateField: 'hardness' }),
  // ---- print settings and drying ----------------------------------------
  k('print_settings.nozzle_temp', 'range', '°C', tri('حرارة النوزل', 'Nozzle temperature', 'پلەی گەرمیی نۆزڵ'), ['Nozzle Temperature', 'Printing Temperature', 'Print Temperature', 'Recommended Nozzle Temperature'],
    { appliesTo: FILAMENT, templateField: 'print_temp', expectedFor: FILAMENT }),
  k('print_settings.bed_temp', 'range', '°C', tri('حرارة صفيحة الطباعة', 'Build plate temperature', 'پلەی گەرمیی پلێتی چاپ'), ['Bed Temperature', 'Build Plate Temperature', 'Heatbed Temperature', 'Recommended Bed Temperature'], { appliesTo: FILAMENT, templateField: 'bed_temp' }),
  k('print_settings.print_speed', 'range', 'mm/s', tri('سرعة الطباعة', 'Print speed', 'خێرایی چاپ'), ['Print Speed', 'Printing Speed', 'Recommended Print Speed'], { appliesTo: FILAMENT, templateField: 'print_speed' }),
  k('print_settings.fan_speed', 'string', '', tri('سرعة المروحة', 'Cooling fan speed', 'خێرایی پانکەی ساردکەرەوە'), ['Fan Speed', 'Cooling Fan Speed', 'Part Cooling Fan'], { appliesTo: FILAMENT, templateField: 'fan_speed' }),
  k('print_settings.recommended_plate', 'list', '', tri('الصفيحة الموصى بها', 'Recommended build plate', 'پلێتی پێشنیارکراو'), ['Recommended Build Plate', 'Build Plate Recommendation'], { appliesTo: FILAMENT }),
  k('drying.temperature', 'number', '°C', tri('حرارة التجفيف', 'Drying temperature', 'پلەی گەرمیی وشککردنەوە'), ['Drying Temperature'], { appliesTo: FILAMENT }),
  k('drying.time', 'number', 'h', tri('مدة التجفيف', 'Drying time', 'ماوەی وشککردنەوە'), ['Drying Time', 'Drying Duration'], { appliesTo: FILAMENT }),
  k('safety.certifications', 'list', '', tri('الشهادات', 'Certifications', 'بڕوانامەکان'), ['Certification', 'Certifications', 'Certificates'], { templateField: 'certifications' }),
  // ---- AMS --------------------------------------------------------------
  k('ams.slots', 'number', '', tri('عدد فتحات الخيوط', 'Filament slots', 'ژمارەی شوێنی فیلامێنت'), ['Slots', 'Number of Slots', 'Filament Slots', 'Material Slots'], { appliesTo: ['ams'], templateField: 'ams_slots' }),
  k('ams.max_units', 'string', '', tri('أقصى عدد للوحدات', 'Max units per printer', 'زۆرترین ژمارەی یەکە بۆ هەر چاپکەرێک'), ['Max Units', 'Maximum Units', 'Max AMS Units'], { appliesTo: ['ams'], templateField: 'ams_max_units' }),
  // ---- parts, nozzles, compatibility, identity --------------------------
  k('part.material', 'string', '', tri('المواد', 'Materials', 'کەرەستەکان'), ['Materials', 'Material', 'Part Material'],
    { appliesTo: ['part', 'accessory', 'hotend', 'plate', 'tool', 'makers_supply', 'ams', 'printer', 'laser_material', 'other'], templateField: 'material' }),
  k('part.color', 'string', '', tri('اللون', 'Colour', 'ڕەنگ'), ['Color', 'Colour'], { appliesTo: ['part', 'accessory', 'hotend', 'plate', 'tool', 'makers_supply', 'other'] }),
  k('nozzle.diameter', 'number', 'mm', tri('قطر النوزل', 'Nozzle diameter', 'تیرەی نۆزڵ'), [], { appliesTo: ['hotend', 'part', 'accessory'], templateField: 'nozzle_diameter', facet: true, expectedFor: ['hotend'], cardKeyFor: ['hotend'] }),
  k('nozzle.material', 'string', '', tri('مادة النوزل', 'Nozzle material', 'کەرەستەی نۆزڵ'), [], { appliesTo: ['hotend', 'part', 'accessory'], templateField: 'nozzle_material', expectedFor: ['hotend'], cardKeyFor: ['hotend'] }),
  k('compat.statement', 'string', '', tri('التوافق', 'Compatibility', 'گونجاوی'), ['Compatibility', 'Compatible Models', 'Compatible Printers', 'Applicable Models'], { templateField: 'compatibility' }),
  k('identity.model', 'string', '', tri('الطراز', 'Model', 'مۆدێل'), [], { templateField: 'model' }),
  k('identity.series', 'string', '', tri('السلسلة', 'Series', 'زنجیرە'), []),
  k('identity.family', 'string', '', tri('العائلة', 'Family', 'خێزان'), [], { templateField: 'product_family', facet: true }),
  k('manufacturer_terms.warranty_note', 'list', '', tri('ملاحظة ضمان من الشركة المصنّعة', "Manufacturer's warranty note", 'تێبینیی گەرەنتیی بەرهەمهێنەر'), [], { ownerOnly: true }),
  k('variant.note', 'string', '', tri('ملاحظة الخيار', 'Option note', 'تێبینیی هەڵبژاردە'), []),

  // ==== Labels the P0 scan left unknown (owner-questions §E.7): scans.md §5's top 50 and the step-4 corpus report's
  // most frequent ones. Generic part labels apply to PARTS only, so a printer table's own words keep their keys.

  // ---- printers: electrical, extrusion, filaments per hotend, work area, software and electronics
  k('electrical.requirements', 'string', '', tri('المتطلبات الكهربائية', 'Electrical requirements', 'پێداویستییە کارەباییەکان'), ['Electrical Requirements'],
    { regionDependent: 'always' }),
  k('electrical.steady_state_power', 'string', '', tri('القدرة في التشغيل المستقر', 'Steady-state power', 'توانا لە کارکردنی جێگیردا'),
    ['Steady-State Power', 'PLA Steady-State Power'], { regionDependent: 'always' }),
  k('extrusion.main_extruder_gear', 'string', '', tri('ترس الدافع الرئيسي', 'Main extruder gear', 'چەرخی پاڵنەری سەرەکی'), ['Main Extruder Gear'], { appliesTo: PRINTER }),
  k('extrusion.main_extruder_motor', 'string', '', tri('محرك الدافع الرئيسي', 'Main extruder motor', 'بزوێنەری پاڵنەری سەرەکی'), ['Main Extruder Motor'], { appliesTo: PRINTER }),
  k('extrusion.aux_extruder_gear', 'string', '', tri('ترس الدافع المساعد', 'Auxiliary extruder gear', 'چەرخی پاڵنەری یاریدەدەر'), ['Auxiliary Extruder Gear'], { appliesTo: PRINTER }),
  k('extrusion.aux_extruder_motor', 'string', '', tri('محرك الدافع المساعد', 'Auxiliary extruder motor', 'بزوێنەری پاڵنەری یاریدەدەر'), ['Auxiliary Extruder Motor'], { appliesTo: PRINTER }),
  k('printing.filament_main_hotend', 'list', '', tri('خيوط رأس الصهر الرئيسي', 'Main hotend filaments', 'فیلامێنتەکانی سەری تواندنەوەی سەرەکی'), ['Main Hotend'], { appliesTo: PRINTER }),
  k('printing.filament_aux_hotend', 'list', '', tri('خيوط رأس الصهر المساعد', 'Auxiliary hotend filaments', 'فیلامێنتەکانی سەری تواندنەوەی یاریدەدەر'), ['Auxiliary Hotend'], { appliesTo: PRINTER }),
  k('printing.filament_aux_hotend_caution', 'list', '', tri('خيوط رأس الصهر المساعد (بحذر)', 'Auxiliary hotend filaments (print with caution)', 'فیلامێنتەکانی سەری تواندنەوەی یاریدەدەر (بە ئاگاییەوە)'),
    ['Auxiliary Hotend (print with caution¹)', 'Auxiliary Hotend (print with caution)'], { appliesTo: PRINTER }),
  k('printing.working_area', 'string', '', tri('مساحة العمل', 'Working area', 'ڕووبەری کار'), ['Working area']),
  k('printing.usable_print_size', 'string', '', tri('مساحة الطباعة القابلة للاستخدام', 'Usable print size', 'ڕووبەری چاپی بەکارهاتوو'), ['Usable Print Size'], { appliesTo: ['plate'] }),
  k('printing.included_build_plate', 'list', '', tri('صفيحة الطباعة المرفقة', 'Included build plate', 'پلێتی چاپی لەگەڵدا'), ['Included Build Plate Type', 'Included Build Plate'], { appliesTo: PRINTER }),
  k('printing.build_plate_material', 'string', '', tri('مادة صفيحة الطباعة', 'Build plate material', 'کەرەستەی پلێتی چاپ'), ['Build Plate Material'], { appliesTo: PRINTER }),
  k('printing.door_sensor', 'boolean', '', tri('حساس الباب', 'Door sensor', 'هەستەوەری دەرگا'), ['Door Sensor'], { appliesTo: PRINTER }),
  k('printing.filament_cutter', 'string', '', tri('قاطع الخيط', 'Filament cutter', 'بڕەری فیلامێنت'), ['Filament Cutter'], { appliesTo: PRINTER }),
  k('physical.outer_frame', 'string', '', tri('الإطار الخارجي', 'Outer frame', 'چوارچێوەی دەرەوە'), ['Outer Frame'], { appliesTo: PRINTER }),
  // A string: the printers' cells are prose ("… export standard G-code, such as Super Slicer, PrusaSlicer and Cura …").
  k('connectivity.software', 'string', '', tri('البرمجيات', 'Software', 'نەرمەکاڵا'), ['Software', 'Slicer', 'Slicer & Software']),
  k('connectivity.operating_systems', 'list', '', tri('أنظمة التشغيل المدعومة', 'Supported operating systems', 'سیستەمە کارپێکەرە پشتگیریکراوەکان'),
    ['Operating Systems', 'Supported Operating System', 'Supported Operating Systems']),
  k('connectivity.control_interface', 'list', '', tri('واجهة التحكم', 'Control interface', 'ڕووکاری کۆنترۆڵ'), ['Control Interface'], { appliesTo: PRINTER }),
  k('connectivity.npu', 'string', '', tri('وحدة المعالجة العصبية (NPU)', 'Neural processing unit', 'یەکەی پرۆسێسکردنی دەماری (NPU)'), ['Neural Processing Unit'], { appliesTo: PRINTER }),
  k('connectivity.motion_controller', 'string', '', tri('وحدة التحكم بالحركة', 'Motion controller', 'کۆنترۆڵکەری جووڵە'), ['Motion Controller'], { appliesTo: PRINTER }),
  k('connectivity.application_processor', 'string', '', tri('المعالج الرئيسي', 'Application processor', 'پرۆسێسەری سەرەکی'), ['Application Processor'], { appliesTo: PRINTER }),
  k('connectivity.ethernet', 'string', '', tri('منفذ إيثرنت', 'Ethernet', 'ئیسەرنێت'), ['Ethernet'], { appliesTo: PRINTER }),
  // "Network Control › Wireless Network" is its own fact: the same tables carry a "Wi-Fi" matrix (frequency, power, protocol).
  k('connectivity.wireless_network', 'string', '', tri('الشبكة اللاسلكية', 'Wireless network', 'تۆڕی بێتەل'), ['Wireless Network'], { appliesTo: PRINTER }),
  k('connectivity.network_kill_switch', 'boolean', '', tri('مفتاح فصل الشبكة', 'Network kill switch', 'کلیلی پچڕاندنی تۆڕ'), ['Network Kill Switch'], { appliesTo: PRINTER }),
  k('connectivity.removable_network_module', 'boolean', '', tri('وحدة شبكة قابلة للإزالة', 'Removable network module', 'مۆدیولی تۆڕی لابراو'), ['Removable Network Module'],
    { appliesTo: PRINTER }),
  k('connectivity.network_access_control', 'boolean', '', tri('التحكم بالوصول إلى الشبكة (802.1X)', '802.1X network access control', 'کۆنترۆڵی چوونەناو تۆڕ (802.1X)'),
    ['802.1X Network Access Control'], { appliesTo: PRINTER }),
  // ---- printers: cooling and air filtration
  k('thermal.part_cooling_fan', 'string', '', tri('مروحة تبريد القطعة المطبوعة', 'Part cooling fan', 'پانکەی ساردکردنەوەی پارچەی چاپکراو'), ['Part Cooling Fan'], { appliesTo: PRINTER }),
  k('thermal.aux_part_cooling_fan', 'string', '', tri('مروحة التبريد المساعدة', 'Auxiliary part cooling fan', 'پانکەی ساردکردنەوەی یاریدەدەر'), ['Auxiliary Part Cooling Fan'], { appliesTo: PRINTER }),
  k('thermal.hotend_fan', 'string', '', tri('مروحة تبريد رأس الصهر', 'Hotend cooling fan', 'پانکەی ساردکردنەوەی سەری تواندنەوە'), ['Cooling Fan for Hotend'], { appliesTo: PRINTER }),
  k('thermal.chamber_circulation_fan', 'string', '', tri('مروحة تدوير حرارة الحجرة', 'Chamber heat circulation fan', 'پانکەی سووڕاندنەوەی گەرمیی ژووری چاپ'), ['Chamber Heat Circulation Fan'],
    { appliesTo: PRINTER }),
  k('thermal.control_board_fan', 'string', '', tri('مروحة لوحة التحكم الرئيسية', 'Main control board fan', 'پانکەی تەختەی کۆنترۆڵی سەرەکی'), ['Main Control Board Fan', 'Control Board Fan'],
    { appliesTo: PRINTER }),
  k('thermal.chamber_exhaust_fan', 'string', '', tri('مروحة شفط هواء الحجرة', 'Chamber exhaust fan', 'پانکەی دەرکردنی هەوای ژووری چاپ'), ['Chamber Exhaust Fan'], { appliesTo: PRINTER }),
  k('safety.prefilter_grade', 'string', '', tri('درجة المرشح الأولي', 'Pre-filter grade', 'پلەی فلتەری سەرەتایی'), ['Pre-filter Grade'], { appliesTo: PRINTER }),
  k('safety.hepa_grade', 'string', '', tri('درجة مرشح HEPA', 'HEPA filter grade', 'پلەی فلتەری HEPA'), ['HEPA Filter Grade'], { appliesTo: PRINTER }),
  k('safety.carbon_filter', 'string', '', tri('نوع مرشح الكربون المنشّط', 'Activated carbon filter type', 'جۆری فلتەری کاربۆنی چالاککراو'), ['Activated Carbon Filter Type'],
    { appliesTo: PRINTER }),
  k('safety.voc_filtration', 'string', '', tri('ترشيح المركبات العضوية المتطايرة (VOC)', 'VOC filtration', 'پاڵاوتنی پێکهاتە ئۆرگانییە بەهەڵمبووەکان (VOC)'), ['VOC Filtration'],
    { appliesTo: PRINTER }),
  k('safety.particulate_filtration', 'string', '', tri('ترشيح الجسيمات الدقيقة', 'Particulate matter filtration', 'پاڵاوتنی گەردیلە وردەکان'), ['Particulate Matter Filtration'],
    { appliesTo: PRINTER }),
  // ---- parts: fasteners, bearings, magnets, belts and other hardware (Maker's Supply)
  k('part.shape', 'string', '', tri('الشكل', 'Shape', 'شێوە'), ['Shape'], { appliesTo: PARTS }),
  k('part.type', 'string', '', tri('النوع', 'Type', 'جۆر'), ['Type'], { appliesTo: PARTS }),
  k('part.style', 'string', '', tri('الطراز', 'Style', 'شێواز'), ['Style'], { appliesTo: PARTS }),
  k('part.feature', 'string', '', tri('الميزة', 'Feature', 'تایبەتمەندی'), ['Feature'], { appliesTo: PARTS }),
  k('part.surface_treatment', 'string', '', tri('المعالجة السطحية', 'Surface treatment', 'چارەسەری ڕووکار'), ['Surface Treatment'], { appliesTo: PARTS }),
  k('part.surface_type', 'string', '', tri('نوع السطح', 'Surface type', 'جۆری ڕووکار'), ['Surface Type'], { appliesTo: PARTS }),
  k('part.thread_type', 'string', '', tri('نوع السنّ', 'Thread type', 'جۆری پێچ'), ['Thread Ridge Type', 'Thread Type'], { appliesTo: PARTS }),
  k('part.screw_type', 'string', '', tri('نوع البرغي', 'Screw type', 'جۆری بورغی'), ['Screw Type'], { appliesTo: PARTS }),
  k('part.drive_shape', 'string', '', tri('شكل فتحة الرأس', 'Mounting hole shape', 'شێوەی کونی سەری بورغی'), ['Mounting Hole Shape'], { appliesTo: PARTS }),
  k('part.fastener_type', 'string', '', tri('نوع أداة التثبيت', 'Fastener type', 'جۆری بەستەر'), ['Fastener Type'], { appliesTo: PARTS }),
  k('part.pin_type', 'string', '', tri('نوع الدبوس', 'Pin type', 'جۆری پین'), ['Pin Type'], { appliesTo: PARTS }),
  k('part.end_shape', 'string', '', tri('شكل الطرف', 'End shape', 'شێوەی سەر'), ['End Shape'], { appliesTo: PARTS }),
  k('part.mount_type', 'string', '', tri('طريقة التثبيت', 'Mount type', 'شێوازی دامەزراندن'), ['Mount Type'], { appliesTo: PARTS }),
  k('part.bearing_type', 'string', '', tri('نوع المحمل', 'Bearing type', 'جۆری بێرینگ'), ['Bearing Type'], { appliesTo: PARTS }),
  k('part.bearing_construction', 'string', '', tri('بنية المحمل', 'Bearing construction', 'پێکهاتەی بێرینگ'), ['Bearing Construction'], { appliesTo: PARTS }),
  k('part.ball_bearing_profile', 'string', '', tri('مقطع المحمل الكروي', 'Ball bearing profile', 'پرۆفایلی بێرینگی تۆپەڵەیی'), ['Ball Bearing Profile'], { appliesTo: PARTS }),
  k('part.ring_material', 'string', '', tri('مادة الحلقتين الداخلية والخارجية', 'Inner and outer ring material', 'کەرەستەی ئەڵقەی ناوەوە و دەرەوە'), ['Inner & Outer Ring Material'],
    { appliesTo: PARTS }),
  k('part.cage_material', 'string', '', tri('مادة القفص', 'Cage material', 'کەرەستەی قەفەس'), ['Cage Material'], { appliesTo: PARTS }),
  k('part.ball_type', 'string', '', tri('نوع الكرات', 'Ball type', 'جۆری تۆپەڵەکان'), ['Ball Type'], { appliesTo: PARTS }),
  k('part.magnetization', 'string', '', tri('اتجاه المغنطة', 'Direction of magnetization', 'ئاراستەی موگناتیسکردن'), ['Direction of Magnetization'], { appliesTo: PARTS }),
  k('part.magnet_grade', 'string', '', tri('درجة المغناطيس', 'Magnet grade', 'پلەی موگناتیس'), ['Magnet Grade'], { appliesTo: PARTS }),
  k('part.front_material', 'string', '', tri('مادة الوجه الأمامي', 'Front material', 'کەرەستەی ڕووی پێشەوە'), ['Front Material'], { appliesTo: PARTS }),
  k('part.back_material', 'string', '', tri('مادة الوجه الخلفي', 'Back material', 'کەرەستەی ڕووی پشتەوە'), ['Back Material'], { appliesTo: PARTS }),
  k('part.handle_material', 'string', '', tri('مادة المقبض', 'Handle material', 'کەرەستەی دەسک'), ['Handle Material'], { appliesTo: PARTS }),
  k('part.teeth_type', 'string', '', tri('نوع الأسنان', 'Teeth type', 'جۆری ددانەکان'), ['Teeth Type'], { appliesTo: PARTS }),
  k('physical.thickness', 'number', 'mm', tri('السماكة', 'Thickness', 'ئەستووری'), ['Thickness'], { appliesTo: PARTS }),
  k('contents.pieces', 'number', '', tri('عدد القطع في العبوة', 'Pieces per pack', 'ژمارەی پارچە لە هەر پاکەتێکدا'), ['Quantity'], { appliesTo: PARTS }),
  k('part.capacity', 'string', '', tri('السعة', 'Capacity', 'توانای گرتن'), ['Capacity', 'Package volume'], { appliesTo: PARTS }),
  k('part.cable_width', 'number', 'mm', tri('عرض الكابل', 'Cable width', 'پانیی کێبڵ'), ['Cable width'], { appliesTo: PARTS }),
  k('part.lanyard_circumference', 'number', 'mm', tri('محيط حبل التعليق', 'Lanyard circumference', 'دەوری پەتی هەڵواسین'), ['Lanyard Circumference'], { appliesTo: PARTS }),
  k('part.temperature_range', 'string', '', tri('نطاق درجة الحرارة', 'Temperature range', 'مەودای پلەی گەرمی'), ['Temperature', 'Temperature Range'], { appliesTo: PARTS }),
  k('part.max_temperature', 'number', '°C', tri('أقصى درجة حرارة', 'Max temperature', 'زۆرترین پلەی گەرمی'), ['Max Temperature'], { appliesTo: PARTS }),
  k('part.humidity', 'string', '', tri('الرطوبة', 'Humidity', 'شێ'), ['Humidity'], { appliesTo: PARTS }),
  k('part.expected_life', 'number', 'h', tri('العمر التشغيلي المتوقع', 'Expected life', 'تەمەنی کارکردنی چاوەڕوانکراو'), ['Expected Life', 'LED life time'], { appliesTo: PARTS }),
  k('part.life_cycle', 'string', '', tri('العمر الافتراضي', 'Life cycle', 'تەمەنی بەکارهێنان'), ['Life Cycle'], { appliesTo: PARTS }),
  // ---- parts: fans, electronics, displays, toys and computer accessories
  k('part.rated_speed', 'string', '', tri('السرعة المقدّرة', 'Rated speed', 'خێرایی دیاریکراو'), ['Rated Speed'], { appliesTo: PARTS }),
  k('part.max_air_flow', 'string', '', tri('أقصى تدفق للهواء', 'Max air flow', 'زۆرترین ڕۆیشتنی هەوا'), ['Max Air Flow'], { appliesTo: PARTS }),
  k('part.led_count', 'number', '', tri('عدد مصابيح LED', 'Number of LEDs', 'ژمارەی گڵۆپە LEDەکان'), ['Number of LEDs'], { appliesTo: PARTS }),
  k('part.led_board_type', 'string', '', tri('نوع لوحة LED', 'LED board type', 'جۆری تەختەی LED'), ['LED Board Type'], { appliesTo: PARTS }),
  k('part.power_source', 'string', '', tri('مصدر الطاقة', 'Power source', 'سەرچاوەی وزە'), ['Power Source'], { appliesTo: PARTS }),
  k('part.connection', 'string', '', tri('طريقة الاتصال', 'Connection', 'شێوازی پەیوەندی'), ['Connectivity'], { appliesTo: PARTS }),
  k('part.external_interface', 'string', '', tri('المنفذ الخارجي', 'External interface', 'دەرچەی دەرەکی'), ['External interface'], { appliesTo: PARTS }),
  k('part.platforms', 'list', '', tri('الأجهزة المتوافقة', 'Compatible platforms', 'ئامێرە گونجاوەکان'), ['Hardware Platform'], { appliesTo: PARTS }),
  k('part.sensor_type', 'string', '', tri('نوع الحساس', 'Sensor type', 'جۆری هەستەوەر'), ['Sensor'], { appliesTo: PARTS }),
  k('part.buttons', 'string', '', tri('الأزرار', 'Buttons', 'دوگمەکان'), ['Button'], { appliesTo: PARTS }),
  k('part.dpi', 'string', '', tri('دقة الماوس (DPI)', 'DPI', 'وردیی ماوس (DPI)'), ['DPI'], { appliesTo: PARTS }),
  k('part.rate_of_fire', 'string', '', tri('معدل الإطلاق', 'Rate of fire', 'خێرایی تەقاندن'), ['Rate of Fire'], { appliesTo: PARTS }),
  k('part.screen_ratio', 'string', '', tri('نسبة أبعاد الشاشة', 'Screen aspect ratio', 'ڕێژەی درێژی و پانیی شاشە'), ['Screen ratio'], { appliesTo: PARTS }),
  k('part.rotating_angle', 'string', '', tri('زاوية الدوران', 'Rotating angle', 'گۆشەی سووڕانەوە'), ['Rotating angle'], { appliesTo: PARTS }),
  k('part.lcd_type', 'string', '', tri('نوع شاشة LCD', 'LCD type', 'جۆری شاشەی LCD'), ['LCD type'], { appliesTo: PARTS }),
  k('part.module_power', 'string', '', tri('استهلاك الوحدة للطاقة', 'Module power consumption', 'بەکارهێنانی وزەی مۆدیول'), ['Module power consumption'], { appliesTo: PARTS }),
  k('part.viewing_direction', 'string', '', tri('اتجاه الرؤية الموصى به', 'Recommended viewing direction', 'ئاراستەی بینینی پێشنیارکراو'), ['Recommended viewing direction'],
    { appliesTo: PARTS }),
  k('part.backlight', 'string', '', tri('نوع الإضاءة الخلفية', 'Backlight type', 'جۆری ڕووناکیی پشتەوە'), ['Backlight type'], { appliesTo: PARTS }),
  k('part.viewing_area', 'string', '', tri('مساحة العرض (العرض × الارتفاع)', 'Viewing area (W × H)', 'ڕووبەری بینین (پانی × بەرزی)'), ['Viewing area (W*H)'], { appliesTo: PARTS }),
  k('part.active_area', 'string', '', tri('المساحة الفعّالة (العرض × الارتفاع)', 'Active area (W × H)', 'ڕووبەری چالاک (پانی × بەرزی)'), ['Active area (W*H)', 'Active Area'],
    { appliesTo: PARTS }),
  k('part.resolution', 'string', '', tri('الدقة', 'Resolution', 'ڕوونی'), ['Resolution', 'Number of Dots'], { appliesTo: PARTS }),
  k('part.display_colours', 'string', '', tri('ألوان الشاشة', 'Display colours', 'ڕەنگەکانی شاشە'), ['Display Color'], { appliesTo: PARTS }),
  k('part.contrast_ratio', 'string', '', tri('نسبة التباين', 'Contrast ratio', 'ڕێژەی جیاوازیی ڕووناکی'), ['Contrast ratio', 'Constrast ratio'], { appliesTo: PARTS }),
  k('part.luminance', 'string', '', tri('سطوع السطح', 'Surface luminance', 'درەوشانەوەی ڕووکار'), ['Surface Luminance'], { appliesTo: PARTS }),
  k('part.luminance_uniformity', 'string', '', tri('تجانس السطوع', 'Luminance uniformity', 'یەکسانیی درەوشانەوە'), ['Luminance uniformity'], { appliesTo: PARTS }),
  k('part.viewing_angle', 'string', '', tri('نطاق زاوية الرؤية', 'Viewing angle range', 'مەودای گۆشەی بینین'), ['Viewing angle range'], { appliesTo: PARTS }),
];

const BY_KEY = new Map(SPEC_KEYS.map((s) => [s.key, s]));

/** The registry entry of a canonical key, or undefined (an `x.*` key has none). */
export function specKey(key: string): SpecKey | undefined {
  return BY_KEY.get(key);
}

const BY_SYNONYM = new Map<string, SpecKey[]>();
for (const s of SPEC_KEYS) {
  for (const syn of s.synonyms) {
    const kk = labelKey(syn);
    const list = BY_SYNONYM.get(kk) ?? [];
    list.push(s);
    BY_SYNONYM.set(kk, list);
  }
}

/**
 * The canonical key of a source label for a product type: a registry synonym,
 * case- and punctuation-insensitive. When two keys share a synonym ("Net
 * Weight": material.net_weight for a filament, product.net_weight otherwise),
 * the one that applies to the type wins; a key with no type list applies to all.
 */
export function keyForLabel(label: string, type: ProductType): SpecKey | null {
  const list = BY_SYNONYM.get(labelKey(label).replace(/\s*\*$/, ''));
  if (!list?.length) return null;
  return list.find((s) => s.appliesTo.includes(type)) ?? list.find((s) => s.appliesTo.length === 0) ?? null;
}

/** The registry keys expected for a type (absent ones become `not_found`). */
export function expectedKeys(type: ProductType): SpecKey[] {
  return SPEC_KEYS.filter((s) => s.expectedFor?.includes(type));
}

/** Whether a key is region-dependent for a product type (§C.6). */
export function isRegionDependent(key: string, type: ProductType): boolean {
  const s = BY_KEY.get(key);
  if (!s?.regionDependent) return false;
  return s.regionDependent === 'always' || isMachine(type);
}
