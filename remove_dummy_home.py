import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

# Remove imports
content = re.sub(r"import { DUMMY_PRODUCTS.*? } from '\.\./data';\n", "", content)
content = re.sub(r"import LogoLoop from '\.\./components/LogoLoop';\n", "", content)

# Remove static arrays
content = re.sub(r"const TOP_BRANDS = \[.*?\];\n", "", content, flags=re.DOTALL)
content = re.sub(r"const SERVICES = \[.*?\];\n", "", content, flags=re.DOTALL)
content = re.sub(r"const SECONDARY_CATEGORIES = \[.*?\];\n", "", content, flags=re.DOTALL)
content = re.sub(r"const PROMO_OFFERS = \[.*?\];\n", "", content, flags=re.DOTALL)
content = re.sub(r"let banners = \[.*?\];\n", "", content, flags=re.DOTALL)

# Remove references to DUMMY_PRODUCTS in fetch
content = re.sub(r"setDiscountedProducts\(discounted && discounted\.length > 0 \? discounted : DUMMY_PRODUCTS\.slice\(0, 10\)\);", "setDiscountedProducts(discounted || []);", content)
content = re.sub(r"setNewProducts\(newest && newest\.length > 0 \? newest : DUMMY_PRODUCTS\.slice\(0, 20\)\);", "setNewProducts(newest || []);", content)
content = re.sub(r"setDiscountedProducts\(DUMMY_PRODUCTS\.slice\(0, 10\)\);", "setDiscountedProducts([]);", content)
content = re.sub(r"setNewProducts\(DUMMY_PRODUCTS\.slice\(0, 20\)\);", "setNewProducts([]);", content)

# Remove the sections from JSX
# MAIN_SECTIONS and SUB_SECTIONS are imported from data.ts
content = re.sub(r"\{MAIN_SECTIONS\.map.*?\}\)\}\n\s*\}\)", "", content, flags=re.DOTALL)

with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
