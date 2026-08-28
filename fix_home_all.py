import re

with open('src/pages/Home.tsx', 'r') as f:
    lines = f.readlines()

new_lines = []
skip = False
for line in lines:
    if "{/* Promo Banners Slider */}" in line:
        skip = True
    elif "{/* Quick Services - Minimalist grid */}" in line:
        skip = True
    elif "{/* Secondary Categories */}" in line:
        skip = True
    elif "{/* Promo Offers */}" in line:
        skip = True
    elif "{/* Sections Header */}" in line:
        skip = True
    
    if skip:
        if "{/* Discounted Products - Horizontal Scroll */}" in line:
            skip = False
            new_lines.append(line)
    else:
        new_lines.append(line)

with open('src/pages/Home.tsx', 'w') as f:
    f.writelines(new_lines)
