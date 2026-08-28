import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Global background and text
content = content.replace('bg-black text-white', 'bg-white text-zinc-900')

# Bottom Nav
content = content.replace('bg-black border-t border-zinc-800 flex justify-around', 'bg-white border-t border-zinc-200 flex justify-around')
content = content.replace('text-zinc-200', 'text-zinc-800')
content = content.replace('bg-zinc-800', 'bg-zinc-100')
content = content.replace('text-zinc-300', 'text-zinc-600')

# Text Colors
content = content.replace('text-white', 'text-zinc-900')
content = content.replace('border-zinc-800', 'border-zinc-200')
content = content.replace('bg-zinc-900', 'bg-white')

# Chart
content = content.replace('stroke="#333"', 'stroke="#e5e7eb"')
content = content.replace('stroke="#666"', 'stroke="#9ca3af"')
content = content.replace("backgroundColor: '#18181b'", "backgroundColor: '#ffffff'")
content = content.replace("border: '1px solid #27272a'", "border: '1px solid #e5e7eb'")
content = content.replace("stroke: '#18181b'", "stroke: '#ffffff'")

# Chart specific replacements for area
content = content.replace('<LineChart data={mockChartData}>', '<AreaChart data={mockChartData}>')
content = content.replace('</LineChart>', '</AreaChart>')
content = content.replace('<Line type="monotone" dataKey="value"', '<Area type="monotone" dataKey="value" fillOpacity={1} fill="url(#colorValue)"')
content = content.replace('</Line>', '</Area>')
# Add gradient defs
content = content.replace('<CartesianGrid', '<defs><linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#e6a84f" stopOpacity={0.3}/><stop offset="95%" stopColor="#e6a84f" stopOpacity={0}/></linearGradient></defs><CartesianGrid')

content = content.replace('import { LineChart, Line,', 'import { AreaChart, Area,')

# AnimatedCurrency gradientFrom
content = content.replace('gradientFrom="black"', 'gradientFrom="white"')
content = content.replace('gradientFrom="#18181b"', 'gradientFrom="white"')

# Invest Card Backgrounds
content = content.replace('bg-black p-4 rounded-xl border border-zinc-200', 'bg-white p-4 rounded-xl border border-zinc-200 shadow-sm')

# Progress Bar
content = content.replace('w-full bg-zinc-100 h-2', 'w-full bg-zinc-200 h-2')

# Chat bubbles
content = content.replace("m.sender === 'user' ? 'bg-[#e6a84f] text-zinc-900 self-end rounded-tr-sm font-medium' : 'bg-zinc-100 text-zinc-900 self-start rounded-tl-sm'", "m.sender === 'user' ? 'bg-zinc-800 text-white self-end rounded-tr-sm font-medium' : 'bg-zinc-100 text-zinc-900 self-start rounded-tl-sm border border-zinc-200'")

# Chat Input
content = content.replace('bg-zinc-100 rounded-full px-4 py-2', 'bg-white border border-zinc-300 rounded-full px-4 py-2')
content = content.replace('text-zinc-900', 'text-zinc-900')
# Fix send icon color inside chat input
content = content.replace('<button onClick={send} className="ml-2 text-zinc-900">', '<button onClick={send} className="ml-2 text-zinc-900">')

# Invest Card Title text
content = content.replace('text-lg text-zinc-900', 'text-lg text-zinc-900')

# Re-fix the "text-white" in button that might have been changed
content = content.replace('text-zinc-900 font-bold py-4', 'text-white font-bold py-4')
content = content.replace('text-zinc-900 self-end', 'text-white self-end')

# Make top-bar buttons in profile have right colors
content = content.replace("bg-[#e6a84f] text-zinc-900 font-bold", "bg-[#e6a84f] text-white font-bold")

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
