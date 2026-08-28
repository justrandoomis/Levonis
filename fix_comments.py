import re

for filename in ['src/pages/Chat.tsx', 'src/pages/Product.tsx', 'src/pages/Product.tsx.backup']:
    try:
        with open(filename, 'r') as f:
            content = f.read()
            
        content = re.sub(r"\s*// Dummy data matching the screenshot", "", content)
        content = re.sub(r"\s*// Dummy data for colors to match the UI precisely", "", content)
        
        with open(filename, 'w') as f:
            f.write(content)
    except FileNotFoundError:
        pass
