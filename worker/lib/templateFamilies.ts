/**
 * The two dynamic template families — mandate §10.
 *
 *   A) Devices    printers, machines and their electronic accessories
 *   B) Materials  filaments, resins, accessories, Maker's Supply, parts
 *
 * ONE DEFINITION, TWO CONSUMERS. The admin product form renders these fields
 * (§1: "تعرض فقط الحقول ذات الصلة بالقسم والقالب المختار") and the import
 * template generates its columns from them (§10: "الأعمدة تتغير حسب القسم
 * والقالب، ولا تظهر أعمدة لا تخص المنتج"). They are served to the browser
 * rather than duplicated in `src/`, so a column and a form field can never
 * drift apart.
 *
 * A family is chosen by the product's section: `catalogs.template_family`,
 * resolved up the branch. Section add-ons are keyed by the catalog SLUG of the
 * seeded tree; a section an admin invents later simply gets its family's
 * common fields, which is an honest fallback rather than an empty form.
 *
 * Field labels are Arabic-first with an English secondary, matching the rest
 * of the admin panel. VALUES are entered in English only (§3) and translated
 * locally afterwards.
 */

export type FieldType = 'text' | 'number' | 'select' | 'multiline' | 'hex';

export interface TemplateField {
  id: string;
  label_ar: string;
  label_en: string;
  type: FieldType;
  /** Shown after the input and appended to the import column header. */
  unit?: string;
  /** For type 'select'; values are stored verbatim. */
  options?: string[];
  /** A required field blocks PUBLISHING, never saving a draft. */
  required?: boolean;
  /** Short helper line; long prose belongs in a tooltip, never in the form. */
  hint_ar?: string;
}

export interface TemplateGroup {
  id: string;
  label_ar: string;
  label_en: string;
  fields: TemplateField[];
}

export interface TemplateFamilyDef {
  id: 'devices' | 'materials';
  label_ar: string;
  label_en: string;
  /** Fields every product in the family has. */
  common: TemplateGroup;
  /** Extra groups keyed by catalog slug. */
  sections: Record<string, TemplateGroup>;
}

const t = (
  id: string,
  label_ar: string,
  label_en: string,
  type: FieldType = 'text',
  extra: Partial<TemplateField> = {}
): TemplateField => ({ id, label_ar, label_en, type, ...extra });

