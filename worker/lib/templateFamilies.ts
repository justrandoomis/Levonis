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
 * ON TOP OF THE FAMILIES SIT THE FOUR PRODUCT TYPES the owner works in —
 * طابعة / ملحقات / فلمنت / اكسسوار (see PRODUCT_TYPES at the bottom). A type
 * COMPOSES its groups from the family definitions, so there is still one
 * definition of «مواصفات الجهاز»; what a type adds is the decision about
 * which of those groups a human should be asked to fill in.
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
      /*
       * The camera's NUMBERS, separate from whether one exists. Two people ask
       * two different questions — "does it watch the print?" and "can I read a
       * failure from the timelapse?" — and a single Yes/No answered only the
       * first. Kept as free text because vendors quote it in incompatible
       * shapes (1080p, 1920x1080, 3 MP) and normalising them here would be
       * inventing a spec the box does not carry.
       */
      t('camera_resolution', 'دقة الكاميرا', 'Camera resolution', 'text', {
        hint_ar: 'مثال: 1080p أو 1920×1080',
      }),
      t('camera_fps', 'إطارات الكاميرا', 'Camera frame rate', 'number', { unit: 'fps' }),
      t('noise_level', 'مستوى الضجيج', 'Noise level', 'number', { unit: 'dB' }),
      t('slicer_software', 'برامج التقطيع المدعومة', 'Slicer software'),
      /* The phone/desktop app is a separate answer from the slicer: a machine
         can be driven by OrcaSlicer and still have no app of its own. */
      t('companion_app', 'التطبيق المرافق', 'Companion app', 'text', {
        hint_ar: 'تطبيق الهاتف أو سطح المكتب الخاص بالجهاز، إن وُجد',
      }),
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
        /*
         * The specs a buyer compares two machines by, and the reason this
         * group grew rather than a new system appearing: they are ordinary
         * spec rows, so they ride the existing spec_groups storage, the
         * existing template round-trip and the existing storefront table
         * without a single new column.
         */
        t('max_acceleration', 'أقصى تسارع', 'Maximum acceleration', 'number', { unit: 'mm/s²' }),
        /* PLURAL, and deliberately not the same field as `nozzle`: that one is
           the diameter SHIPPED, this is the set the machine accepts. */
        t('supported_nozzle_sizes', 'مقاسات النوزل المدعومة', 'Supported nozzle sizes', 'text', {
          unit: 'mm',
          hint_ar: 'مثال: 0.2 / 0.4 / 0.6 / 0.8',
        }),
        t('build_plate', 'سطح الطباعة', 'Build plate', 'text', {
          hint_ar: 'مثال: PEI مزدوج الوجه، قابل للإزالة',
        }),
        t('filament_sensor', 'حساس الفلامنت', 'Filament sensor', 'select', {
          options: ['Yes', 'No', 'Optional'],
        }),
        t('power_loss_recovery', 'الاستئناف بعد انقطاع الكهرباء', 'Power-loss recovery', 'select', {
          options: ['Yes', 'No'],
        }),
        t('input_shaping', 'Input shaping', 'Input shaping', 'select', {
          options: ['Yes', 'No'],
        }),
        /* AMS compatibility is not the same question as `multi_color`: a
           machine can print multi-colour by hand-swapping and still not take
           an AMS, and the buyer of an AMS needs the second answer. */
        t('ams_compatibility', 'التوافق مع AMS', 'AMS compatibility', 'text', {
          hint_ar: 'مثال: AMS / AMS lite / غير مدعوم',
        }),
        t('supported_filaments', 'الفلامنتات المدعومة', 'Supported filaments', 'text', {
          hint_ar: 'مثال: PLA, PETG, ABS, ASA, TPU, PA-CF',
        }),
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

// ------------------------------------------------------------ product types
//
// THE OWNER NAMES FOUR KINDS OF THING, and asked for the import/export
// template to follow them: «ويكون حسب نوع المنتج اذا طابعه او ملحقات او فلمنت
// او اكسسوار». The two families above are the storage-level split (a section
// carries `template_family`); a PRODUCT TYPE is the split a human uses when
// they sit down to type a product in.
//
// A type composes its spec groups from the family definitions rather than
// re-declaring them, so a field added to «مواصفات الجهاز» reaches the printer
// template with no second edit. Fields are DEDUPED BY ID across the composed
// groups — the same id twice would mean the same CSV column twice, and the
// second one would silently win on import.
//
// The point of the split is what it LEAVES OUT. A screw is not asked for a
// nozzle temperature and a filament spool is not asked for a build volume,
// which is the precision the owner asked for («لجعل هناك دقه باضافه
// المعلومات»). Nothing is destroyed by the narrowing: a value a product
// stored under a field its type does not declare is preserved on import
// (worker/lib/importApply.ts merges spec fields, it never replaces them).

export type ProductTypeId = 'printer' | 'parts' | 'filament' | 'accessory';

