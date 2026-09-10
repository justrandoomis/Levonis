import re

with open('src/pages/Warranty.tsx', 'r') as f:
    content = f.read()

content = content.replace('d.id !== device.id', 'd.serial_number !== device.serial_number')
content = content.replace('key={device.id}', 'key={device.serial_number}')

with open('src/pages/Warranty.tsx', 'w') as f:
    f.write(content)

