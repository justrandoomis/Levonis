with open('src/pages/Home.tsx', 'r') as f:
    lines = f.readlines()

new_lines = []
skip = False
for line in lines:
    if "Horizontal Scroll Bars" in line:
        skip = True
    if "{/* Sections Header */}" in line:
        skip = False
    
    if not skip:
        new_lines.append(line)

with open('src/pages/Home.tsx', 'w') as f:
    f.writelines(new_lines)
