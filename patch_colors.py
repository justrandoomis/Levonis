import sys
import glob

def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Dark to light mappings
    replacements = [
        ('bg-black/40', 'bg-white'),
        ('bg-black/50', 'bg-slate-50'),
        ('bg-zinc-900/50', 'bg-slate-100'),
        ('bg-zinc-800/80', 'bg-slate-200'),
        ('bg-zinc-800/50', 'bg-slate-100'),
        ('border-zinc-800/80', 'border-slate-200'),
        ('border-zinc-800', 'border-slate-200'),
        ('border-zinc-700', 'border-slate-300'),
        ('text-white', 'text-slate-800'),
        ('text-zinc-400', 'text-slate-500'),
        ('text-zinc-500', 'text-slate-400'),
        ('text-gold', 'text-slate-800'),
        ('hover:bg-zinc-800/50', 'hover:bg-slate-200'),
        ('hover:bg-zinc-800', 'hover:bg-slate-100'),
        ('hover:text-white', 'hover:text-slate-900'),
        ('bg-black', 'bg-white'),
        ('text-zinc-300', 'text-slate-700'),
        ('bg-olive', 'bg-[#6B46FF]'),
        ('bg-olive-light', 'bg-[#5A38E6]'),
        ('hover:bg-olive-light', 'hover:bg-[#5A38E6]'),
        ('hover:bg-olive/90', 'hover:bg-[#5A38E6]'),
        ('hover:border-olive', 'hover:border-[#6B46FF]'),
        ('focus:border-olive', 'focus:border-[#6B46FF]'),
        ('focus:ring-olive/50', 'focus:ring-[#6B46FF]/50'),
        ('bg-olive/10', 'bg-[#6B46FF]/10'),
        ('bg-olive/20', 'bg-[#6B46FF]/20'),
        ('text-olive', 'text-[#6B46FF]'),
    ]

    for old, new in replacements:
        content = content.replace(old, new)
        
    # Re-apply text-white for primary buttons where we just replaced text-white -> text-slate-800 but we want them to stay white on purple
    content = content.replace('bg-[#6B46FF] text-slate-800', 'bg-[#6B46FF] text-white')
    content = content.replace('bg-[#6B46FF]/10 text-slate-800', 'bg-[#6B46FF]/10 text-[#6B46FF]')

    with open(filepath, 'w') as f:
        f.write(content)
        
patch_file('src/components/AdminProducts.tsx')
patch_file('src/components/AdminStoreSettings.tsx')
print("Patched colors")
