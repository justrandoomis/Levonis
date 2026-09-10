import re

with open('vite.config.ts', 'r') as f:
    content = f.read()

content = content.replace('      { find: \'@levonis/pricing\', replacement: \'/app/applet/packages/pricing/src/index.ts\' },', '      { find: \'@levonis/pricing\', replacement: \'/app/applet/packages/pricing/src\' },')

with open('vite.config.ts', 'w') as f:
    f.write(content)
