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

/**
 * HOW TO READ A SPEC, AND WHICH WAY IS BETTER — the annotation the comparison
 * (worker/lib/compareSpecs.ts) reads. It lives on the field for the reason
 * stated at the top of this file: a spec added to the form must not be able to
 * mean one thing here and another thing in a comparison table.
 *
 * THE DEFAULT IS ABSENCE. A field with no `compare` is shown and never scored,
 * which is the honest state for a spec nobody has judged yet.
 *
 * THE THREE JUDGEMENTS THAT KEEP RECURRING, recorded once here rather than on
 * thirty fields:
 *   - `weight` and `dimensions` are NOT virtues on a machine. A heavier printer
 *     is not a better one and a smaller one is not a worse one; both are shown
 *     because they decide whether it fits on the desk, and neither is scored.
 *   - `power` is consumption. 350 W does not beat 150 W; it is a number on the
 *     electricity bill, not a capability.
 *   - Two fields that look alike point opposite ways: a LAYER height is finer
 *     as it FALLS and a screen RESOLUTION is finer as it RISES. They are
 *     annotated one at a time, never by the shape of their name.
 */
export interface SpecCompare {
  /** How to read the stored string as something comparable. */
  parse: 'number' | 'dimensions' | 'boolean' | 'list' | 'range' | 'text';
  /** Which direction wins. 'none' = shown, never scored. */
  better: 'higher' | 'lower' | 'yes' | 'none';
  /** Relative weight in the headline verdict. Omitted or 0 = not scored. */
  weight?: number;
}

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
  /** How a comparison reads and ranks this field. Absent = shown, unscored. */
  compare?: SpecCompare;
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
      t('release_year', 'سنة الإصدار', 'Release year', 'number', {
        compare: { parse: 'number', better: 'higher', weight: 1 }, hint_ar: 'مثال: 2024',
      }),
      t('skill_level', 'مستوى الخبرة المطلوب', 'Required skill level', 'select', {
        options: ['Beginner', 'Intermediate', 'Advanced', 'Professional'], compare: { parse: 'text', better: 'none' }, hint_ar: 'لمن صُممت الطابعة — مثال: Beginner',
      }),
      t('build_volume', 'حجم الطباعة', 'Build volume', 'text', {
        unit: 'mm',
        hint_ar: 'مثال: 256 x 256 x 256',
        /* Ranked on the VOLUME and displayed as the three axes. A buyer with a
           tall part is asking about Z, and «16.7 لتر» answers a question
           nobody asked — so the comparison keeps both readings. */
        compare: { parse: 'dimensions', better: 'higher', weight: 3 },
      }),
      /* Scored, but under `max_flow_rate`: the quoted maximum speed is a
         TRAVEL number and the flow rate is what the hotend can actually melt,
         which is the one that decides how long the print really takes. */
      t('print_speed', 'السرعة', 'Print speed', 'number', {
        unit: 'mm/s',
        compare: { parse: 'number', better: 'higher', weight: 2 },
      }),
      /* NOT SCORED, and the field most likely to tempt someone into scoring
         it. «الدقة» carries no unit and vendors fill it with a layer height
         (0.05-0.35 mm), an XY step (50 µm) or a positioning tolerance — three
         quantities, two of which get BETTER as the number falls. One direction
         would be wrong for somebody. The resin group asks the same question in
         units (`xy_resolution`, `layer_height_range`) and those are scored. */
      t('resolution', 'الدقة', 'Resolution', 'text', { compare: { parse: 'text', better: 'none' } }),
      /* Read as a number, ranked in neither direction: 0.8 prints faster and
         0.2 prints finer, and which of those a buyer wants is not ours to
         decide. */
      t('nozzle', 'القطر / النوزل', 'Nozzle diameter', 'text', {
        unit: 'mm',
        compare: { parse: 'number', better: 'none' },
      }),
      /* Scored on the COUNT and at the lowest weight the scale has: a longer
         list is a more versatile machine, but it is not automatically a better
         one, and the items themselves are what the reader actually compares. */
      t('supported_materials', 'الأنظمة والمواد المتوافقة', 'Supported materials', 'text', {
        compare: { parse: 'list', better: 'higher', weight: 1 },
      }),
      t('power', 'الطاقة', 'Power', 'text', { unit: 'W', compare: { parse: 'number', better: 'none' } }),
      t('dimensions', 'الأبعاد', 'Dimensions', 'text', { unit: 'mm', compare: { parse: 'dimensions', better: 'none' } }),
      t('weight', 'الوزن', 'Weight', 'text', { unit: 'kg', compare: { parse: 'number', better: 'none' } }),
      /* A list, and deliberately an unscored one: «Wi-Fi 2.4/5G» is one radio
         written as two items, so a count here would be scoring punctuation. */
      t('connectivity', 'الاتصال', 'Connectivity', 'text', { compare: { parse: 'list', better: 'none' } }),
      t('compatibility', 'التوافق', 'Compatibility'),
      t('display', 'الشاشة', 'Display'),
      t('camera', 'الكاميرا', 'Camera', 'select', {
        options: ['Yes', 'No', 'Optional'],
        compare: { parse: 'boolean', better: 'yes', weight: 1 },
      }),
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
        /* Read so it can be DISPLAYED tidily, never ranked — for exactly the
           reason stated above. «1080p» is a count of lines, «1920x1080» a count
           of pixels and «3 MP» a third scale; ranking them would rank a
           notation, not a camera. */
        compare: { parse: 'dimensions', better: 'none' },
      }),
      t('camera_fps', 'إطارات الكاميرا', 'Camera frame rate', 'number', {
        unit: 'fps',
        compare: { parse: 'number', better: 'higher', weight: 1 },
      }),
      /* THE ONE FIELD ON A PRINTER WHERE THE SMALLER NUMBER WINS, and it sits
         between two where the bigger one does. 48 dB beats 58 dB, and a machine
         that lives in a bedroom is bought on this row. */
      t('noise_level', 'مستوى الضجيج', 'Noise level', 'number', {
        unit: 'dB',
        compare: { parse: 'number', better: 'lower', weight: 2 },
      }),
      t('slicer_software', 'برامج التقطيع المدعومة', 'Slicer software', 'text', {
        compare: { parse: 'list', better: 'higher', weight: 1 },
      }),
      /* The phone/desktop app is a separate answer from the slicer: a machine
         can be driven by OrcaSlicer and still have no app of its own. */
      t('companion_app', 'التطبيق المرافق', 'Companion app', 'text', {
        hint_ar: 'تطبيق الهاتف أو سطح المكتب الخاص بالجهاز، إن وُجد',
      }),
      t('assembly', 'الحالة عند التسليم', 'Assembly', 'select', {
        options: ['Pre-assembled', 'Partially assembled', 'Kit'],
        /* NOT SCORABLE. A kit is cheaper and a whole kind of buyer comes for
           one; ranking «Pre-assembled» above it would tell that buyer their
           choice is the worse machine. */
        compare: { parse: 'text', better: 'none' },
      }),
      t('warranty', 'الضمان', 'Warranty', 'text', { unit: 'months', compare: { parse: 'number', better: 'higher', weight: 2 } }),
      t('in_the_box', 'محتويات العلبة', 'In the box', 'multiline', {
        compare: { parse: 'list', better: 'none' },
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
        /* Both heat ceilings are scored upward and for the same reason: they
           are what decides WHICH MATERIALS the machine can print at all. */
        t('nozzle_temp_max', 'أقصى حرارة نوزل', 'Max nozzle temperature', 'number', {
          unit: '°C',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        t('bed_temp_max', 'أقصى حرارة سرير', 'Max bed temperature', 'number', {
          unit: '°C',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        /* FDM ONLY, AND THE LARGEST SINGLE LOAD IN THE MACHINE. A 220×220 bed
           is 200–250 W and a 350×350 one can pass 600 W, which is most of what
           the UPS has to carry and the reason the draw is not steady: the bed
           switches on and off for the whole print. A resin printer has no
           heated bed — its equivalent is `uv_power`, already asked for in the
           resin group — so this field is declared here rather than in the
           shared «الكهرباء والبيئة» group, where it could only ever be blank on
           half the catalogue. Unscored, like every other consumption figure. */
        t('heated_bed_power', 'قدرة السرير الساخن', 'Heated bed power', 'number', {
          unit: 'W', compare: { parse: 'number', better: 'none' },
          hint_ar: 'قدرة سخان السرير وحده — مثال: 250',
        }),
        t('extruders', 'عدد الباثقات', 'Extruders', 'number', {
          compare: { parse: 'number', better: 'higher', weight: 1 },
        }),
        t('enclosed', 'هيكل مغلق', 'Enclosed', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
        t('auto_leveling', 'التسوية التلقائية', 'Auto leveling', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
        /* Free text by declaration, and filled with everything from «No» to
           «AMS lite (4 colours)». A yes/no reading of it would be scoring a
           sentence, so it is shown and left alone. */
        t('multi_color', 'دعم تعدد الألوان', 'Multi-colour support', 'text', {
          compare: { parse: 'text', better: 'none' },
        }),
        /* An architecture, not a magnitude. CoreXY against bed-slinger is a
           trade-off that `print_speed` and `max_acceleration` already express
           as numbers; saying it twice, once as a verdict, would double-count
           it. */
        t('motion_system', 'نظام الحركة', 'Motion system', 'text', {
          hint_ar: 'مثال: CoreXY أو Bed slinger',
          compare: { parse: 'text', better: 'none' },
        }),
        /* A standard (1.75 / 2.85), not a virtue. */
        t('filament_diameter', 'قطر الفلامنت', 'Filament diameter', 'text', {
          unit: 'mm',
          compare: { parse: 'number', better: 'none' },
        }),
        /* THE HONEST SPEED FIGURE, and weighted above the quoted mm/s for it:
           a hotend that melts 32 mm³/s finishes a real print sooner than one
           whose box says 600 mm/s and melts 12. */
        t('max_flow_rate', 'أقصى معدل تدفق', 'Max flow rate', 'number', {
          unit: 'mm³/s',
          compare: { parse: 'number', better: 'higher', weight: 3 },
        }),
        /*
         * The specs a buyer compares two machines by, and the reason this
         * group grew rather than a new system appearing: they are ordinary
         * spec rows, so they ride the existing spec_groups storage, the
         * existing template round-trip and the existing storefront table
         * without a single new column.
         */
        t('max_acceleration', 'أقصى تسارع', 'Maximum acceleration', 'number', {
          unit: 'mm/s²',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        /* PLURAL, and deliberately not the same field as `nozzle`: that one is
           the diameter SHIPPED, this is the set the machine accepts. */
        t('supported_nozzle_sizes', 'مقاسات النوزل المدعومة', 'Supported nozzle sizes', 'text', {
          unit: 'mm',
          hint_ar: 'مثال: 0.2 / 0.4 / 0.6 / 0.8',
          compare: { parse: 'list', better: 'higher', weight: 1 },
        }),
        t('build_plate', 'سطح الطباعة', 'Build plate', 'text', {
          hint_ar: 'مثال: PEI مزدوج الوجه، قابل للإزالة',
        }),
        /* «Optional» is a real third answer here, and the comparison treats it
           as one: it does not beat a «Yes» and it is not recorded as a loss
           against one — the part can simply be bought. */
        t('filament_sensor', 'حساس الفلامنت', 'Filament sensor', 'select', {
          options: ['Yes', 'No', 'Optional'],
          compare: { parse: 'boolean', better: 'yes', weight: 1 },
        }),
        t('power_loss_recovery', 'الاستئناف بعد انقطاع الكهرباء', 'Power-loss recovery', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 1 },
        }),
        t('input_shaping', 'Input shaping', 'Input shaping', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
        /* AMS compatibility is not the same question as `multi_color`: a
           machine can print multi-colour by hand-swapping and still not take
           an AMS, and the buyer of an AMS needs the second answer. */
        t('ams_compatibility', 'التوافق مع AMS', 'AMS compatibility', 'text', {
          hint_ar: 'مثال: AMS / AMS lite / غير مدعوم',
        }),
        t('chamber_temp_max', 'أقصى حرارة الغرفة', 'Max chamber temperature', 'number', {
          unit: '°C', compare: { parse: 'number', better: 'higher', weight: 2 }, hint_ar: 'للغرفة المُسخّنة فعليًا فقط — مثال: 60. اتركه فارغًا إذا الهيكل مغلق بلا تسخين',
        }),
        t('max_colors', 'أقصى عدد ألوان', 'Maximum colours', 'number', {
          compare: { parse: 'number', better: 'higher', weight: 1 }, hint_ar: 'أقصى عدد ألوان في طبعة واحدة — مثال: 16',
        }),
        t('thermal_runaway_protection', 'الحماية من الانفلات الحراري', 'Thermal runaway protection', 'select', {
          options: ['Yes', 'No'], compare: { parse: 'boolean', better: 'yes', weight: 2 }, hint_ar: 'مثال: Yes',
        }),
        t('supported_filaments', 'الفلامنتات المدعومة', 'Supported filaments', 'text', {
          hint_ar: 'مثال: PLA, PETG, ABS, ASA, TPU, PA-CF',
          compare: { parse: 'list', better: 'higher', weight: 1 },
        }),
      ],
    },
    'resin-printers': {
      id: 'resin',
      label_ar: 'خاص بطابعات Resin',
      label_en: 'Resin specifics',
      fields: [
        /* Panel size is not a quality on its own: the SAME panel size at a
           lower pixel count prints coarser. The two questions it gets confused
           with are asked properly by `build_volume` and `xy_resolution`. */
        t('lcd_size', 'مقاس الشاشة', 'LCD size', 'text', {
          unit: 'in',
          compare: { parse: 'number', better: 'none' },
        }),
        /* HIGHER WINS — and it sits two lines above a field where lower wins,
           which is the whole reason these are annotated one at a time. More
           pixels across the same panel is a finer print. «4K» is left unread
           rather than expanded to 3840: shown, not scored. */
        t('lcd_resolution', 'دقة الشاشة', 'LCD resolution', 'text', {
          compare: { parse: 'dimensions', better: 'higher', weight: 2 },
        }),
        /* LOWER WINS. This is the micron a single pixel covers, so a smaller
           number is a finer feature — the opposite direction to the row above
           it, from a field whose name reads almost the same. */
        t('xy_resolution', 'دقة XY', 'XY resolution', 'text', {
          unit: 'µm',
          compare: { parse: 'number', better: 'lower', weight: 2 },
        }),
        /* A range, ranked on the FINEST end it reaches — which is the minimum,
           hence 'lower'. */
        t('layer_height_range', 'مدى ارتفاع الطبقة', 'Layer height range', 'text', {
          unit: 'mm',
          compare: { parse: 'range', better: 'lower', weight: 1 },
        }),
        t('light_source', 'مصدر الضوء', 'Light source'),
        /* Not the machine's number alone: exposure is a property of the RESIN
           and the layer as much as the light, so a lower figure quoted against
           a different resin is not a faster printer. */
        t('exposure_time', 'زمن التعريض', 'Exposure time', 'text', {
          unit: 's',
          compare: { parse: 'range', better: 'none' },
        }),
        /* Watts say nothing about uniformity or wavelength match, and two
           panels of equal wattage cure at different speeds. */
        t('uv_power', 'قدرة الضوء UV', 'UV power', 'text', {
          unit: 'W',
          compare: { parse: 'number', better: 'none' },
        }),
        t('lcd_type', 'نوع الشاشة', 'Screen type', 'select', {
          options: ['Monochrome LCD', 'Colour LCD', 'DLP (DMD)', 'LCD (unspecified)'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Monochrome LCD — مكتوب بجانب مقاس الشاشة',
        }),
        t('lcd_lifespan', 'عمر الشاشة الافتراضي', 'Screen rated life', 'number', {
          unit: 'h', compare: { parse: 'number', better: 'higher', weight: 1 }, hint_ar: 'اكتب الرقم فقط — مثال: 2000',
        }),
        t('release_film', 'فيلم الفصل', 'Release film'),
      ],
    },
    /*
     * THE PRINTER SECTIONS ARE SUB-GROUPED, AND THE GROUPS ARE THE POINT.
     *
     * «خاص بطابعات FDM» was one flat list of seventeen fields, and the owner
     * asked for the template to grow «لكي يتم وضعها في تفاصيل المنتج» while
     * staying «كمميزات بنقاط مرتبة كما هو حاليا» — ordered points, not a wall.
     * Thirty more fields in one group would have produced exactly the wall.
     *
     * Splitting costs a sparsely-filled product NOTHING, which is what makes
     * it safe: `specGroupsFromFields` skips a field with no value and DROPS a
     * group that ends up with no rows, so a machine whose admin filled twelve
     * fields still shows twelve lines under however many headings apply.
     *
     * Each sub-group is owned by its technology leaf in AXES, so choosing
     * Resin still removes every FDM group at once — the narrowing means what
     * it always meant.
     */
    'device-environment': {
      id: 'device_env',
      label_ar: 'الكهرباء والبيئة',
      label_en: 'Power & environment',
      fields: [
        t('input_voltage', 'جهد الدخل', 'Input voltage', 'text', {
          unit: 'V', compare: { parse: 'range', better: 'none' }, hint_ar: 'مثال: 100-240 أو 220 فقط',
        }),
        /*
         * THE MAINS QUESTION, AND WHY IT IS ASKED OF EVERY MACHINE.
         *
         * «كم تستهلك الطابعة من كهرباء في العراق على 220 فولت … بالأمبيرية وكم
         * تحتاج من الـ UPS». Iraq runs 220–230 V at 50 Hz and the grid fails
         * daily; a buyer here is sizing a UPS before he has unboxed the
         * printer. worker/lib/powerAdvice.ts turns these numbers into amps, a
         * UPS rating in VA and a runtime range — but it can only do that from
         * figures a human entered, so this group is where they are asked for.
         *
         * THEY LIVE IN «الكهرباء والبيئة», WHICH IS SHARED BY FDM AND RESIN,
         * because the mains question is the same question for both: every
         * machine has a nameplate, an average draw and an idle draw, and the
         * UPS arithmetic is identical. What differs is WHERE the watts go, and
         * that difference is asked one group down — the FDM template asks for
         * the heated bed (its largest and most duty-cycled load) and the resin
         * template already asks for `uv_power`, which is the resin equivalent.
         * A resin printer has no heated bed, so asking it for one would put a
         * column on the sheet that can only ever be blank.
         *
         * NOT ONE VALUE IS INVENTED HERE. These are FIELDS; the numbers come
         * from the owner's data entry and from the import sheet. An empty field
         * reads as unknown and powerAdvice returns `known: false` — a printer
         * reported as drawing 0 W would size a UPS at nothing, which is the
         * single defect that whole module is written to prevent.
         *
         * NONE OF THEM IS SCORED, and that is the file's own standing rule
         * stated at the top: `power` is consumption, not a capability. 350 W
         * does not beat 150 W — it is a line on the electricity bill and a
         * bigger UPS, and a machine that draws more because it prints hotter
         * and faster must not be marked down for it.
         */
        t('rated_power', 'القدرة القصوى', 'Rated power', 'number', {
          unit: 'W', compare: { parse: 'number', better: 'none' },
          hint_ar: 'الرقم المكتوب على لوحة الجهاز أو في المواصفات — مثال: 350. هذا الذي يُحسب عليه حجم الـ UPS',
        }),
        /* The average over a real print, which is far below the nameplate: the
           bed and the hotend hold temperature rather than heating flat out.
           Kept SEPARATE from the rated figure because the two answer different
           questions — the rated watts size the UPS, this one decides how long
           it holds. */
        t('typical_print_power', 'القدرة أثناء الطباعة', 'Typical printing power', 'number', {
          unit: 'W', compare: { parse: 'number', better: 'none' },
          hint_ar: 'معدل السحب أثناء طبعة اعتيادية — مثال: 120',
        }),
        /* What the machine pulls doing nothing. In a country where the mains
           come and go, the idle draw is what a UPS carries between prints. */
        t('standby_power', 'قدرة وضع الانتظار', 'Standby power', 'number', {
          unit: 'W', compare: { parse: 'number', better: 'none' },
          hint_ar: 'السحب والجهاز واكف بلا طباعة — مثال: 12',
        }),
        /* Iraq is 50 Hz. A unit that accepts only 60 Hz is a real problem here,
           and the answer belongs beside the voltage rather than buried in the
           free-text «الطاقة» box. A range, because «50/60» is how it is quoted. */
        t('input_frequency', 'تردد الكهرباء', 'Mains frequency', 'text', {
          unit: 'Hz', compare: { parse: 'range', better: 'none' },
          hint_ar: 'مثال: 50/60 — كهرباء العراق 50 هرتز',
        }),
        /* THE NUMBER THAT TURNS WATTS INTO AMPS: P = V × I × PF. Without it
           powerAdvice assumes 0.9 and SAYS it assumed it; with it the amps are
           the machine's own. Unscored deliberately — a higher power factor does
           mean a smaller UPS, but two printers in twenty publish the figure at
           all, and a verdict drawn from a field that is nearly always blank is
           a verdict about our data entry. */
        t('power_factor', 'معامل القدرة', 'Power factor', 'number', {
          compare: { parse: 'number', better: 'none' },
          hint_ar: 'بين 0 و1، إذا ذكرته الشركة — مثال: 0.95. اتركه فارغاً إذا غير مذكور',
        }),
        t('air_filtration', 'تنقية الهواء', 'Air filtration', 'select', {
          options: ['None', 'Activated carbon', 'HEPA', 'HEPA + activated carbon', 'External exhaust port', 'Optional add-on'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Activated carbon — أو None إذا لا يوجد فلتر',
        }),
        t('ambient_temp_range', 'حرارة الغرفة المناسبة', 'Ambient operating temperature', 'text', {
          unit: '°C', compare: { parse: 'range', better: 'none' }, hint_ar: 'حرارة الغرفة التي يعمل بها الجهاز — مثال: 15-30',
        }),
      ],
    },
    'fdm-extrusion': {
      id: 'fdm_extrusion',
      label_ar: 'الإكسترودر والهوت إند',
      label_en: 'Extruder & hotend',
      fields: [
        t('extruder_drive', 'نظام الإكسترودر', 'Extruder drive type', 'select', {
          options: ['Direct drive', 'Bowden'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Direct drive — مذكور في صفحة مواصفات الشركة',
        }),
        t('hotend_type', 'تركيب الهوت إند', 'Hotend construction', 'select', {
          options: ['All-metal', 'PTFE-lined', 'Bi-metal heat break'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: All-metal — يعني تشغيل مستمر فوق 260°C بأمان',
        }),
        t('nozzle_material', 'خامة النوزل', 'Nozzle material', 'select', {
          options: ['Brass', 'Hardened steel', 'Stainless steel', 'Tungsten carbide', 'Coated / other'], compare: { parse: 'text', better: 'none' }, hint_ar: 'الخامة المرفقة مع الجهاز — مثال: Hardened steel',
        }),
        t('auxiliary_part_cooling', 'مروحة تبريد إضافية', 'Auxiliary part cooling', 'select', {
          options: ['Yes', 'No', 'Optional'], compare: { parse: 'boolean', better: 'yes', weight: 1 }, hint_ar: 'مروحة جانبية إضافية غير مروحة الرأس — مثال: Yes',
        }),
      ],
    },
    'fdm-motion': {
      id: 'fdm_motion',
      label_ar: 'الحركة والتسوية والدقة',
      label_en: 'Motion, levelling & accuracy',
      fields: [
        t('linear_guides', 'نظام التوجيه للمحاور', 'Axis guidance', 'select', {
          options: ['Linear rails (all axes)', 'Linear rails (X/Y only)', 'Linear rods + bearings', 'POM wheels on extrusion', 'Mixed / other'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Linear rails (X/Y only)',
        }),
        t('leveling_sensor', 'نوع حساس التسوية', 'Levelling sensor', 'select', {
          options: ['Strain gauge / load cell', 'Inductive probe', 'BLTouch / touch probe', 'Eddy current', 'Piezo', 'Manual (no probe)'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Strain gauge / load cell — أو Manual (no probe) إذا التسوية يدوية',
        }),
        t('min_layer_height', 'أقل ارتفاع طبقة', 'Minimum layer height', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'lower', weight: 1 }, hint_ar: 'أصغر رقم في سطر layer height — مثال: 0.05',
        }),
      ],
    },
    'fdm-control': {
      id: 'fdm_control',
      label_ar: 'التحكم والمراقبة',
      label_en: 'Control & monitoring',
      fields: [
        t('firmware', 'البرنامج الثابت', 'Firmware', 'select', {
          options: ['Klipper', 'Marlin', 'RepRapFirmware', 'Proprietary', 'Other'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Klipper',
        }),
        t('print_failure_detection', 'كشف فشل الطباعة', 'Print failure detection', 'select', {
          options: ['Yes', 'No', 'Optional'], compare: { parse: 'boolean', better: 'yes', weight: 1 }, hint_ar: 'كشف السباغيتي أو فحص الطبقة الأولى بالكاميرا — مثال: Yes',
        }),
      ],
    },
    'resin-motion': {
      id: 'resin_motion',
      label_ar: 'الحركة والتسوية',
      label_en: 'Motion & levelling',
      fields: [
        t('z_accuracy', 'دقة محور Z', 'Z-axis accuracy', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'lower', weight: 2 }, hint_ar: 'اكتب الرقم فقط — مثال: 0.01',
        }),
        t('max_print_speed_z', 'أقصى سرعة طباعة (عمودية)', 'Max vertical print speed', 'number', {
          unit: 'mm/h', compare: { parse: 'number', better: 'higher', weight: 2 }, hint_ar: 'سرعة الطابعة الراتنجية بالـ mm/h — مثال: 150 (لا تكتبها في حقل «السرعة»)',
        }),
        t('release_mechanism', 'آلية فصل الطبقة', 'Layer release mechanism', 'select', {
          options: ['Tilt release', 'Standard lift-and-peel', 'Rotary / roller release', 'Other'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Tilt release',
        }),
        t('leveling_type', 'تسوية منصة الطباعة', 'Build plate levelling', 'select', {
          options: ['Levelling-free', 'Manual 4-point', 'Manual 2-point', 'Auto levelling'], compare: { parse: 'text', better: 'none' }, hint_ar: 'مثال: Levelling-free',
        }),
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
      fields: [t('capacity', 'السعة', 'Capacity', 'text', {
        unit: 'L',
        compare: { parse: 'number', better: 'higher', weight: 1 },
      })],
    },
    /*
     * THE LASER IS A DEVICE, AND THAT IS THE WHOLE ARGUMENT FOR IT LIVING HERE.
     *
     * «إضافة قسم جديد وهو قسم الليزر بجانب طابعات الفلامنت والرزن». A cutter is
     * a machine on a desk with a nameplate, a warranty and a camera, so it is
     * filed in «الأجهزة» beside the printers rather than in a third family.
     * That is not tidiness: `ALL_GROUPS` at the bottom of this file walks the
     * literal [DEVICES, MATERIALS], so a group declared inside these two is
     * picked up by the product page's spec table and by the comparison for
     * free, and a group declared anywhere else would be invisible to both.
     *
     * WHAT IT DOES NOT DO is join the `printer-technology` axis. A leaf there
     * would pull these groups into the printer TYPE and put a wavelength and a
     * work area on every unnarrowed printer template — thirty fields wider for
     * a machine that has neither.
     */
    'laser-machines': {
      id: 'laser',
      label_ar: 'خاص بأجهزة الليزر',
      label_en: 'Laser specifics',
      fields: [
        /* THE FIRST QUESTION A LASER BUYER ASKS, and the one that decides what
           the machine can touch at all: a diode marks wood and cuts thin ply,
           a CO2 cuts acrylic, a fibre marks bare metal. Not scored — they are
           three different machines, not three grades of one. */
        t('laser_source', 'نوع مصدر الليزر', 'Laser source', 'select', {
          /* WHOLE PHRASES, NOT THE BARE WORDS. «Fiber» on its own reaches
             every «carbon fiber» in the shop and would have the dictionary
             answer «فايبر» where «ألياف الكربون» is the only right word; the
             file's own note beside «online» makes the same argument. */
          options: ['CO2 laser', 'Diode laser', 'Infrared laser', 'Fiber laser'],
          compare: { parse: 'text', better: 'none' },
        }),
        /* THE OPTICAL WATTS, AND NOT THE ONES ON THE ELECTRICITY BILL. This is
           the only power figure in the file that IS a capability, which is why
           it is scored while `power` in «مواصفات الجهاز» is not: 40 W cuts what
           20 W only scorches. Vendors also quote an input wattage next to it —
           that one belongs in `rated_power`. */
        t('laser_power', 'قدرة الليزر', 'Laser power', 'number', {
          unit: 'W',
          compare: { parse: 'number', better: 'higher', weight: 3 },
          hint_ar: 'القدرة البصرية للشعاع لا قدرة الجهاز من الكهرباء — مثال: 40',
        }),
        /* A SEPARATE ID FROM THE RESIN GROUP'S `wavelength` ON PURPOSE.
           `specGroupsFromFields` gives a field id to the FIRST group that
           claims it, and this file's devices are walked before its materials —
           so reusing `wavelength` here would drag every resin bottle's 405 nm
           out from under «خاص بمواد Resin» and file it under a laser heading. */
        t('laser_wavelength', 'الطول الموجي لليزر', 'Laser wavelength', 'number', {
          unit: 'nm',
          compare: { parse: 'number', better: 'none' },
          hint_ar: 'مثال: 455 للدايود، 10600 لليزر CO2',
        }),
        /* The laser's answer to `build_volume`, and ranked the same way: on the
           area, shown as the two axes a buyer measures their sheet against. */
        t('work_area', 'مساحة العمل', 'Work area', 'text', {
          unit: 'mm',
          hint_ar: 'مثال: 400 x 400',
          compare: { parse: 'dimensions', better: 'higher', weight: 3 },
        }),
        t('max_material_thickness', 'أقصى سماكة للمادة', 'Max material thickness', 'number', {
          unit: 'mm',
          compare: { parse: 'number', better: 'higher', weight: 2 },
          hint_ar: 'أقصى سماكة يقطعها الجهاز بمرّة واحدة — مثال: 10',
        }),
        /* TWO SPEEDS, NOT ONE, because they are not the same job: engraving
           sweeps the head over the surface and cutting drags the beam through
           the material at a fraction of it. A single «السرعة» row would let a
           vendor quote the flattering one. */
        t('engraving_speed', 'سرعة الحفر', 'Engraving speed', 'number', {
          unit: 'mm/s',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        t('cutting_speed', 'سرعة القص', 'Cutting speed', 'number', {
          unit: 'mm/s',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        /* LOWER WINS, and it sits two rows under two fields where the bigger
           number does — the same trap `xy_resolution` is annotated for. This is
           how far the head misses its target, so 0.01 beats 0.05. */
        t('positioning_accuracy', 'دقة التموضع', 'Positioning accuracy', 'number', {
          unit: 'mm',
          compare: { parse: 'number', better: 'lower', weight: 2 },
        }),
        /* Whether the machine finds the surface itself. «Optional» is a real
           third answer — the probe can be bought — and is treated as one. */
        t('auto_focus', 'التركيز التلقائي', 'Auto focus', 'select', {
          options: ['Yes', 'No', 'Optional'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
        /* Not a yes/no: «Optional» here means a separate purchase, and a buyer
           engraving tumblers needs to know which of the three it is. Unscored,
           because an included rotary does not make a worse cutter a better one. */
        t('rotary_axis', 'المحور الدوّار', 'Rotary axis', 'select', {
          options: ['Included', 'Optional', 'Not supported'],
          compare: { parse: 'text', better: 'none' },
        }),
      ],
    },
    /*
     * THE GROUP THAT IS NOT A SPEC SHEET BUT A WARNING LABEL.
     *
     * A 3D printer's worst day is a failed print. A laser's is a fire in a
     * closed room, and the difference between the two machines is entirely in
     * this group — which is why it is its own heading rather than four more
     * rows appended to the one above it.
     */
    'laser-safety': {
      id: 'laser_safety',
      label_ar: 'السلامة والحماية',
      label_en: 'Safety & protection',
      fields: [
        /* FREE TEXT, AND DELIBERATELY NOT A SELECT. The classes are an IEC
           scale (1, 1C, 2, 3R, 3B, 4) and every one of them would need an
           Arabic and a Sorani rendering nobody in this shop has written; the
           class is also quoted on the box in Latin exactly as it is typed here.
           Shown, never scored: a Class 4 machine is not a worse machine, it is
           an open-frame one, which `laser_enclosure` says properly. */
        t('laser_class', 'فئة أمان الليزر', 'Laser safety class', 'text', {
          hint_ar: 'كما هي مكتوبة على الجهاز — مثال: Class 1',
          compare: { parse: 'text', better: 'none' },
        }),
        /* A SEPARATE ID FROM THE FDM GROUP'S `enclosed`, for the reason given
           beside `laser_wavelength`: «خاص بطابعات FDM» is walked first, and a
           shared id would show a laser's enclosure under a printer's heading.
           It is also a different question — three answers, not two. */
        t('laser_enclosure', 'الهيكل', 'Enclosure', 'select', {
          options: ['Fully enclosed', 'Open frame', 'Open frame + optional enclosure'],
          compare: { parse: 'text', better: 'none' },
        }),
        t('fume_extraction', 'شفط الأدخنة', 'Fume extraction', 'select', {
          options: ['Built-in filter', 'Exhaust fan + duct', 'External filter unit', 'Optional add-on', 'None'],
          compare: { parse: 'text', better: 'none' },
          hint_ar: 'قص الأكريليك والخشب يطلع دخاناً — هذا الحقل يقرر أين يذهب',
        }),
        /* The four below ARE scored, and they are the only safety rows in the
           file that are. A machine that stops when the lid opens, sees a flame
           and notices it was knocked over is straightforwardly safer than one
           that does none of that — there is no buyer for whom the other answer
           is the right one. */
        t('emergency_stop', 'زر الإيقاف الطارئ', 'Emergency stop', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
        t('flame_detection', 'كشف اللهب', 'Flame detection', 'select', {
          options: ['Yes', 'No', 'Optional'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
        t('tilt_detection', 'كشف الإمالة', 'Tilt detection', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 1 },
        }),
        t('safety_interlock', 'قفل أمان الغطاء', 'Lid safety interlock', 'select', {
          options: ['Yes', 'No'],
          compare: { parse: 'boolean', better: 'yes', weight: 2 },
        }),
      ],
    },
    /*
     * A LENS IS A PART, AND NOTHING NEW IS INVENTED FOR IT.
     *
     * «مواد الصيانه والاكسسوارات ايضا». A replacement lens, a honeycomb bed and
     * a filter cartridge are what «ملحقات وقطع» already means, so they ride the
     * EXISTING `parts` type — this group is added to it exactly as `acc_resin`
     * is, and the seeded «ملحقات الليزر» section is added to its sectionSlugs.
     * A separate accessory type would have been a fifth name for a thing the
     * owner already has four names for.
     *
     * The kind of part is FREE TEXT with an Arabic hint, not a select, for the
     * same reason `laser_class` is: the alternative was eight option strings
     * needing an invented Sorani apiece, and the product's own name already
     * says «عدسة» or «خرطوشة فلتر».
     */
    'laser-accessories': {
      id: 'laser_acc',
      label_ar: 'ملحقات الليزر',
      label_en: 'Laser accessory',
      fields: [
        t('laser_part_kind', 'نوع ملحق الليزر', 'Laser accessory type', 'text', {
          hint_ar: 'مثال: عدسة، وحدة ليزر، فوهة هواء، لوح خلية النحل، محور دوّار، خرطوشة فلتر',
        }),
        /* A property of the lens, not a grade of it: a short focal length
           engraves finer detail and a long one reaches through thicker stock. */
        t('focal_length', 'البعد البؤري', 'Focal length', 'number', {
          unit: 'mm',
          compare: { parse: 'number', better: 'none' },
        }),
        t('filter_life', 'العمر الافتراضي للفلتر', 'Filter rated life', 'number', {
          unit: 'h',
          compare: { parse: 'number', better: 'higher', weight: 1 },
          hint_ar: 'ساعات التشغيل قبل تبديل الخرطوشة — اكتب الرقم فقط',
        }),
        t('rotary_max_diameter', 'أقصى قطر للمحور الدوّار', 'Rotary max diameter', 'number', {
          unit: 'mm',
          compare: { parse: 'number', better: 'higher', weight: 1 },
        }),
        t('work_surface_size', 'مقاس سطح العمل', 'Work surface size', 'text', {
          unit: 'mm',
          hint_ar: 'لألواح خلية النحل والمساند — مثال: 400 x 400',
          compare: { parse: 'dimensions', better: 'none' },
        }),
      ],
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
      /* 1.75 or 2.85 is a fitment, not a grade. */
      t('diameter', 'القطر', 'Diameter', 'text', { unit: 'mm', compare: { parse: 'number', better: 'none' } }),
      /* Here the weight IS a virtue — it is how much product is in the box —
         which is why the printer's own `weight` is annotated separately. */
      t('net_weight', 'الوزن الصافي', 'Net weight', 'text', {
        unit: 'g',
        compare: { parse: 'number', better: 'higher', weight: 2 },
      }),
      t('color_name', 'اللون', 'Colour'),
      t('color_hex', 'كود اللون', 'Colour HEX', 'hex'),
      /* A requirement the printer has to meet, not a score: 190-220 is not
         worse than 240-260, it is a different material. */
      t('print_temp', 'حرارة الطباعة', 'Printing temperature', 'text', {
        unit: '°C',
        compare: { parse: 'range', better: 'none' },
      }),
      t('bed_temp', 'حرارة السرير', 'Bed temperature', 'text', {
        unit: '°C',
        compare: { parse: 'range', better: 'none' },
      }),
      t('compatibility', 'التوافق', 'Compatibility'),
      t('processing_mode', 'نمط المعالجة', 'Processing mode', 'select', {
        options: ['Laser Material', 'Blade Cutting Material', 'Not applicable'],
      }),
      t('dimensions', 'الأبعاد', 'Dimensions', 'text', { unit: 'mm', compare: { parse: 'dimensions', better: 'none' } }),
      t('finish', 'الخامة / التشطيب', 'Finish'),
      t('quantity_per_pack', 'الكمية داخل العبوة', 'Quantity per pack', 'number', { compare: { parse: 'number', better: 'higher', weight: 1 } }),
      t('operating_temp', 'حرارة التشغيل', 'Operating temperature', 'text', {
        unit: '°C',
        compare: { parse: 'range', better: 'none' },
      }),
      t('storage', 'شروط التخزين', 'Storage'),
      t('certifications', 'الشهادات', 'Certifications', 'text', { compare: { parse: 'list', better: 'none' } }),
      // Shared with devices ON PURPOSE: a filament box and a printer box both
      // have contents, and both templates should declare the field so imports
      // treat it as sheet-authoritative for either family.
      t('in_the_box', 'محتويات العلبة', 'In the box', 'multiline', {
        compare: { parse: 'list', better: 'none' },
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
        /* LOWER WINS: ±0.02 mm is a tighter spool than ±0.05, and this is the
           one number that separates a good filament from a cheap one. */
        t('tolerance', 'التفاوت', 'Tolerance', 'text', {
          unit: 'mm',
          compare: { parse: 'number', better: 'lower', weight: 2 },
        }),
        /* A property of the polymer, in neither direction a grade. */
        t('density', 'الكثافة', 'Density', 'text', {
          unit: 'g/cm³',
          compare: { parse: 'number', better: 'none' },
        }),
      ],
    },
    'resin-materials': {
      id: 'resin_mat',
      label_ar: 'خاص بمواد Resin',
      label_en: 'Resin material specifics',
      fields: [
        t('volume', 'الحجم', 'Volume', 'text', {
          unit: 'ml',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        t('wavelength', 'الطول الموجي', 'Wavelength', 'text', { unit: 'nm' }),
        t('hardness', 'الصلابة', 'Hardness'),
        t('shelf_life', 'مدة الصلاحية', 'Shelf life', 'text', {
          unit: 'months',
          compare: { parse: 'number', better: 'higher', weight: 1 },
        }),
      ],
    },
    'model-kits': {
      id: 'kits',
      label_ar: 'أطقم المجسمات',
      label_en: 'Model kits',
      fields: [
        /* A 1200-piece kit is a DIFFERENT product from a 200-piece one, not a
           better one; the count is shown and left unranked. */
        t('pieces', 'عدد القطع', 'Pieces', 'number', { compare: { parse: 'number', better: 'none' } }),
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
        t('control_range', 'مدى التحكم', 'Control range', 'text', {
          unit: 'm',
          compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        t('channels', 'عدد القنوات', 'Channels', 'number', {
          compare: { parse: 'number', better: 'higher', weight: 1 },
        }),
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
    /*
     * A PLYWOOD SHEET IS A MATERIAL, WHICH IS WHY THERE IS NO THIRD FAMILY.
     *
     * «اضافه مواد الطباعه بجانب الفلمنت والرزن». The two groups below are the
     * laser's answer to «خاص بمواد FDM» and «خاص بمواد Resin»: a thing bought
     * by the sheet or the roll, consumed by a machine, priced per piece. The
     * split between them is the MACHINE that eats it — a beam or a blade — and
     * it is an AXIS (`cut-material-technology`, below), so a product filed in
     * «مواد الليزر» is never asked how deep to set a cutting blade.
     *
     * NOT ONE FIELD HERE IS `net_weight`, AND THAT IS A DELIBERATE OMISSION.
     * `GET /api/products/print-calculator` (worker/routes/products.ts) offers
     * EVERY active `materials` product carrying a readable `net_weight` as a
     * filament to price a 3D print by the gram. A 3 mm birch sheet with «1000»
     * in that field would appear in the calculator's spool list as something a
     * printer could extrude. The per-sheet mass is asked for as `sheet_weight`
     * instead — a different id, so the shipping weight is still recorded and
     * the calculator still cannot see it.
     */
    'laser-materials': {
      id: 'laser_mat',
      label_ar: 'خاص بمواد الليزر',
      label_en: 'Laser material specifics',
      fields: [
        /* WHAT THE SHEET IS MADE OF, which decides whether the machine can cut
           it or only mark it — and, for PVC and anything coated in it, whether
           it may be cut at all. A different question from `material_type` in
           «مواصفات المادة», which is where the vendor's own trade name goes. */
        t('substrate', 'المادة الأساس', 'Substrate', 'select', {
          options: ['Plywood', 'MDF', 'Acrylic', 'Leather', 'Paper', 'Fabric', 'Metal', 'Glass', 'Stone', 'Other'],
          compare: { parse: 'text', better: 'none' },
        }),
        /* THE THREE NUMBERS ARE ASKED SEPARATELY, not as one «الأبعاد» string,
           because a buyer matches a sheet against a work area by comparing two
           of them and against a cut depth by comparing the third. None is
           scored: a bigger sheet is a different product, not a better one, and
           a thicker one is harder to cut, not finer. */
        t('sheet_length', 'طول اللوح', 'Sheet length', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'none' },
        }),
        t('sheet_width', 'عرض اللوح', 'Sheet width', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'none' },
        }),
        t('sheet_thickness', 'سماكة اللوح', 'Sheet thickness', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'none' },
        }),
        /* THE SHIPPING MASS OF ONE SHEET. See the group header: this exists as
           its own id precisely so that it is NOT `net_weight`, which the print
           calculator reads as "grams of filament in this box". */
        t('sheet_weight', 'وزن اللوح', 'Sheet weight', 'number', {
          unit: 'g', compare: { parse: 'number', better: 'none' },
          hint_ar: 'وزن اللوح الواحد — للشحن، وليس للحاسبة',
        }),
        t('coating', 'الطلاء', 'Coating', 'text', {
          hint_ar: 'مثال: وجه ملوّن، قشرة خشب، طبقة تعليم بالليزر',
        }),
        /* TWO ANSWERS, NOT ONE. Anodised aluminium marks beautifully and never
           cuts; 3 mm ply does both. A single «متوافق مع الليزر» would have hidden
           the difference the buyer is actually shopping for. */
        t('engravable', 'قابل للحفر', 'Engravable', 'select', {
          options: ['Yes', 'No'], compare: { parse: 'boolean', better: 'yes', weight: 1 },
        }),
        t('cuttable', 'قابل للقص', 'Cuttable', 'select', {
          options: ['Yes', 'No'], compare: { parse: 'boolean', better: 'yes', weight: 1 },
        }),
        t('sheets_per_pack', 'عدد الألواح في العبوة', 'Sheets per pack', 'number', {
          compare: { parse: 'number', better: 'higher', weight: 1 },
        }),
        /* A fitment, not a virtue: a self-adhesive sheet is what a sign maker
           wants and the last thing a box maker wants. */
        t('adhesive_backing', 'ظهر لاصق', 'Adhesive backing', 'select', {
          options: ['Yes', 'No'], compare: { parse: 'boolean', better: 'none' },
        }),
      ],
    },
    'blade-cutting-materials': {
      id: 'blade_mat',
      label_ar: 'خاص بمواد القص بالشفرة',
      label_en: 'Blade cutting material specifics',
      fields: [
        /* THE ONE FIELD THE OTHER FOUR DEPEND ON: a roll is measured in metres
           and a sheet in millimetres, and the length column below means a
           different quantity depending on this answer. */
        t('media_format', 'شكل المادة', 'Media format', 'select', {
          // «Flat sheet» rather than a bare «Sheet», for the reason given at
          // `laser_source`: the single word also means a spec sheet.
          options: ['Roll', 'Flat sheet'], compare: { parse: 'text', better: 'none' },
        }),
        t('media_width', 'عرض المادة', 'Media width', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'none' },
        }),
        /* METRES, because that is how vinyl is sold and how a buyer compares
           two rolls. Scored upward for once — with the format and the width
           fixed, more length in the box IS more product, exactly as
           `net_weight` is on a spool. */
        t('media_length', 'طول المادة', 'Media length', 'number', {
          unit: 'm', compare: { parse: 'number', better: 'higher', weight: 2 },
        }),
        t('media_thickness', 'سماكة المادة', 'Media thickness', 'number', {
          unit: 'mm', compare: { parse: 'number', better: 'none' },
        }),
        /* The vendor's own setting, quoted as a number or a range, and read as
           neither better nor worse — it is an instruction for the machine. */
        t('blade_depth', 'عمق الشفرة الموصى به', 'Recommended blade depth', 'text', {
          unit: 'mm', compare: { parse: 'range', better: 'none' },
          hint_ar: 'الإعداد الذي توصي به الشركة — مثال: 1-2',
        }),
        t('backing_liner', 'الورق الفاصل', 'Backing liner', 'text', {
          hint_ar: 'مثال: ورق سيليكون قابل للفصل — أو لا يوجد',
        }),
        /* How much work is left AFTER the machine finishes, which is the half
           of the job a spec sheet never mentions. Shown, not scored: «صعب» is
           a warning to a beginner and nothing at all to a sign shop. */
        t('weeding_difficulty', 'صعوبة إزالة الزوائد', 'Weeding difficulty', 'select', {
          options: ['Easy', 'Moderate', 'Difficult'], compare: { parse: 'text', better: 'none' },
        }),
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

/*
 * SIX NAMES NOW, AND THE TWO NEW ONES ARE NOT A SECOND SYSTEM.
 *
 * The owner's four were «طابعه / ملحقات / فلمنت / اكسسوار». «إضافة قسم جديد وهو
 * قسم الليزر بجانب طابعات الفلامنت والرزن» added a machine that is neither a
 * printer nor a part, and «اضافه مواد الطباعه بجانب الفلمنت والرزن» added a
 * consumable that is neither a filament nor a resin — so each got a name,
 * inside the family it already belonged to.
 *
 * THE LASER ACCESSORIES DID NOT GET ONE. A lens and a filter cartridge are
 * «ملحقات وقطع», which already exists; the seeded «ملحقات الليزر» section was
 * added to that type's sectionSlugs and its spec group to that type's groups.
 * A type is a question a human answers when they sit down to type a product
 * in, and "is this a laser lens or a printer nozzle?" is not one of them.
 */
export type ProductTypeId = 'printer' | 'parts' | 'filament' | 'accessory' | 'laser' | 'laser_material';

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
    t('dimensions', 'الأبعاد', 'Dimensions', 'text', { unit: 'mm', compare: { parse: 'dimensions', better: 'none' } }),
    t('weight', 'الوزن', 'Weight', 'text', { unit: 'kg', compare: { parse: 'number', better: 'none' } }),
    t('quantity_per_pack', 'الكمية داخل العبوة', 'Quantity per pack', 'number', { compare: { parse: 'number', better: 'higher', weight: 1 } }),
    t('compatibility', 'التوافق', 'Compatibility'),
    t('certifications', 'الشهادات', 'Certifications', 'text', { compare: { parse: 'list', better: 'none' } }),
    t('storage', 'شروط التخزين', 'Storage'),
    t('warranty', 'الضمان', 'Warranty', 'text', { unit: 'months', compare: { parse: 'number', better: 'higher', weight: 2 } }),
    t('in_the_box', 'محتويات العلبة', 'In the box', 'multiline', {
      compare: { parse: 'list', better: 'none' },
      hint_ar: 'عنصر في كل سطر — تُعرض للزبون كنقاط',
    }),
  ],
};

const g = (family: TemplateFamilyDef, slug: string): TemplateGroup[] => {
  const found = family.sections[slug];
  return found ? [found] : [];
};

/**
 * Fields SELECTED from a family's common group — never re-declared.
 *
 * THE TWO LASER TYPES CANNOT TAKE `common` WHOLE, and neither can they afford
 * a second copy of it. «مواصفات الجهاز» asks a printer for its build volume,
 * its nozzle diameter and its print speed; «مواصفات المادة» asks a spool for
 * its diameter, its printing temperature and its bed temperature. Put those in
 * front of a laser cutter or a plywood sheet and the admin form asks questions
 * the product cannot answer — the precision the owner asked for («لجعل هناك
 * دقه باضافه المعلومات») working in reverse.
 *
 * Copying the twenty fields that DO apply would have been the other failure:
 * two definitions of `warranty`, one of which quietly stops matching the other.
 * So this picks the field OBJECTS out of the family's own list. A `compare`
 * annotation edited in «مواصفات الجهاز» reaches the laser template in the same
 * edit, because it is the same object.
 *
 * An id this family's common group does not declare is dropped rather than
 * invented — a typo here must not become a field nobody can see.
 */
const fromCommon = (family: TemplateFamilyDef, ...ids: string[]): TemplateField[] => {
  const by = new Map(family.common.fields.map((f) => [f.id, f]));
  return ids.map((id) => by.get(id)).filter((f): f is TemplateField => f !== undefined);
};

/**
 * What a laser cutter has in common with every other machine on the shelf.
 *
 * WHAT IS LEFT OUT IS THE POINT, and it is exactly five ids: `technology`
 * (its options are FDM / Resin / SLA / DLP — the laser's own answer is
 * `laser_source`), `build_volume`, `print_speed`, `resolution` and `nozzle`.
 * The laser group above asks the same four questions in the machine's own
 * units — work area, engraving and cutting speed, positioning accuracy — so
 * nothing is lost by dropping them and a form of thirty rows is not printed
 * for a machine that answers twenty-five.
 *
 * `slicer_software` is left out for the same reason and is not replaced: a
 * cutter is driven by LightBurn or the vendor's own suite, which is what
 * `companion_app` already asks for.
 */
const LASER_CORE: TemplateGroup = {
  id: 'laser_core',
  label_ar: 'مواصفات الجهاز',
  label_en: 'Device specifications',
  fields: fromCommon(
    DEVICES,
    'model', 'release_year', 'skill_level', 'supported_materials',
    'power', 'dimensions', 'weight', 'connectivity', 'compatibility', 'display',
    'camera', 'camera_resolution', 'camera_fps', 'noise_level',
    'companion_app', 'assembly', 'warranty', 'in_the_box'
  ),
};

/**
 * What a sheet or a roll has in common with every other consumable.
 *
 * THE FOUR IT DOES NOT TAKE FROM «مواصفات المادة» are `diameter`, `print_temp`,
 * `bed_temp` — a plywood sheet has no filament diameter and is never heated to
 * 220 °C — and `net_weight`, which is the one with teeth: the print calculator
 * reads that field to offer a material as filament by the gram (see the
 * «مواد الليزر» group header). `dimensions` is left out too, because the sheet
 * group asks for the three axes separately and by name.
 *
 * `processing_mode` IS taken, and it is the field that already anticipated
 * this section: its options have read «Laser Material / Blade Cutting Material»
 * since before there was a laser catalogue to put them in.
 */
const LASER_MATERIAL_CORE: TemplateGroup = {
  id: 'laser_material_core',
  label_ar: 'مواصفات المادة',
  label_en: 'Material specifications',
  fields: fromCommon(
    MATERIALS,
    'material_type', 'processing_mode', 'color_name', 'color_hex', 'finish',
    'compatibility', 'quantity_per_pack', 'operating_temp', 'storage',
    'certifications', 'in_the_box'
  ),
};

export const PRODUCT_TYPES: ProductTypeDef[] = [
  {
    id: 'printer',
    label_ar: 'طابعة',
    label_en: 'Printer',
    family: 'devices',
    hint_ar: 'الطابعات ثلاثية الأبعاد بكل أنواعها — FDM و Resin.',
    sectionSlugs: ['fdm-printers', 'resin-printers', 'printers'],
    groups: [
      DEVICES.common,
      ...g(DEVICES, 'device-environment'),
      ...g(DEVICES, 'fdm-printers'),
      ...g(DEVICES, 'fdm-extrusion'),
      ...g(DEVICES, 'fdm-motion'),
      ...g(DEVICES, 'fdm-control'),
      ...g(DEVICES, 'resin-printers'),
      ...g(DEVICES, 'resin-motion'),
    ],
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
      // «ملحقات الليزر» — the seeded section and the two slugs 0102 falls back
      // to if a live store already owns the first. A laser section missing
      // from this list would be resolved by `productTypeForBranch`'s last
      // line, which answers `printer` for anything in the devices family: a
      // replacement lens would be handed the build-volume form.
      'laser-accessories',
      'laser-accessories-levo',
      'cat_laser_acc',
    ],
    groups: [
      ...g(DEVICES, 'printer-accessories'),
      ...g(DEVICES, 'resin-printer-accessories'),
      ...g(DEVICES, 'laser-accessories'),
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
  {
    id: 'laser',
    label_ar: 'ليزر',
    label_en: 'Laser',
    family: 'devices',
    hint_ar: 'أجهزة القص والحفر بالليزر — CO2 ودايود وفايبر.',
    // EVERY SLUG 0102 CAN WRITE, not just the one it prefers. That migration
    // copies 0018's contract — `<slug>` then `<slug>-levo` then the bare id —
    // because a live store may already own «laser-machines», and a section
    // whose slug is in no type's list falls through to the devices family's
    // headline type and silently becomes a printer.
    sectionSlugs: [
      'laser-machines',
      'laser-machines-levo',
      'cat_laser_machines',
      // The root, so a product filed directly under «أجهزة الليزر» — before
      // anyone picks a child section — is a laser rather than a printer. The
      // branch is walked leaf-first, so an accessory under it is still a part.
      'laser-crafting',
      'laser-crafting-levo',
      'cat_laser',
    ],
    groups: [
      // THE LASER GROUPS COME FIRST, and that ordering is load bearing:
      // `dedupeFields` gives a field id to the first group that claims it, so
      // the specific group must precede the core — the same rule `parts` and
      // `accessory` follow with PHYSICAL_CORE.
      ...g(DEVICES, 'laser-machines'),
      ...g(DEVICES, 'laser-safety'),
      // The mains questions are the same questions for any machine on Iraqi
      // power, and powerAdvice.ts sizes a UPS from these fields whatever the
      // machine is. A cutter draws its tube AND its extraction fan from the
      // same socket, so it needs them at least as much as a printer does.
      ...g(DEVICES, 'device-environment'),
      LASER_CORE,
    ],
  },
  {
    id: 'laser_material',
    label_ar: 'مواد ليزر وقص',
    label_en: 'Laser & cutting materials',
    family: 'materials',
    hint_ar: 'ما يُقص أو يُحفر: ألواح خشب وأكريليك وجلد، ولفّات فينيل وورق.',
    sectionSlugs: [
      'laser-material',
      'laser-material-levo',
      'cat_materials_laser',
      'blade-cutting-material',
      'blade-cutting-material-levo',
      'cat_materials_blade',
    ],
    groups: [
      ...g(MATERIALS, 'laser-materials'),
      ...g(MATERIALS, 'blade-cutting-materials'),
      LASER_MATERIAL_CORE,
    ],
  },
];

const TYPE_BY_ID = new Map(PRODUCT_TYPES.map((p) => [p.id, p]));
const TYPE_BY_SLUG = new Map<string, ProductTypeDef>();
for (const p of PRODUCT_TYPES) for (const slug of p.sectionSlugs) TYPE_BY_SLUG.set(slug, p);

// ------------------------------------------------- the seeded taxonomy leaves
//
// A TYPE IS NOT A TECHNOLOGY, and conflating them is what put eight Resin
// fields on a Bambu Lab A1. `printer` composes device-common + FDM + Resin
// because the TYPE covers both machines; the section the product is actually
// filed in — «طابعات FDM» — is what says which of the two a human should be
// asked about. `fieldsFor` used the branch only to pick the type and then
// threw it away, so every printer got the union: 22 + 17 + 8 = 47 fields,
// eight of them about an LCD an A1 does not have.
//
// WHY THE ID AND NOT THE SLUG. Migration 0018 seeds these sections with a
// PREFERRED slug and two documented fallbacks: if `fdm-printers` is taken it
// writes `fdm-printers-levo`, and if that is taken too it writes the id
// itself. The id never moves. So a match is attempted on the id first, and the
// slug forms 0018 can produce are accepted after it — a store whose taxonomy
// collided must still get the right fields, and an admin renaming a slug in
// the taxonomy screen must not silently widen the form back to 47 fields.
//
// AN AXIS IS A SET OF SIBLINGS THAT EXCLUDE EACH OTHER. Naming one leaf of an
// axis drops the others. Naming NONE of them keeps them all, which is the
// honest answer for a product filed directly under «الطابعات»: the section has
// not said which technology, so neither do we.

interface SeededLeaf {
  /** The catalog id migration 0018 writes. Stable; the slug is not. */
  id: string;
  /** The slug 0018 PREFERS. `<slug>-levo` and the bare id are its fallbacks. */
  slug: string;
  /**
   * The groups this leaf selects. EMPTY is meaningful: a leaf can add no group
   * of its own and still need to say "not my sibling's".
   *
   * A LIST, not one id, since the printer sections were split into readable
   * sub-groups. «خاص بطابعات FDM» was one flat group of seventeen fields and
   * adding the extrusion, motion and control specs to it would have produced
   * the wall of text the owner explicitly refused. Each sub-group is still
   * owned by the same leaf, so the narrowing is unchanged in meaning: choose
   * Resin and every FDM group leaves the form together, as one always did.
   */
  groups: string[];
}

const AXES: Record<string, SeededLeaf[]> = {
  'printer-technology': [
    { id: 'cat_printers_fdm', slug: 'fdm-printers', groups: ['fdm', 'fdm_extrusion', 'fdm_motion', 'fdm_control'] },
    { id: 'cat_printers_resin', slug: 'resin-printers', groups: ['resin', 'resin_motion'] },
  ],
  'material-technology': [
    { id: 'cat_materials_fdm', slug: 'fdm-materials', groups: ['fdm_mat'] },
    { id: 'cat_materials_resin', slug: 'resin-materials', groups: ['resin_mat'] },
  ],
  // A BEAM AND A BLADE ARE NOT THE SAME CONSUMABLE, and the `laser_material`
  // type carries both groups because it covers both shelves. Without this axis
  // a vinyl roll would be asked its engravable substrate and a birch sheet how
  // deep to set a blade — the union problem the printer template was split to
  // end. It is a NEW axis rather than a leaf on `printer-technology`: a laser
  // leaf there would pull these groups into the printer type.
  'cut-material-technology': [
    { id: 'cat_materials_laser', slug: 'laser-material', groups: ['laser_mat'] },
    { id: 'cat_materials_blade', slug: 'blade-cutting-material', groups: ['blade_mat'] },
  ],
  // «ملحقات طابعات FDM» declares no group of its own, but it is still the
  // statement "this is not a Resin accessory" — without the empty entry an FDM
  // accessory would keep being asked for a wash-station capacity.
  //
  // «ملحقات الليزر» IS THE THIRD SIBLING, and it has to be, because `parts`
  // now carries `laser_acc`. A group added to a type without a leaf on the
  // type's axis is added to EVERY section of that type: the nozzle sheet grew
  // a focal length and a filter life, and the lens sheet kept the resin
  // wash-station capacity. That is the same inflation the printer template was
  // split to end, one type over.
  'accessory-technology': [
    { id: 'cat_pacc_fdm', slug: 'fdm-printer-accessories', groups: [] },
    { id: 'cat_pacc_resin', slug: 'resin-printer-accessories', groups: ['acc_resin'] },
    { id: 'cat_laser_acc', slug: 'laser-accessories', groups: ['laser_acc'] },
  ],
};

/** One section of the branch a product is filed in. */
export interface SectionRef {
  id: string;
  slug: string;
}

/** Every string 0018 could have written as this leaf's slug. */
const slugForms = (leaf: SeededLeaf): string[] => [leaf.slug, `${leaf.slug}-levo`, leaf.id];

const namesLeaf = (branch: SectionRef[], leaf: SeededLeaf): boolean =>
  branch.some((s) => s.id === leaf.id || slugForms(leaf).includes(s.slug));

/**
 * The group ids this branch EXCLUDES. Empty when the branch names no leaf of
 * any axis — an unnarrowed section keeps the whole type, as it did before.
 */
function excludedGroups(branch: SectionRef[]): Set<string> {
  const out = new Set<string>();
  for (const leaves of Object.values(AXES)) {
    const named = leaves.filter((l) => namesLeaf(branch, l));
    // Nothing named → no opinion. Everything named (a branch that somehow
    // walks through both) → also no opinion, rather than an empty form.
    if (named.length === 0 || named.length === leaves.length) continue;
    for (const l of leaves) {
      if (named.includes(l)) continue;
      for (const gid of l.groups) out.add(gid);
    }
  }
  return out;
}

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
  return productTypeForBranch(family, sectionSlugs.map((slug) => ({ id: slug, slug })));
}

/**
 * The same answer from a branch that carries IDS as well as slugs — the form
 * follows the taxonomy the admin actually configured, so renaming a slug does
 * not silently reclassify a section. Slugs are still consulted, because a
 * section an admin created by hand has an id we have never seen.
 */
export function productTypeForBranch(
  family: 'devices' | 'materials',
  branch: SectionRef[]
): ProductTypeId {
  for (const section of branch) {
    // The seeded id first: it is the one thing 0018 guarantees.
    for (const leaves of Object.values(AXES)) {
      for (const leaf of leaves) {
        if (section.id === leaf.id) {
          const byLeaf = TYPE_BY_SLUG.get(leaf.slug);
          if (byLeaf) return byLeaf.id;
        }
      }
    }
    const found = TYPE_BY_SLUG.get(section.slug);
    if (found) return found.id;
  }
  return family === 'devices' ? 'printer' : 'filament';
}

/** The groups of one product type, deduped by FIELD id (not group id): two
 *  composed groups may legitimately declare the same field, and a repeated
 *  field would become a repeated column. The first group to claim a field
 *  keeps it, so the more specific group (listed first) wins over the core. */
function dedupeFields(groups: TemplateGroup[]): TemplateGroup[] {
  const seen = new Set<string>();
  const out: TemplateGroup[] = [];
  for (const group of groups) {
    const fields = group.fields.filter((f) => !seen.has(f.id));
    for (const f of fields) seen.add(f.id);
    if (fields.length) out.push({ ...group, fields });
  }
  return out;
}

export function groupsForType(id: ProductTypeId): TemplateGroup[] {
  return dedupeFields(productType(id).groups);
}

/**
 * THE GROUPS ONE SECTION SHOULD SHOW — the type, then the branch's narrowing.
 *
 * The dedupe runs AFTER the filter, not before, and that ordering is load
 * bearing: `acc_common` and `PHYSICAL_CORE` both declare `material`, and the
 * first group to claim a field keeps it. Dropping a group after the dedupe
 * would take a field with it that a surviving group would happily have
 * declared.
 *
 * NOTHING IS DESTROYED BY THE NARROWING. A value stored under a field this
 * section no longer declares stays in `spec_fields` — the import merges rather
 * than replaces (importApply.ts) and the form renders it under «مواصفات محفوظة
 * خارج قالب هذا القسم» (specIdsOutsideTemplate). A resin spec on a machine
 * that was once filed as Resin is legacy data, and legacy data is shown as
 * legacy data rather than deleted or promoted back to a primary field.
 */
export function groupsForSection(
  family: 'devices' | 'materials',
  branch: SectionRef[]
): TemplateGroup[] {
  return narrowGroups(productTypeForBranch(family, branch), branch);
}

/**
 * The narrowing ALONE, for a caller that has already decided the type.
 *
 * The import panel lets an admin download a sheet for an explicit
 * `?type=printer` while also naming a section; the section must still be
 * allowed to drop the Resin columns, but it must NOT be allowed to overrule
 * the type the admin typed. Splitting the two keeps that honest.
 */
export function narrowGroups(type: ProductTypeId, branch: SectionRef[]): TemplateGroup[] {
  const excluded = excludedGroups(branch);
  return dedupeFields(productType(type).groups.filter((g) => !excluded.has(g.id)));
}

/**
 * The groups a product in this family and section should show — the SAME
 * groups its import template carries, because both go through the product
 * type. The admin form (worker/routes/adminTaxonomy.ts) and the CSV columns
 * (worker/lib/importCsv.ts) therefore cannot drift: a field is in both places
 * or in neither.
 */
export function fieldsFor(family: 'devices' | 'materials', sectionSlugs: string[]): TemplateGroup[] {
  return groupsForSection(family, sectionSlugs.map((slug) => ({ id: slug, slug })));
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

/**
 * Every group of both families, in definition order — the walk
 * `specGroupsFromFields` makes, exported because the comparison
 * (worker/lib/compareSpecs.ts) must make exactly the same one. A second copy of
 * it there would be the fourth definition of what a spec is, and the first
 * chance for a comparison row to sit under a heading the product page never
 * shows.
 */
export function allTemplateGroups(): TemplateGroup[] {
  return ALL_GROUPS.slice();
}

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
