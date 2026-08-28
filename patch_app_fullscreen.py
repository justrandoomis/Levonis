import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

# Update isFullScreenRoute logic
old_logic = "  const isFullScreenRoute = ['/admin', '/auth', '/points', '/settings', '/addresses', '/checkout', '/games', '/leaderboards'].includes(location.pathname);"
new_logic = "  const isFullScreenRoute = ['/admin', '/invest', '/admin/invest', '/auth', '/points', '/settings', '/addresses', '/checkout', '/games', '/leaderboards'].some(p => location.pathname === p || location.pathname.startsWith(p + '/'));"

content = content.replace(old_logic, new_logic)

with open('src/App.tsx', 'w') as f:
    f.write(content)