export interface ProductTypeDef {
  id: ProductTypeId;
  label_ar: string;
  label_en: string;
  /** The family a product of this type is filed under. */
  family: 'devices' | 'materials';
  /** One line explaining what belongs here, shown in the import panel. */
  hint_ar: string;
  /** Section slugs that mean "this type" when a template is picked by section. */
  sectionSlugs: string[];
  groups: TemplateGroup[];
}

/** What any physical, boxed thing has — the shared core of the two
 *  non-machine types, so a bracket or a tool is asked ten sensible questions
 *  instead of the thirty a printer or a filament spool needs. */
const PHYSICAL_CORE: TemplateGroup = {
  id: 'physical_core',
  label_ar: 'بيانات المنتج',
  label_en: 'Product details',
  fields: [
    t('material', 'الخامة', 'Material'),
    t('color_name', 'اللون', 'Colour'),
    t('color_hex', 'كود اللون', 'Colour HEX', 'hex'),
    t('dimensions', 'الأبعاد', 'Dimensions', 'text', { unit: 'mm' }),
    t('weight', 'الوزن', 'Weight', 'text', { unit: 'kg' }),
    t('quantity_per_pack', 'الكمية داخل العبوة', 'Quantity per pack', 'number'),
    t('compatibility', 'التوافق', 'Compatibility'),
    t('certifications', 'الشهادات', 'Certifications'),
    t('storage', 'شروط التخزين', 'Storage'),
    t('warranty', 'الضمان', 'Warranty', 'text', { unit: 'months' }),
    t('in_the_box', 'محتويات العلبة', 'In the box', 'multiline', {
      hint_ar: 'عنصر في كل سطر — تُعرض للزبون كنقاط',
    }),
  ],
};

const g = (family: TemplateFamilyDef, slug: string): TemplateGroup[] => {
  const found = family.sections[slug];
  return found ? [found] : [];
};

export const PRODUCT_TYPES: ProductTypeDef[] = [
  {
    id: 'printer',
    label_ar: 'طابعة',
    label_en: 'Printer',
    family: 'devices',
    hint_ar: 'الطابعات ثلاثية الأبعاد بكل أنواعها — FDM و Resin.',
    sectionSlugs: ['fdm-printers', 'resin-printers', 'printers'],
    groups: [DEVICES.common, ...g(DEVICES, 'fdm-printers'), ...g(DEVICES, 'resin-printers')],
  },
  {
    id: 'parts',
    label_ar: 'ملحقات وقطع',
    label_en: 'Parts & printer accessories',
    family: 'devices',
    hint_ar: 'ما يُركّب على الطابعة أو يُبدَّل فيها: نوزلات، شاشات، ألواح، إلكترونيات، قطع هاردوير.',
    sectionSlugs: [
      'printer-accessories',
      'resin-printer-accessories',
      'electronics',
      'hardware-parts',
      'parts',
    ],
    groups: [
      ...g(DEVICES, 'printer-accessories'),
      ...g(DEVICES, 'resin-printer-accessories'),
      ...g(MATERIALS, 'electronics'),
      ...g(MATERIALS, 'hardware-parts'),
      PHYSICAL_CORE,
    ],
  },
  {
    id: 'filament',
    label_ar: 'فلمنت ومواد',
    label_en: 'Filament & materials',
    family: 'materials',
    hint_ar: 'كل ما يُطبع به أو يُستهلك: فلمنت، راتنج، مواد ليزر وقص.',
    sectionSlugs: ['fdm-materials', 'resin-materials', 'materials', 'filament'],
    groups: [MATERIALS.common, ...g(MATERIALS, 'fdm-materials'), ...g(MATERIALS, 'resin-materials')],
  },
  {
    id: 'accessory',
    label_ar: 'اكسسوار',
    label_en: 'Accessory',
    family: 'materials',
    hint_ar: 'ما يُباع بجانب الطابعة ولا يُركَّب فيها: أدوات، حوامل، أطقم مجسمات، CyberBrick.',
    sectionSlugs: ['accessories', 'model-kits', 'cyberbrick-rc'],
    groups: [
      ...g(MATERIALS, 'accessories'),
      ...g(MATERIALS, 'model-kits'),
      ...g(MATERIALS, 'cyberbrick-rc'),
      PHYSICAL_CORE,
    ],
  },
];

const TYPE_BY_ID = new Map(PRODUCT_TYPES.map((p) => [p.id, p]));
const TYPE_BY_SLUG = new Map<string, ProductTypeDef>();
for (const p of PRODUCT_TYPES) for (const slug of p.sectionSlugs) TYPE_BY_SLUG.set(slug, p);

export function isProductType(v: unknown): v is ProductTypeId {
  return typeof v === 'string' && TYPE_BY_ID.has(v as ProductTypeId);
}

export const productType = (id: ProductTypeId): ProductTypeDef => TYPE_BY_ID.get(id)!;

/**
 * The type a section belongs to. The branch is walked leaf-first — the same
 * order `branchSlugs` produces — so «ملحقات طابعات Resin» resolves to parts
 * even though its parent «الطابعات» would say printer. A section nobody
 * mapped falls back to its family's headline type, which is an honest guess
 * rather than an empty template.
 */
