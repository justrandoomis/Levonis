import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

content = re.sub(
    r"const displayBanners = customAds\.length > 0\s*\?.*?: banners;", 
    "const displayBanners: any[] = [];", 
    content, 
    flags=re.DOTALL
)

with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
