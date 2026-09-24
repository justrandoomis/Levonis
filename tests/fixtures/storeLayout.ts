/**
 * One realistic store — and a second merchant's, to be refused — seeded into a
 * database with every migration applied. The shared ground of the store-page
 * tests (tests/storeLayout*.test.ts, tests/storefrontBlocks.test.ts).
 *
 * The store is the one the storefront screenshots were taken of: a profile
 * with links and facts, three collections, eight products (three on sale, one
 * out of stock), two services, four showcase entries, three reviews and a
 * coupon — so "the classic page reproduces today's sections" is tested
 * against a store that HAS every section.
 */
import type { DatabaseSync } from 'node:sqlite';

export const OWNER = 'owner';
export const OTHER = 'other';
export const STORE_ID = 's1';
export const SLUG = 'raf3d';
export const OTHER_STORE_ID = 's2';
export const OTHER_SLUG = 'othershop';
export const STORE_NAME = 'مطبعة الرافدين ثلاثية الأبعاد';

/** Media keys the tests reference, by what the ledger says about them. */
export const MEDIA = {
  /** A live picture this owner uploaded. */
  picture: 'merchants/owner/public/hero0001.webp',
  /** A second live picture. */
  picture2: 'merchants/owner/public/pic00002.webp',
  /** A live video this owner uploaded. */
  video: 'merchants/owner/public/clip0001.mp4',
  /** A picture this owner uploaded and deleted. */
  deleted: 'merchants/owner/public/gone0001.webp',
  /** Well formed, under this owner's prefix, never uploaded. */
  unknown: 'merchants/owner/public/none0001.webp',
  /** A live picture, but ANOTHER owner's. */
  foreign: 'merchants/other/public/their001.webp',
  /** Named like a picture, recorded as a video. */
  mislabelled: 'merchants/owner/public/fake0001.webp',
} as const;

/** The workshop printer's hourly rate: a cost figure no public answer may carry. */
export const PRINTER_HOUR_IQD = 7373;

export const PRODUCT_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const;
export const COLLECTION_IDS = ['sec1', 'sec2', 'sec3'] as const;