export function productTypeForSection(
  family: 'devices' | 'materials',
  sectionSlugs: string[]
): ProductTypeId {
  for (const slug of sectionSlugs) {
    const found = TYPE_BY_SLUG.get(slug);
    if (found) return found.id;
  }
  return family === 'devices' ? 'printer' : 'filament';
}

/** The groups of one product type, deduped by FIELD id (not group id): two
 *  composed groups may legitimately declare the same field, and a repeated
 *  field would become a repeated column. The first group to claim a field
 *  keeps it, so the more specific group (listed first) wins over the core. */
export function groupsForType(id: ProductTypeId): TemplateGroup[] {
  const seen = new Set<string>();
  const out: TemplateGroup[] = [];
  for (const group of productType(id).groups) {
    const fields = group.fields.filter((f) => !seen.has(f.id));
    for (const f of fields) seen.add(f.id);
    if (fields.length) out.push({ ...group, fields });
  }
  return out;
}

/**
 * The groups a product in this family and section should show — the SAME
 * groups its import template carries, because both go through the product
 * type. The admin form (worker/routes/adminTaxonomy.ts) and the CSV columns
 * (worker/lib/importCsv.ts) therefore cannot drift: a field is in both places
 * or in neither.
 */
export function fieldsFor(family: 'devices' | 'materials', sectionSlugs: string[]): TemplateGroup[] {
  return groupsForType(productTypeForSection(family, sectionSlugs));
}

/** Flat field list, in render/column order. */
export function flatFields(groups: TemplateGroup[]): TemplateField[] {
  return groups.flatMap((g) => g.fields);
}

/**
 * THE SPEC FIELDS, AS THE CUSTOMER SEES THEM.
 *
 * Everything above is admin-side: it decides which inputs the form renders and
 * which columns the import sheet carries. But a spec nobody can read is not a
 * spec, and the storefront only ever knew how to render `spec_groups` — the
 * free-form table an admin types by hand — so a printer could have its maximum
 * acceleration, its supported nozzle sizes and its AMS compatibility filled in
 * and show the customer none of them.
 *
 * This turns the stored `spec_fields` map into exactly that same
 * `spec_groups` shape, using the family definition for the labels, the unit
 * and the ORDER. No new storage, no new renderer, no second vocabulary — the
 * product page's existing specifications table simply receives more groups.
 *
 * Both families are searched rather than the product's own, because a field
 * keeps its value when a product moves between sections (see importApply's
 * spec-merge rule) and a label is better than a bare key either way. A field
 * the definitions no longer contain is skipped: it is a leftover, and showing
 * a raw id like `max_flow_rate` to a customer is worse than showing nothing.
 *
 * `exclude` is for values the page already renders its own way — `in_the_box`
 * is a bullet list under the gallery, and repeating it as a table row would
 * show the same text twice.
 */
export interface DerivedSpecRow {
  id: string;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  value_ar: string;
  value_en: string;
  value_ckb: string;
  unit: string;
  order: number;
}

export interface DerivedSpecGroup {
  id: string;
  title_ar: string;
  title_en: string;
  title_ckb: string;
  order: number;
  rows: DerivedSpecRow[];
}

/** Every group of both families, in definition order, deduplicated by id. */
const ALL_GROUPS: TemplateGroup[] = (() => {
  const seen = new Set<string>();
  const out: TemplateGroup[] = [];
  for (const fam of [DEVICES, MATERIALS]) {
    for (const g of [fam.common, ...Object.values(fam.sections)]) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(g);
    }
  }
  return out;
})();

export function specGroupsFromFields(
  values: Record<string, string> | null | undefined,
  exclude: readonly string[] = ['in_the_box']
): DerivedSpecGroup[] {
  if (!values) return [];
  const skip = new Set(exclude);
  const groups: DerivedSpecGroup[] = [];
  const used = new Set<string>();

  for (const g of ALL_GROUPS) {
    const rows: DerivedSpecRow[] = [];
    for (const f of g.fields) {
      // A field id can legitimately appear in two groups of two families; the
      // first group that claims it wins, so the value is never shown twice.
      if (skip.has(f.id) || used.has(f.id)) continue;
      const raw = values[f.id];
      if (raw === undefined || String(raw).trim() === '') continue;
      used.add(f.id);
      const value = String(raw).trim();
      rows.push({
        id: `sf_${f.id}`,
        label_ar: f.label_ar,
        label_en: f.label_en,
        // Values are entered in English only (§3) and the labels have no
        // Kurdish in the definition, so the English label stands in rather
        // than a translation nobody wrote.
        label_ckb: f.label_en,
        value_ar: value,
        value_en: value,
        value_ckb: value,
        unit: f.unit ?? '',
        order: rows.length,
      });
    }
    if (rows.length === 0) continue;
    groups.push({
      id: `sg_${g.id}`,
      title_ar: g.label_ar,
      title_en: g.label_en,
      title_ckb: g.label_en,
      order: groups.length,
      rows,
    });
  }
  return groups;
}
