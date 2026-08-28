const fs = require('fs');
let code = fs.readFileSync('src/components/AdminProducts.tsx', 'utf8');

// 1. Description Images
code = code.replace(
  /<input type="text" value=\{img\} onChange=\{e => \{\s*const newImgs = \[\.\.\.\(form\.description_images \|\| \[\]\)\]; newImgs\[idx\] = e\.target\.value; setForm\(\{.*?\}\);\s*\}\} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white text-sm" \/>/g,
  '<div className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-zinc-400 text-sm truncate">{img}</div>'
);

// 2. Description Videos
code = code.replace(
  /<input type="text" value=\{vid\} onChange=\{e => \{\s*const newVids = \[\.\.\.\(form\.description_videos \|\| \[\]\)\]; newVids\[idx\] = e\.target\.value; setForm\(\{.*?\}\);\s*\}\} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-white text-sm" \/>/g,
  '<div className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-2 text-zinc-400 text-sm truncate">{vid}</div>'
);

// 3. Product Images
code = code.replace(
  /<input type="text" placeholder="Image URL" value=\{img\} onChange=\{e => \{\s*const newImgs = \[\.\.\.form\.images\];\s*newImgs\[idx\] = e\.target\.value;\s*setForm\(\{\.\.\.form, images: newImgs\}\);\s*\}\} className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-\[#6B46FF\] focus:outline-none" \/>/g,
  '<div className="flex-1 bg-zinc-900 border border-zinc-700 rounded p-3 text-zinc-400 truncate">{img || "Upload an image"}</div>'
);
// Remove the "Add Image URL" button entirely
code = code.replace(
  /<button onClick=\{\(\) => setForm\(\{\.\.\.form, images: \[\.\.\.form\.images, ''\]\}\)\} className="flex-1 flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-800 text-zinc-200 rounded border border-dashed border-zinc-600 transition-colors">\s*<Plus className="w-4 h-4" \/> Add Image URL\s*<\/button>/g,
  ''
);

// 4. Options
code = code.replace(
  /<input type="text" value=\{opt\.image \|\| ''\} onChange=\{e => \{\s*const newO = \[\.\.\.form\.options\]; newO\[idx\]\.image = e\.target\.value; setForm\(\{\.\.\.form, options: newO\}\);\s*\}\} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-\[#6B46FF\] focus:outline-none" \/>/g,
  '<div className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-zinc-400 truncate">{opt.image || "No image"}</div>'
);

// 5. Colors
code = code.replace(
  /<input type="text" value=\{col\.image \|\| ''\} onChange=\{e => \{\s*const newC = \[\.\.\.form\.colors\]; newC\[idx\]\.image = e\.target\.value; setForm\(\{\.\.\.form, colors: newC\}\);\s*\}\} className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-white focus:border-\[#6B46FF\] focus:outline-none" \/>/g,
  '<div className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-zinc-400 truncate">{col.image || "No image"}</div>'
);

fs.writeFileSync('src/components/AdminProducts.tsx', code);
