import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

# Remove Promo Banners Slider completely (since 'banners' is missing)
content = re.sub(r"\{\/\* Promo Banners Slider \*\/\}.*?\{\/\* Quick Services - Minimalist grid \*\/\}", "{/* Quick Services - Minimalist grid */}", content, flags=re.DOTALL)

# Remove Quick Services
content = re.sub(r"\{\/\* Quick Services - Minimalist grid \*\/\}.*?\{\/\* Secondary Categories \*\/\}", "{/* Secondary Categories */}", content, flags=re.DOTALL)

# Remove Secondary Categories
content = re.sub(r"\{\/\* Secondary Categories \*\/\}.*?\{\/\* Promo Offers \*\/\}", "{/* Promo Offers */}", content, flags=re.DOTALL)

# Remove Promo Offers
content = re.sub(r"\{\/\* Promo Offers \*\/\}.*?\{\/\* Sections Header \*\/\}", "{/* Sections Header */}", content, flags=re.DOTALL)

# Remove Sections Header and MAIN_SECTIONS
content = re.sub(r"\{\/\* Sections Header \*\/\}.*?\{\/\* Discounted Products - Horizontal Scroll \*\/\}", "{/* Discounted Products - Horizontal Scroll */}", content, flags=re.DOTALL)


with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
