const fs = require('fs');

function fixColors(filename) {
    let code = fs.readFileSync(filename, 'utf8');

    code = code.replace(/bg-white\/20/g, 'bg-zinc-800/20');
    code = code.replace(/bg-white\/5/g, 'bg-zinc-800/50');
    code = code.replace(/bg-white/g, 'bg-zinc-900');
    code = code.replace(/text-slate-800/g, 'text-white');
    code = code.replace(/border-slate-100/g, 'border-zinc-800');
    code = code.replace(/border-slate-200\/50/g, 'border-zinc-800/50');
    code = code.replace(/border-slate-200/g, 'border-zinc-700');
    code = code.replace(/border-slate-300/g, 'border-zinc-600');
    code = code.replace(/border-slate-400/g, 'border-zinc-500');
    code = code.replace(/text-slate-400/g, 'text-zinc-500');
    code = code.replace(/text-slate-500/g, 'text-zinc-400');
    code = code.replace(/text-slate-600/g, 'text-zinc-300');
    code = code.replace(/text-slate-700/g, 'text-zinc-200');
    code = code.replace(/hover:bg-slate-50/g, 'hover:bg-zinc-800/50');
    code = code.replace(/hover:bg-slate-100/g, 'hover:bg-zinc-800');
    code = code.replace(/bg-slate-50/g, 'bg-zinc-800/30');
    code = code.replace(/bg-slate-100/g, 'bg-zinc-800');
    code = code.replace(/bg-\[#F0F4FD\]/g, 'bg-zinc-800');

    fs.writeFileSync(filename, code);
}

['src/components/AdminProducts.tsx', 'src/components/AdminStoreSettings.tsx'].forEach(file => {
    if (fs.existsSync(file)) {
        fixColors(file);
    }
});