export const DEVICES: TemplateFamilyDef = {
  id: 'devices',
  label_ar: 'الأجهزة',
  label_en: 'Devices',
  common: {
    id: 'device_core',
    label_ar: 'مواصفات الجهاز',
    label_en: 'Device specifications',
    fields: [
      t('technology', 'التقنية', 'Technology', 'select', { options: ['FDM', 'Resin (MSLA)', 'SLA', 'DLP', 'Other'] }),
      t('model', 'الموديل', 'Model'),
      t('build_volume', 'حجم الطباعة', 'Build volume', 'text', { unit: 'mm', hint_ar: 'مثال: 256 x 256 x 256' }),
      t('print_speed', 'السرعة', 'Print speed', 'number', { unit: 'mm/s' }),
      t('resolution', 'الدقة', 'Resolution'),
      t('nozzle', 'القطر / النوزل', 'Nozzle diameter', 'text', { unit: 'mm' }),
      t('supported_materials', 'الأنظمة والمواد المتوافقة', 'Supported materials'),
      t('power', 'الطاقة', 'Power', 'text', { unit: 'W' }),
      t('dimensions', 'الأبعاد', 'Dimensions', 'text', { unit: 'mm' }),
      t('weight', 'الوزن', 'Weight', 'text', { unit: 'kg' }),
      t('connectivity', 'الاتصال', 'Connectivity'),
      t('compatibility', 'التوافق', 'Compatibility'),
      t('display', 'الشاشة', 'Display'),
      t('camera', 'الكاميرا', 'Camera', 'select', { options: ['Yes', 'No', 'Optional'] }),
      t('noise_level', 'مستوى الضجيج', 'Noise level', 'number', { unit: 'dB' }),
      t('slicer_software', 'برامج التقطيع المدعومة', 'Slicer software'),
      t('assembly', 'الحالة عند التسليم', 'Assembly', 'select', {
        options: ['Pre-assembled', 'Partially assembled', 'Kit'],
      }),
      t('warranty', 'الضمان', 'Warranty', 'text', { unit: 'months' }),
      t('in_the_box', 'محتويات العلبة', 'In the box', 'multiline', {
        hint_ar: 'عنصر في كل سطر — تُعرض للزبون كنقاط',
      }),
    ],
  },
  sections: {
    'fdm-printers': {
      id: 'fdm',
      label_ar: 'خاص بطابعات FDM',
      label_en: 'FDM specifics',
      fields: [
        t('nozzle_temp_max', 'أقصى حرارة نوزل', 'Max nozzle temperature', 'number', { unit: '°C' }),
        t('bed_temp_max', 'أقصى حرارة سرير', 'Max bed temperature', 'number', { unit: '°C' }),
        t('extruders', 'عدد الباثقات', 'Extruders', 'number'),
        t('enclosed', 'هيكل مغلق', 'Enclosed', 'select', { options: ['Yes', 'No'] }),
        t('auto_leveling', 'التسوية التلقائية', 'Auto leveling', 'select', { options: ['Yes', 'No'] }),
        t('multi_color', 'دعم تعدد الألوان', 'Multi-colour support'),
        t('motion_system', 'نظام الحركة', 'Motion system', 'text', { hint_ar: 'مثال: CoreXY أو Bed slinger' }),
        t('filament_diameter', 'قطر الفلامنت', 'Filament diameter', 'text', { unit: 'mm' }),
        t('max_flow_rate', 'أقصى معدل تدفق', 'Max flow rate', 'number', { unit: 'mm³/s' }),
      ],
    },
    'resin-printers': {
      id: 'resin',
      label_ar: 'خاص بطابعات Resin',
      label_en: 'Resin specifics',
      fields: [
        t('lcd_size', 'مقاس الشاشة', 'LCD size', 'text', { unit: 'in' }),
        t('lcd_resolution', 'دقة الشاشة', 'LCD resolution'),
        t('xy_resolution', 'دقة XY', 'XY resolution', 'text', { unit: 'µm' }),
        t('layer_height_range', 'مدى ارتفاع الطبقة', 'Layer height range', 'text', { unit: 'mm' }),
        t('light_source', 'مصدر الضوء', 'Light source'),
        t('exposure_time', 'زمن التعريض', 'Exposure time', 'text', { unit: 's' }),
        t('uv_power', 'قدرة الضوء UV', 'UV power', 'text', { unit: 'W' }),
        t('release_film', 'فيلم الفصل', 'Release film'),
      ],
    },
    // The parent «ملحقات الطابعات» section: an accessory picked at the parent
    // level (before FDM/Resin narrowing) still gets accessory fields — the
    // owner's rule that the section RESPONDS to the branch, not just the leaf.
    'printer-accessories': {
      id: 'acc_common',
      label_ar: 'بيانات الملحق',
      label_en: 'Accessory details',
      fields: [
        t('fits_models', 'يناسب الموديلات', 'Fits models'),
        t('install_type', 'طريقة التركيب', 'Installation'),
        t('material', 'الخامة', 'Material'),
        t('use_case', 'الاستخدام', 'Use case'),
      ],
    },
    // fits_models / install_type moved UP into acc_common: a leaf branch
    // includes its parent's group too, and the same field id twice in one
    // branch would mean a duplicated CSV column and a doubled form field.
    'resin-printer-accessories': {
      id: 'acc_resin',
      label_ar: 'ملحق Resin',
      label_en: 'Resin accessory',
      fields: [t('capacity', 'السعة', 'Capacity', 'text', { unit: 'L' })],
    },
  },
};

