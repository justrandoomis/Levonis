with open('src/pages/Home.tsx', 'r') as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    new_lines.append(line)
    if "className=\"relative z-30 max-w-7xl mx-auto px-4 sm:px-10 py-12 bg-black rounded-t-[36px] -mt-10\"" in line:
        pass # wait, where did the file end?

