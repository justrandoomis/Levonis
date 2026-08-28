import re

with open('src/components/Counter.tsx', 'r') as f:
    content = f.read()

# Add decimalPlaces prop
content = re.sub(
    r"bottomGradientStyle\s*}:\s*{",
    "bottomGradientStyle,\n  decimalPlaces\n}: {",
    content
)

content = re.sub(
    r"bottomGradientStyle\?: React\.CSSProperties;",
    "bottomGradientStyle?: React.CSSProperties;\n  decimalPlaces?: number;",
    content
)

# Use decimalPlaces for computedPlaces
old_computed = "const computedPlaces = places || [...value.toString()].map((ch, i, a) => {"
new_computed = """const valueStr = typeof decimalPlaces === 'number' ? value.toFixed(decimalPlaces) : value.toString();
  const computedPlaces = places || [...valueStr].map((ch, i, a) => {"""
content = content.replace(old_computed, new_computed)

with open('src/components/Counter.tsx', 'w') as f:
    f.write(content)
