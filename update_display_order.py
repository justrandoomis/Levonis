import re

with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()

# Add display_order check in saveProduct
display_order_check = """
    try {
      const existing = await queryDb('SELECT id FROM products WHERE display_order = ? AND id != ? AND display_order != 0', [form.display_order, id]);
      if (existing.length > 0) {
        alert("The specified display order is already used by another product. Please choose a different order.");
        return;
      }
      
      const finalName = form.name || 'Unnamed Product';"""

content = content.replace("    try {\n      const finalName = form.name || 'Unnamed Product';", display_order_check)

with open('src/components/AdminProducts.tsx', 'w') as f:
    f.write(content)
