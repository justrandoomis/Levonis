/**
 * THE BUY-PATH FIXTURE — one catalogue and one bundle builder, shared by
 * `tests/bundleCart.test.ts`, `tests/bundleCheckout.test.ts`,
 * `tests/bundleOrderSnapshot.test.ts`, `tests/bundleReturns.test.ts` and
 * `tests/bundleBatchLimits.test.ts`.
 *
 * It seeds the OWNER'S OWN worked example — printer 5, filament 6 needing 2,
 * nozzle 20 → `max_bundles = 3` — plus a colour-tracked filament for the
 * customer-choice cases and a pre-order spool for the pre-order bundle, so
 * every buy-path test argues about the same catalogue rather than five
 * lookalikes that can drift apart.
 *
 * Nothing here writes through a route: the admin panel is another slice, and a
 * buy-path test must be able to construct a configuration the panel would
 * refuse (a component whose colour is deactivated after the fact, a window that
 * expired between the cart and the door) in order to prove the DOOR refuses it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { freshDb } from '../fixtures/app';
import { acceptedPolicies } from './policies';

export const FUTURE = '2099-01-01T00:00:00.000Z';
export const PAST = '2020-01-01T00:00:00.000Z';

export function seedCatalogue(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('u_plus','Zed','z@x.co','h','customer'),
      ('u_prime','Noor','n@x.co','h','customer'),
      ('u_pro','Rami','r@x.co','h','customer'),
      ('boss','Admin','a@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('m_plus','u_plus','plus_12mo','plus','active',12,49000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('m_prime','u_prime','prime_12mo','prime','active',12,99000,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('m_pro','u_pro','pro_12mo','pro','active',12,199000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('addr_b','buyer','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('addr_p','u_plus','Home','Zed','+9647701234568','Baghdad, Karrada 13','',1),
      ('addr_m','u_prime','Home','Noor','+9647701234569','Baghdad, Karrada 14','',1),
      ('addr_o','u_pro','Home','Rami','+9647701234570','Baghdad, Karrada 15','',1);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES
      ('dep_b','buyer','deposit','USD',100000,'approved'),
      ('dep_p','u_plus','deposit','USD',100000,'approved'),
      ('dep_m','u_prime','deposit','USD',100000,'approved'),
      ('dep_o','u_pro','deposit','USD',100000,'approved');

    -- The owner's worked example, plus a colour-tracked spool and a pre-order one.
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES
      ('p_printer','printer','Printer X1','طابعة','پرینتەر',400000,'active',5,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/x1.png"]','BASE','{"size_class":"printer_large"}'),
      ('p_pla','pla','PLA Basic','بي إل إيه','پی ئێل ئەی',25000,'active',6,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/pla.png"]','BASE','{"is_spool":true}'),
      ('p_nozzle','nozzle','Nozzle 0.4','فوهة','لوولە',5000,'active',20,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/nz.png"]','BASE','{}'),
      ('p_color','abs','ABS Spool','إيه بي إس','ئەی بی ئێس',30000,'active',99,'[]','[]',
       'direct_sale','["direct_sale"]','[]','["https://cdn/abs.png"]','COLOR','{"is_spool":true}'),
      ('p_pre','petg','PETG Spool','بي إي تي جي','پی ئی تی جی',40000,'active',NULL,'[]','[]',
       'pre_order','["pre_order"]','[{"method":"air","active":true},{"method":"sea","active":true}]',
       '["https://cdn/petg.png"]','BASE','{"is_spool":true}'),
      ('p_pre2','tpu','TPU Spool','تي بي يو','تی پی یو',45000,'active',NULL,'[]','[]',
       'pre_order','["pre_order"]','[{"method":"sea","active":true}]','["https://cdn/tpu.png"]','BASE','{"is_spool":true}');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,stock,reserved,sort,active) VALUES
      ('pc_black','p_color','Black','أسود','#000',4,0,0,1),
      ('pc_white','p_color','White','أبيض','#fff',4,0,1,1);
  `);
  // The owner's shipping policy, configured — a bundle holding a printer
  // reaches the printer freight branch and twelve spools reach the carton
  // threshold through the COMPONENTS' own facts, and an unpriced fee component
  // is an honest `SHIPPING_NEEDS_CONFIG` refusal rather than a silent waiver.
  raw
    .prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)")
    .run(
      JSON.stringify({
        ordinary_iqd: 5000,
        printer_small_iqd: 15000,
        printer_large_iqd: 25000,
        carton_threshold_spools: 12,
        carton_fee_iqd: 8000,
      })
    );
  return raw;
}

export interface ComponentSpec {
  id: string;
  product: string;
  qty?: number;
  optional?: boolean;
  optionValueIds?: string[];
  colorId?: string;
  picksOption?: boolean;
  picksColor?: boolean;
  choices?: Array<{ dim: 'option_value' | 'color'; ref: string }>;
}

export interface BundleSpec {
  id: string;
  slug?: string;
  name?: string;
  priceIqd?: number;
  primeIqd?: number | null;
  proIqd?: number | null;
  status?: string;
  config?: Partial<{
    price_mode: string;
    discount_percent: number | null;
    discount_iqd: number | null;
    min_price_iqd: number;
    plus_price_iqd: number | null;
    max_qty_per_order: number;
  }>;
  window?: Partial<{
    starts_at: string | null;
    ends_at: string | null;
    required_tiers: string;
    offer_price_mode: string;
    offer_price_iqd: number | null;
    plus_price_iqd: number | null;
    locked_preview: number;
    active: number;
  }>;
  limits?: { max_per_user?: number | null; max_global?: number | null };
  components?: ComponentSpec[];
}

/** The default bundle: a printer, two spools of PLA and a nozzle — the
 *  owner's own example, so `max_bundles` is 3 and the arithmetic is checkable
 *  by hand. */
