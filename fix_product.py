import re

with open('src/pages/Product.tsx', 'r') as f:
    content = f.read()

content = content.replace("import { optionFulfillmentTypes, getModelStock, getModelLeadTime } from '@levonis/pricing';", "import { optionFulfillmentTypes, getModelStock, getModelLeadTime } from '@levonis/pricing/availability';")

with open('src/pages/Product.tsx', 'w') as f:
    f.write(content)
