import { test } from 'node:test';
import { projectPublic } from '../../worker/lib/productModel';

const doc = {
  id: 'p1', slug: 's', status: 'active', name_ar: '', name_en: '', name_ckb: '',
  description_ar: '', description_en: '', description_ckb: '',
  price_iqd: 1, pro_price_iqd: null, prime_price_iqd: null, composition: '',
  selling_type: 'direct_sale', sale_types: ['direct_sale', 'pre_order'],
  preorder_transports: [], direct_surcharge_iqd: 0, stock: 4, low_stock_threshold: null,
  brand_id: '', category_id: '', sub_category_id: '', template_family: '', sku: '',
  spec_fields: {}, media: [], spec_groups: [], labels: [], warranty_plans: [],
  warranty_base_months: null, delivery_options: [], content_blocks: [], is_featured: false,
  display_order: 0, payment_options: [], hashtags: [], how_to_use: '', usage_guide: null,
  created_at: '', colors: [],
  options: [{
    id: 'ov1', name_ar: '', name_en: 'A1 Combo', name_ckb: '', image: '', order: 0, active: true,
    regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 111,
    cost_adjust_iqd: 222, stock: 4,
    fulfillments: [{
      fulfillment_type: 'pre_order', enabled: true, capacity: null,
      cost_iqd: 999, cost_adjust_iqd: 888,
      transports: [{ method: 'land', enabled: true, surcharge_iqd: 50000, capacity: null, cost_iqd: 777 }],
    }],
  }],
} as never;

test('projectPublic option shape', () => {
  const out = projectPublic(doc) as Record<string, unknown>;
  console.log(JSON.stringify((out.options as unknown[])[0], null, 2));
});