export function seedLayoutStore(raw: DatabaseSync): void {
  const img = (n: number) => `/files/merchants/owner/public/${n.toString(16).padStart(8, 'a')}.webp`;
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('owner','Ali','owner@x.co','h','merchant'),
      ('other','Zaid','other@x.co','h','merchant'),
      ('c1','Ahmed Kareem','c1@x.co','h','customer'),
      ('c2','Sara Hadi','c2@x.co','h','customer'),
      ('c3','Omar Najm','c3@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','other','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,governorate,verified,rating_avg_x100,rating_count,completed_orders) VALUES
      ('m1','owner','Rafidain 3D','baghdad',1,467,3,41),
      ('m2','other','Other Shop','basra',0,0,0,0);
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,description,logo_key,banner_key,accent,
        categories,governorate,service_areas,contact_phone,contact_phone_public,business_hours,policies,delivery_settings,
        social_links,profile_links,profile_facts,accepts_custom_requests,sells_direct_products,status,created_at)
      VALUES ('s1','m1','owner','raf3d','${STORE_NAME}','طباعة دقيقة وقطع غيار حسب الطلب',
        'ورشة طباعة ثلاثية الأبعاد في بغداد: مجسمات، قطع غيار، هدايا مخصصة، ونماذج هندسية بدقة عالية وخامات مضمونة.',
        'merchants/owner/public/logo0001.webp','merchants/owner/public/bnr00001.webp','teal',
        '["مجسمات","قطع غيار","هدايا"]','baghdad','["بغداد","البصرة","أربيل"]','07701234567',1,
        '[{"day":"السبت - الخميس","open":"10:00","close":"22:00"}]',
        '{"الاستبدال":"يمكن الاستبدال خلال 3 أيام إذا كان العيب من الطباعة.","التصنيع":"القطع المخصصة تُصنع بعد تأكيد الطلب."}',
        '{"fee_iqd":5000,"free_over_iqd":75000,"note":"توصيل خلال 2-3 أيام لكل المحافظات"}',
        '{"Instagram":"https://instagram.com/raf3d","Telegram":"https://t.me/raf3d"}',
        '[{"icon":"instagram","title":"instagram.com/raf3d","url":"https://instagram.com/raf3d","visible":true},{"icon":"telegram","title":"t.me/raf3d","url":"https://t.me/raf3d","visible":true},{"icon":"globe","title":"موقعنا","url":"https://raf3d.example.com","visible":true}]',
        '[{"icon":"printer","title":"4 طابعات","subtitle":"FDM ورزن","visible":true},{"icon":"truck","title":"شحن سريع","subtitle":"كل المحافظات","visible":true},{"icon":"shield","title":"ضمان","subtitle":"على كل قطعة","visible":true}]',
        1,1,'active','2025-11-02T10:00:00.000Z'),
      ('s2','m2','other','othershop','Other Shop','','',NULL,NULL,'default',
        '[]','basra','[]','',0,'[]','{}','{}','{}','[]','[]',0,1,'active','2026-01-02T10:00:00.000Z');
    INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('raf3d','s1',1), ('othershop','s2',1);
    INSERT INTO merchant_store_sections (id,store_id,name,name_ar,sort_order,active) VALUES
      ('sec1','s1','Figures','مجسمات',1,1), ('sec2','s1','Spare parts','قطع غيار',2,1), ('sec3','s1','Gifts','هدايا',3,1),
      ('osec1','s2','Theirs','لهم',1,1);
    INSERT INTO follows (user_id, merchant_id) VALUES ('c1','m1'),('c2','m1'),('c3','m1');
    INSERT INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size,deleted_at) VALUES
      ('${MEDIA.picture}','public','merchants','owner','image/webp',1000,NULL),
      ('${MEDIA.picture2}','public','merchants','owner','image/webp',1000,NULL),
      ('${MEDIA.video}','public','merchants','owner','video/mp4',9000,NULL),
      ('${MEDIA.deleted}','public','merchants','owner','image/webp',1000,'2026-09-01T00:00:00.000Z'),
      ('${MEDIA.foreign}','public','merchants','other','image/webp',1000,NULL),
      ('${MEDIA.mislabelled}','public','merchants','owner','video/mp4',1000,NULL);
  `);
  const products: Array<[string, string, string, number, number | null, string | null, number, number]> = [
    ['p1', 'Dragon figure', 'مجسم تنين مفصلي', 18000, 25000, 'sec1', 1, 1],
    ['p2', 'Gear set', 'طقم تروس صناعية', 12000, null, 'sec2', 0, 2],
    ['p3', 'Name lamp', 'مصباح بالاسم', 30000, null, 'sec3', 1, 3],
    ['p4', 'Phone stand', 'حامل هاتف قابل للطي', 7000, 9000, 'sec3', 0, 4],
    ['p5', 'Chess set', 'طقم شطرنج كامل', 45000, null, 'sec1', 0, 5],
    ['p6', 'Drone frame', 'هيكل درون 250', 22000, null, 'sec2', 0, 6],
    ['p7', 'Planter', 'أصيص نباتات هندسي', 9000, 11000, 'sec3', 0, 7],
    ['p8', 'Keychain', 'ميدالية مفاتيح بالشعار', 3000, null, null, 0, 8],
  ];
  const insert = raw.prepare(
    `INSERT INTO community_products (id,merchant_id,store_id,slug,status,lifecycle,name,name_ar,description,images,price_iqd,
        original_price_iqd,section_id,featured,stock,track_stock,sold_count,created_at)
     VALUES (?,?,?,?, 'active','active', ?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let t = Date.parse('2026-09-01T10:00:00.000Z');
  for (const [id, name, nameAr, price, orig, section, featured, n] of products) {
    t += 3600_000;
    insert.run(id, 'm1', 's1', `raf3d-${id}`, nameAr, nameAr, `${nameAr} — ${name}`, JSON.stringify([img(n)]), price, orig, section, featured,
      id === 'p6' ? 0 : 5, 1, n * 7, new Date(t).toISOString());
  }
  insert.run('q1', 'm2', 's2', 'othershop-q1', 'Their product', 'منتجهم', '', '[]', 1000, null, 'osec1', 0, 5, 1, 0, new Date(t).toISOString());
  raw.exec(`
    INSERT INTO merchant_services (id,store_id,merchant_id,title,description,kind,price_from_iqd,price_unit,materials,image_key,active,sort_order) VALUES
      ('sv1','s1','m1','طباعة حسب الطلب','ارسل ملفك STL ونطبعه بالخامة التي تختارها.','print_service',5000,'قطعة','["PLA","PETG","Resin"]','merchants/owner/public/svc00001.webp',1,1),
      ('sv2','s1','m1','تصميم ونمذجة','نحوّل فكرتك أو رسمتك إلى نموذج جاهز للطباعة.','design',NULL,'','[]',NULL,1,2);
    INSERT INTO merchant_showcase (id,store_id,kind,title,details,image_key,sort_order,active) VALUES
      ('sh1','s1','work','مجسم معماري','مقياس 1:200 — PLA','merchants/owner/public/shw00001.webp',1,1),
      ('sh2','s1','work','قطع درون','PETG مقوّى','merchants/owner/public/shw00002.webp',2,1),
      ('sh3','s1','printer','Bambu Lab X1C','متعدد الألوان — 256mm',NULL,1,1),
      ('sh4','s1','material','PETG','مقاوم للحرارة والصدمات',NULL,1,1);
    INSERT INTO merchant_reviews (id,merchant_id,store_id,customer_id,order_id,rating,body,merchant_reply,created_at) VALUES
      ('r1','m1','s1','c1','o1',5,'جودة ممتازة والتغليف رائع، وصل خلال يومين.','شكرًا لثقتك!','2026-09-10T10:00:00.000Z'),
      ('r2','m1','s1','c2','o2',5,'التنين مفصلي فعلًا وكل القطع تتحرك.','','2026-09-12T10:00:00.000Z'),
      ('r3','m1','s1','c3','o3',4,'ممتاز لكن التوصيل تأخر يومًا.','','2026-09-14T10:00:00.000Z');
    INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,min_total_iqd,active) VALUES
      ('cp1','s1','m1','RAF10','percent',10,20000,1),
      ('ocp1','s2','m2','THEIRS','percent',10,0,1);
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,brand,model,build_x_mm,build_y_mm,build_z_mm,
        materials,multicolor,enclosed,quality_max,machine_hour_iqd) VALUES
      ('pr1','m1','s1','X1C','fdm','Bambu Lab','X1 Carbon',256,256,256,'["pla","petg"]',1,1,'fine',${PRINTER_HOUR_IQD});
  `);
}
