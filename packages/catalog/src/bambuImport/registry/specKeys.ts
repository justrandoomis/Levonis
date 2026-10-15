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

export const SPEC_KEYS: readonly SpecKey[] = [
  // ---- printing ---------------------------------------------------------
  k('printing.technology', 'string', '', tri('تقنية الطباعة', 'Printing technology', 'تەکنەلۆژیای چاپ'), ['Printing Technology', 'Technology', 'Print Technology'], { templateField: 'technology' }),
  k('printing.build_volume', 'object', 'mm', tri('حجم الطباعة', 'Build volume', 'قەبارەی چاپ'),
    ['Build Volume', 'Print Volume', 'Printing volume', 'Build volume (W×D×H)', 'Build Volume (W*D*H)', 'Build Volume(W*D*H)', 'Printing Volume', 'Print Size', 'Build Size'],
    { templateField: 'build_volume', facet: true, compare: true, expectedFor: PRINTER, cardKeyFor: PRINTER }),
  k('printing.layer_height', 'range', 'mm', tri('ارتفاع الطبقة', 'Layer height', 'بەرزیی چین'), ['Layer Height', 'Layer Thickness', 'Layer Height Range'], { templateField: 'layer_height_range' }),
  k('printing.build_plate', 'list', '', tri('صفيحة الطباعة', 'Build plate', 'پلێتی چاپ'), ['Build Plate', 'Build Plate Type', 'Supported Build Plate', 'Build Plate Surface Compatibility'], { templateField: 'build_plate' }),
  k('printing.supported_filament', 'list', '', tri('الخيوط المدعومة', 'Supported filament', 'فیلامێنتە پشتگیریکراوەکان'),
    ['Supported Filament', 'Supported Filament Type', 'Supported Filament Types', 'Filament Supported', 'Compatible Filament', 'Supported Materials', 'Filament Compatibility', 'Supported Filaments'], { templateField: 'supported_filaments' }),
  k('printing.unsupported_filament', 'list', '', tri('خيوط غير مدعومة', 'Filament not supported', 'فیلامێنتە پشتگیرینەکراوەکان'), ['Filament Not Supported', 'Unsupported Filament', 'Unsupported Filaments']),
  k('printing.camera', 'string', '', tri('كاميرا المراقبة', 'Monitoring camera', 'کامێرای چاودێری'),
    ['Chamber Monitoring Camera', 'Camera', 'Live View Camera', 'Toolhead Camera', 'Nozzle Camera', 'BirdsEye Camera'], { templateField: 'camera' }),
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
    ['Max Hot End Flow', 'Maximum Volumetric Speed', 'Max Flow Rate', 'Max Flow', 'Max Volumetric Flow'], { templateField: 'max_flow_rate' }),
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
    ['Voltage', 'Input Voltage', 'Rated Voltage', 'Voltage Range', 'Power Supply', 'Operating Voltage', 'Working Voltage'],
    { templateField: 'voltage', regionDependent: 'always', expectedFor: PRINTER }),
  k('electrical.max_power', 'number', 'W', tri('أقصى قدرة', 'Max power', 'زۆرترین توانا'), ['Max Power', 'Max Power*', 'Maximum Power', 'Peak Power'], { regionDependent: 'always' }),
  k('electrical.rated_power', 'number', 'W', tri('القدرة المقدّرة', 'Rated power', 'توانای دیاریکراو'),
    ['Rated Power', 'Power', 'Average Power', 'Power Consumption', 'Typical Power', 'Output Power'], { templateField: 'rated_power', regionDependent: 'always' }),
  k('electrical.current', 'string', '', tri('التيار', 'Current', 'تەزوو'), ['Current', 'Rated Current', 'Electricity', 'Electric Current', 'Working Current'], { templateField: 'current', regionDependent: 'always' }),
  k('electrical.frequency', 'string', '', tri('التردد', 'Frequency', 'لەرەلەر'), ['Frequency', 'Input Frequency'], { regionDependent: 'always' }),
  k('electrical.battery', 'string', '', tri('البطارية', 'Battery', 'پاتری'), ['Battery', 'Battery Capacity', 'Battery Type'], { templateField: 'battery', regionDependent: 'always' }),
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
  k('product.length', 'number', 'mm', tri('طول المنتج', 'Product length', 'درێژیی بەرهەم'), ['Length', 'Product Length']),
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
