import re

with open('src/pages/Invest.tsx', 'r') as f:
    content = f.read()

# Make the app container max-w-md on desktop
content = content.replace(
    '<div className="w-full min-h-screen bg-black text-white font-sans flex flex-col" dir="ltr">',
    '<div className="w-full min-h-screen bg-black text-white font-sans flex flex-col md:max-w-md md:mx-auto md:border-x md:border-zinc-800 relative shadow-2xl" dir="ltr">'
)

# Fix bottom nav fixed width
content = content.replace(
    '<div className="fixed bottom-0 left-0 right-0 bg-black border-t border-zinc-800 flex justify-around items-center h-[70px] pb-safe z-50">',
    '<div className="fixed bottom-0 w-full md:w-[446px] bg-black border-t border-zinc-800 flex justify-around items-center h-[70px] pb-safe z-50">'
)

# Actually, md:max-w-md is 28rem = 448px, so w-[446px] is close. Let's do md:max-w-md
content = content.replace(
    '<div className="fixed bottom-0 w-full md:w-[446px] bg-black border-t border-zinc-800 flex justify-around items-center h-[70px] pb-safe z-50">',
    '<div className="fixed bottom-0 w-full md:max-w-md bg-black border-t border-zinc-800 flex justify-around items-center h-[70px] pb-safe z-50">'
)

# Adjust gold buttons contrast
content = content.replace('bg-[#e6a84f] text-white', 'bg-[#e6a84f] text-black')
content = content.replace('bg-[#e6a84f] hover:bg-[#d49942] text-white', 'bg-gradient-to-r from-[#e6a84f] to-[#f3c076] hover:opacity-90 text-black shadow-lg shadow-[#e6a84f]/20')

# Make the main header text larger and nicer
content = content.replace('<h1 className="text-4xl font-bold text-white mb-2">', '<h1 className="text-5xl font-extrabold tracking-tight text-white mb-3">')
content = content.replace('<h2 className="text-3xl font-bold text-white mb-2">', '<h2 className="text-4xl font-extrabold tracking-tight text-white mb-3">')

# Make the card glow a bit
content = content.replace('className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 mb-6"', 'className="bg-zinc-900/80 backdrop-blur-xl rounded-3xl border border-zinc-800 p-7 mb-6 shadow-xl"')
content = content.replace('className="flex justify-between items-center cursor-pointer p-4 hover:bg-black rounded-xl transition-colors border border-zinc-800"', 'className="flex justify-between items-center cursor-pointer p-5 hover:bg-black rounded-2xl transition-all hover:scale-[1.02] border border-zinc-800/50 hover:border-zinc-700 shadow-sm"')

with open('src/pages/Invest.tsx', 'w') as f:
    f.write(content)
