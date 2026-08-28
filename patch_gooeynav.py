import re

with open('src/pages/Subscription.tsx', 'r') as f:
    content = f.read()

old_nav = """            onChange={(index) => {
              if (index === 0) setActiveTab('plus');
              else {
                setActiveTab('pro');
                setSelectedDuration('1yr');
              }
            }}"""

new_nav = """            onChange={(index) => {
              if (index === 0) {
                setActiveTab('plus');
                setSelectedDuration('1yr');
              } else {
                setActiveTab('pro');
                setSelectedDuration('1yr');
              }
            }}"""

content = content.replace(old_nav, new_nav)

with open('src/pages/Subscription.tsx', 'w') as f:
    f.write(content)
