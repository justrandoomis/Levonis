import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

old_chart = """  // Mock chart data
  const data = [
    { name: '1M', value: displayTotal * 0.8 },
    { name: '3M', value: displayTotal * 0.9 },
    { name: '6M', value: displayTotal * 0.95 },
    { name: '1Y', value: displayTotal },
  ];"""

new_chart = """  // Mock chart data starting from 0 as requested
  const data = [
    { name: '1M', value: 0 },
    { name: '3M', value: displayTotal * 0.24 },
    { name: '6M', value: displayTotal * 0.5 },
    { name: '1Y', value: displayTotal * 0.76 },
    { name: 'ALL', value: displayTotal },
  ];"""

content = content.replace(old_chart, new_chart)

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
