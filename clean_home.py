import re

with open('src/pages/Home.tsx', 'r') as f:
    content = f.read()

# Fix banners issue
content = re.sub(r"const displayBanners =.*?;", "const displayBanners: any[] = [];", content, flags=re.DOTALL)
content = re.sub(r"const nextSlide = \(\) => \{.*?\};", "const nextSlide = () => {};", content, flags=re.DOTALL)
content = re.sub(r"const prevSlide = \(\) => \{.*?\};", "const prevSlide = () => {};", content, flags=re.DOTALL)

# Remove the whole "Horizontal Scroll Bars" section
horizontal_scroll_regex = r"\{\/\* Horizontal Scroll Bars \(Services, Categories, Offers\) \*\/\}.*?\{\/\* Sections Header \*\/\}"
content = re.sub(horizontal_scroll_regex, "{/* Sections Header */}", content, flags=re.DOTALL)

with open('src/pages/Home.tsx', 'w') as f:
    f.write(content)
