const fs = require('fs');

let content = fs.readFileSync('src/pages/Wallet.tsx', 'utf8');

// Container Backgrounds
content = content.replace(/bg-\[#E5E5E7\]/g, 'bg-[#0A1F18]');
content = content.replace(/bg-white\/60/g, 'bg-[#0F2F25]/80');
content = content.replace(/bg-white\/50/g, 'bg-white/10');
content = content.replace(/border-white\/20/g, 'border-gold/20');
content = content.replace(/bg-white/g, 'bg-[#0F2F25]');
content = content.replace(/bg-zinc-50/g, 'bg-[#184235]');

// Texts
content = content.replace(/text-black/g, 'text-gold');
content = content.replace(/text-zinc-600/g, 'text-gold/70');
content = content.replace(/text-zinc-400/g, 'text-gold/60');
content = content.replace(/border-black\/5/g, 'border-gold/10');
content = content.replace(/bg-\[#F4F4F5\]/g, 'bg-[#184235]');

// Action Buttons
content = content.replace(/bg-\[#323234\]/g, 'bg-[#184235]');
content = content.replace(/hover:bg-\[#404042\]/g, 'hover:bg-[#205242]');
content = content.replace(/hover:bg-\[#D4D4D6\]/g, 'hover:bg-[#184235]');

// Dollar icon inside pill
content = content.replace(/<div className="bg-black text-white/g, '<div className="bg-gold text-[#0A1F18]');

// Notch 
content = content.replace(/bg-\[#3A3A3C\]/g, 'bg-gold/30');

// Plus inside "Send Again"
content = content.replace(/<div className="w-7 h-7 bg-black rounded-lg flex items-center justify-center text-white">/g, '<div className="w-7 h-7 bg-gold rounded-lg flex items-center justify-center text-[#0A1F18]">');

// ArrowDown inside "Your Income"
content = content.replace(/border-zinc-200/g, 'border-gold/20');

// Graph SVG
content = content.replace(/stroke="#59A846"/g, 'stroke="currentColor" className="text-gold"');
content = content.replace(/stopColor="#59A846"/g, 'stopColor="#ffd700"'); // gold hex

// Negative activity
content = content.replace(/<span className="text-gold font-bold text-\[17px\]">-\$15<\/span>/g, '<span className="text-[#B03142] font-bold text-[17px]">-$15</span>');

// Positive activity
content = content.replace(/<span className="text-gold font-bold text-\[17px\]">\+\$200<\/span>/g, '<span className="text-[#59A846] font-bold text-[17px]">+$200</span>');

// ArrowDownLeft icon container (Hannah Jones)
content = content.replace(/<div className="w-11 h-11 bg-black rounded-\[14px\] flex items-center justify-center">/g, '<div className="w-11 h-11 bg-gold rounded-[14px] flex items-center justify-center">');
content = content.replace(/<ArrowDownLeft className="w-5 h-5 text-white"/g, '<ArrowDownLeft className="w-5 h-5 text-[#0A1F18]"');

fs.writeFileSync('src/pages/Wallet.tsx', content);
