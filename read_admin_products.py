import re
with open('src/components/AdminProducts.tsx', 'r') as f:
    content = f.read()
    
    # Just to get an idea of the structure again
    print("Initial Form:", re.search(r'const initialForm = \{.*?\};', content, re.DOTALL).group(0))
