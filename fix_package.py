import re

with open('package.json', 'r') as f:
    content = f.read()

content = content.replace('"deploy:staging": "echo "deploy" --env staging && wrangler deploy --env staging",', '"deploy:staging": "node scripts/set-deploy-ids.mjs --env staging && wrangler deploy --env staging",')
content = content.replace('"deploy:production": "echo "deploy" --env production && wrangler deploy --env=\\"\\"",', '"deploy:production": "node scripts/set-deploy-ids.mjs --env production && wrangler deploy --env=\\"\\"",')

with open('package.json', 'w') as f:
    f.write(content)
