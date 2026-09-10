import re

with open('src/pages/CommunityStorePage.tsx', 'r') as f:
    content = f.read()

content = content.replace('setProfileProducts((d.products ?? []) as unknown as MerchantProduct[]);', 'setProfileProducts((d.products ?? []) as unknown as Record<string, unknown>[]);')
content = content.replace('useState<MerchantProduct[] | null>(null);', 'useState<Record<string, unknown>[] | null>(null);')

with open('src/pages/CommunityStorePage.tsx', 'w') as f:
    f.write(content)

