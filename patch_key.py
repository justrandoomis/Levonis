import re

with open('src/pages/Subscription.tsx', 'r') as f:
    content = f.read()

old_gallery = """            <CircularGallery
              bend={3}
              textColor="#ffffff"
              borderRadius={0.1}"""

new_gallery = """            <CircularGallery
              key={activeTab}
              bend={3}
              textColor="#ffffff"
              borderRadius={0.1}"""

content = content.replace(old_gallery, new_gallery)

old_nav = """            onChange={(index) => {
              if (index === 0) {
                setActiveTab('plus');
                setSelectedDuration('1yr');
              } else {
                setActiveTab('pro');
                setSelectedDuration('1yr');
              }
            }}"""

new_nav = """            onChange={(index) => {
              if (index === 0) {
                setActiveTab('plus');
                setSelectedDuration(plans.plus[0].id);
              } else {
                setActiveTab('pro');
                setSelectedDuration(plans.pro[0].id);
              }
            }}"""
content = content.replace(old_nav, new_nav)

with open('src/pages/Subscription.tsx', 'w') as f:
    f.write(content)
