import re

with open('src/pages/Product.tsx', 'r') as f:
    content = f.read()

# Replace dummyColors definition
content = re.sub(
    r"\s*// Dummy data for colors to match the UI precisely.*?const dummyColors = \[.*?\];",
    """
  let productColors: any[] = [];
  try {
    if (product && product.colors) {
      productColors = typeof product.colors === 'string' ? JSON.parse(product.colors) : product.colors;
    }
  } catch (e) {
    console.error('Failed to parse colors', e);
  }
""",
    content,
    flags=re.DOTALL
)

# Replace usage of dummyColors
content = content.replace("dummyColors.map", "productColors.map")

with open('src/pages/Product.tsx', 'w') as f:
    f.write(content)
