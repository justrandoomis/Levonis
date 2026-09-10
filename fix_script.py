import re

with open('scripts/set-deploy-ids.mjs', 'r') as f:
    content = f.read()

content = content.replace("const path = new URL('../services/gateway/wrangler.jsonc', import.meta.url);", "const path = new URL('../worker/wrangler.jsonc', import.meta.url);")

with open('scripts/set-deploy-ids.mjs', 'w') as f:
    f.write(content)
