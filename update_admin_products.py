import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

# Update initialForm
initial_form_replacement = """const initialForm = {
  id: '',
  name: '',
  name_ar: '',
  slug: '',
  description: '',
  description_ar: '',
  images: [''],
  options: [],
  colors: [],
  selling_type: 'direct_sale',
  shipping_methods: [],
  base_price: 0,
  original_price: 0,
  product_cost: 0,
  membership_prices: { plus: 0, pro: 0 },
  payment_options: ['full'],
  subcategory_id: '',
  display_order: 0,
  is_featured: false,
  specifications: [],
  brand: '',
  labels: [],
  hashtags: [],
  features: [],
  algorithm_tags: [],
  description_images: [],
  description_videos: [],
  stores: [],
  categories: '',
  warranty_plans: [],
  how_to_use: ''
};"""

content = re.sub(r'const initialForm = \{.*?\};', initial_form_replacement, content, flags=re.DOTALL)

# Update SQL Insert
sql_insert = """INSERT INTO products (id, name, name_ar, slug, description, description_ar, images, options, colors, selling_type, shipping_methods, base_price, original_price, product_cost, membership_prices, payment_options, subcategory_id, display_order, is_featured, specifications, brand, labels, hashtags, algorithm_tags, features, description_images, description_videos, stores, categories, warranty_plans, how_to_use)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, name_ar=excluded.name_ar, slug=excluded.slug, description=excluded.description, description_ar=excluded.description_ar, images=excluded.images,
          options=excluded.options, colors=excluded.colors, selling_type=excluded.selling_type, shipping_methods=excluded.shipping_methods,
          base_price=excluded.base_price, original_price=excluded.original_price, product_cost=excluded.product_cost,
          membership_prices=excluded.membership_prices, payment_options=excluded.payment_options, subcategory_id=excluded.subcategory_id,
          display_order=excluded.display_order, is_featured=excluded.is_featured, specifications=excluded.specifications,
          brand=excluded.brand, labels=excluded.labels, hashtags=excluded.hashtags, algorithm_tags=excluded.algorithm_tags, features=excluded.features, description_images=excluded.description_images, description_videos=excluded.description_videos, stores=excluded.stores, categories=excluded.categories, warranty_plans=excluded.warranty_plans, how_to_use=excluded.how_to_use"""

content = re.sub(r'INSERT INTO products .*?categories=excluded\.categories', sql_insert, content, flags=re.DOTALL)

# Update SQL values array
sql_values = """JSON.stringify(form.stores), form.categories, JSON.stringify(form.warranty_plans), form.how_to_use"""
content = re.sub(r'JSON\.stringify\(form\.stores\),\s*form\.categories', sql_values, content)

# Update openEditor
open_editor_addition = """
        stores: JSON.parse(prod.stores || '[]'),
        categories: prod.categories || '',
        warranty_plans: JSON.parse(prod.warranty_plans || '[]'),
        how_to_use: prod.how_to_use || ''
"""
content = re.sub(r'stores:\s*JSON\.parse\(prod\.stores\s*\|\|\s*\'\[\]\'\),\s*categories:\s*prod\.categories\s*\|\|\s*\'\'', open_editor_addition, content)

# Remove original_price from auto extract
extract_replacement = """setForm(prev => ({
                  ...prev,
                  name: data.product.name || prev.name,
                  name_ar: '', // let user translate or type
                  description: data.product.description || prev.description,
                  images: data.product.images.length > 0 ? data.product.images : prev.images
                }));"""
content = re.sub(r'setForm\(prev => \(\{[\s\S]*?original_price:[^\n]*\n\s*\}\)\);', extract_replacement, content)

with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)