export const DEFAULT_COMPONENTS: ComponentSpec[] = [
  { id: 'bc_printer', product: 'p_printer', qty: 1 },
  { id: 'bc_pla', product: 'p_pla', qty: 2 },
  { id: 'bc_nozzle', product: 'p_nozzle', qty: 1 },
];

export function addBundle(raw: DatabaseSync, o: BundleSpec): void {
  raw
    .prepare(
      `INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,prime_price_iqd,pro_price_iqd,status,stock,
                             options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode,composition)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,'[]','[]','bundle','["bundle"]','[]','["https://cdn/bundle.png"]','BASE','bundle')`
    )
    .run(
      o.id,
      o.slug ?? o.id,
      o.name ?? 'Starter Bundle',
      'حزمة البداية',
      'پاکێجی دەستپێک',
      o.priceIqd ?? 400_000,
      o.primeIqd ?? null,
      o.proIqd ?? null,
      o.status ?? 'active'
    );
  const cfg = {
    price_mode: 'fixed',
    discount_percent: null as number | null,
    discount_iqd: null as number | null,
    min_price_iqd: 1,
    plus_price_iqd: null as number | null,
    max_qty_per_order: 5,
    ...(o.config ?? {}),
  };
  raw
    .prepare(
      `INSERT INTO bundle_config (product_id,price_mode,discount_percent,discount_iqd,min_price_iqd,plus_price_iqd,max_qty_per_order)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(o.id, cfg.price_mode, cfg.discount_percent, cfg.discount_iqd, cfg.min_price_iqd, cfg.plus_price_iqd, cfg.max_qty_per_order);

  if (o.window) {
    const w = {
      starts_at: null as string | null,
      ends_at: null as string | null,
      required_tiers: '[]',
      offer_price_mode: '',
      offer_price_iqd: null as number | null,
      plus_price_iqd: null as number | null,
      locked_preview: 1,
      active: 1,
      ...o.window,
    };
    raw
      .prepare(
        `INSERT INTO offer_windows (subject_type,subject_id,id,starts_at,ends_at,required_tiers,
                                    offer_price_mode,offer_price_iqd,plus_price_iqd,locked_preview,active)
         VALUES ('product',?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        o.id,
        `ofw_${o.id}`,
        w.starts_at,
        w.ends_at,
        w.required_tiers,
        w.offer_price_mode,
        w.offer_price_iqd,
        w.plus_price_iqd,
        w.locked_preview,
        w.active
      );
  }
  if (o.limits) {
    raw
      .prepare('INSERT INTO offer_limits (subject_type,subject_id,max_per_user,max_global) VALUES (?,?,?,?)')
      .run('product', o.id, o.limits.max_per_user ?? null, o.limits.max_global ?? null);
  }

  (o.components ?? DEFAULT_COMPONENTS).forEach((k, i) => {
    raw
      .prepare(
        `INSERT INTO bundle_components (id,bundle_product_id,member_product_id,qty,optional,option_value_ids,color_id,
                                        customer_picks_option,customer_picks_color,sort)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        k.id,
        o.id,
        k.product,
        k.qty ?? 1,
        k.optional ? 1 : 0,
        JSON.stringify([...(k.optionValueIds ?? [])].sort()),
        k.colorId ?? '',
        k.picksOption ? 1 : 0,
        k.picksColor ? 1 : 0,
        i
      );
    for (const [j, ch] of (k.choices ?? []).entries()) {
      raw
        .prepare('INSERT INTO bundle_component_choices (component_id,dim,ref_id,sort) VALUES (?,?,?,?)')
        .run(k.id, ch.dim, ch.ref, j);
    }
  });
}

/** The checkout body every buy-path test posts, with a unique key per call so
 *  two orders in one test are two orders and not an idempotent replay. */
let seq = 0;
export const orderBody = (over: Record<string, unknown> = {}) => ({
  addressId: 'addr_b',
  deliveryMethodId: 'standard',
  paymentMethodId: 'cash',
  useWallet: false,
  usePoints: false,
  itemIds: [],
  idempotencyKey: `bundle-buy-path-key-${++seq}`,
  policyAcceptance: acceptedPolicies(),
  ...over,
});