export const MATERIALS: TemplateFamilyDef = {
  id: 'materials',
  label_ar: 'المواد',
  label_en: 'Materials',
  common: {
    id: 'material_core',
    label_ar: 'مواصفات المادة',
    label_en: 'Material specifications',
    fields: [
      t('material_type', 'نوع المادة', 'Material type'),
      t('diameter', 'القطر', 'Diameter', 'text', { unit: 'mm' }),
      t('net_weight', 'الوزن الصافي', 'Net weight', 'text', { unit: 'g' }),
      t('color_name', 'اللون', 'Colour'),
      t('color_hex', 'كود اللون', 'Colour HEX', 'hex'),
      t('print_temp', 'حرارة الطباعة', 'Printing temperature', 'text', { unit: '°C' }),
      t('bed_temp', 'حرارة السرير', 'Bed temperature', 'text', { unit: '°C' }),
      t('compatibility', 'التوافق', 'Compatibility'),
      t('processing_mode', 'نمط المعالجة', 'Processing mode', 'select', {
        options: ['Laser Material', 'Blade Cutting Material', 'Not applicable'],
      }),
      t('dimensions', 'الأبعاد', 'Dimensions', 'text', { unit: 'mm' }),
      t('finish', 'الخامة / التشطيب', 'Finish'),
      t('quantity_per_pack', 'الكمية داخل العبوة', 'Quantity per pack', 'number'),
      t('operating_temp', 'حرارة التشغيل', 'Operating temperature', 'text', { unit: '°C' }),
      t('storage', 'شروط التخزين', 'Storage'),
      t('certifications', 'الشهادات', 'Certifications'),
      // Shared with devices ON PURPOSE: a filament box and a printer box both
      // have contents, and both templates should declare the field so imports
      // treat it as sheet-authoritative for either family.
      t('in_the_box', 'محتويات العلبة', 'In the box', 'multiline', {
        hint_ar: 'عنصر في كل سطر — تُعرض للزبون كنقاط',
      }),
    ],
  },
  sections: {
    'fdm-materials': {
      id: 'fdm_mat',
      label_ar: 'خاص بمواد FDM',
      label_en: 'FDM material specifics',
      fields: [
        t('spool_type', 'نوع البكرة', 'Spool type', 'select', { options: ['With spool', 'Refill', 'Cardboard'] }),
        t('drying', 'التجفيف', 'Drying'),
        t('tolerance', 'التفاوت', 'Tolerance', 'text', { unit: 'mm' }),
        t('density', 'الكثافة', 'Density', 'text', { unit: 'g/cm³' }),
      ],
    },
    'resin-materials': {
      id: 'resin_mat',
      label_ar: 'خاص بمواد Resin',
      label_en: 'Resin material specifics',
      fields: [
        t('volume', 'الحجم', 'Volume', 'text', { unit: 'ml' }),
        t('wavelength', 'الطول الموجي', 'Wavelength', 'text', { unit: 'nm' }),
        t('hardness', 'الصلابة', 'Hardness'),
        t('shelf_life', 'مدة الصلاحية', 'Shelf life', 'text', { unit: 'months' }),
      ],
    },
    'model-kits': {
      id: 'kits',
      label_ar: 'أطقم المجسمات',
      label_en: 'Model kits',
      fields: [
        t('pieces', 'عدد القطع', 'Pieces', 'number'),
        t('assembly_time', 'زمن التجميع', 'Assembly time'),
        t('age_rating', 'الفئة العمرية', 'Age rating'),
      ],
    },
    'cyberbrick-rc': {
      id: 'rc',
      label_ar: 'CyberBrick RC',
      label_en: 'CyberBrick RC',
      fields: [
        t('battery', 'البطارية', 'Battery'),
        t('control_range', 'مدى التحكم', 'Control range', 'text', { unit: 'm' }),
        t('channels', 'عدد القنوات', 'Channels', 'number'),
      ],
    },
    electronics: {
      id: 'electronics',
      label_ar: 'إلكترونيات',
      label_en: 'Electronics',
      fields: [
        t('voltage', 'الجهد', 'Voltage', 'text', { unit: 'V' }),
        t('current', 'التيار', 'Current', 'text', { unit: 'A' }),
        t('interface', 'الواجهة', 'Interface'),
      ],
    },
    'hardware-parts': {
      id: 'hardware',
      label_ar: 'قطع هاردوير',
      label_en: 'Hardware parts',
      fields: [
        t('thread', 'القلاووظ', 'Thread'),
        t('length', 'الطول', 'Length', 'text', { unit: 'mm' }),
        t('material', 'الخامة', 'Material'),
      ],
    },
    // The seeded «اكسسوارات» section (cat_accessories, materials family):
    // general accessories get their own detail group so an accessory product
    // is never asked filament questions.
    accessories: {
      id: 'acc_general',
      label_ar: 'بيانات الإكسسوار',
      label_en: 'Accessory details',
      fields: [
        t('fits_models', 'يناسب الموديلات', 'Fits models'),
        t('install_type', 'طريقة التركيب', 'Installation'),
        t('accessory_material', 'الخامة', 'Material'),
        t('use_case', 'الاستخدام', 'Use case'),
      ],
    },
  },
};

export const FAMILIES: Record<'devices' | 'materials', TemplateFamilyDef> = {
  devices: DEVICES,
  materials: MATERIALS,
};

export function isTemplateFamily(v: unknown): v is 'devices' | 'materials' {
  return v === 'devices' || v === 'materials';
}

/**
 * The groups a product in this family and section should show. An unknown
 * section contributes nothing extra rather than an empty or invented group.
 */
export function fieldsFor(family: 'devices' | 'materials', sectionSlugs: string[]): TemplateGroup[] {
  const def = FAMILIES[family];
  const out: TemplateGroup[] = [def.common];
  const seen = new Set<string>();
  for (const slug of sectionSlugs) {
    const g = def.sections[slug];
    if (g && !seen.has(g.id)) {
      seen.add(g.id);
      out.push(g);
    }
  }
  return out;
}

/** Flat field list, in render/column order. */
export function flatFields(groups: TemplateGroup[]): TemplateField[] {
  return groups.flatMap((g) => g.fields);
}
