import re

with open('src/pages/Warranty.tsx', 'r') as f:
    content = f.read()

content = content.replace('d.serial_number !== device.serial_number', 'd.unit_id !== device.unit_id')
content = content.replace('key={device.serial_number}', 'key={device.unit_id}')

with open('src/pages/Warranty.tsx', 'w') as f:
    f.write(content)

