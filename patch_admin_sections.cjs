const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const target = `              <div className="grid gap-4">
                {MAIN_SECTIONS.map(s => (
                  <div key={s.id} className="flex items-center justify-between p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
                    <div>
                      <h3 className="text-white font-medium">{t(s.titleKey as any)}</h3>
                      <p className="text-sm text-zinc-500">ID: {s.id}</p>
                    </div>
                    <div className="flex gap-2">
                      <button className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"><Edit2 className="w-4 h-4" /></button>
                      <button className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
              </div>`;

const replacement = `              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {MAIN_SECTIONS.map(s => (
                  <div key={s.id} className="group bg-black/40 border border-zinc-800/80 rounded-xl p-5 hover:border-olive/30 transition-all hover:shadow-lg hover:shadow-olive/5">
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-10 h-10 rounded-lg bg-zinc-800/50 flex items-center justify-center border border-zinc-700/50 group-hover:bg-olive/10 group-hover:border-olive/20 transition-colors">
                        <LayoutList className="w-5 h-5 text-zinc-400 group-hover:text-gold transition-colors" />
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors border border-transparent hover:border-zinc-700" title="Edit">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent hover:border-red-500/20" title="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <h3 className="text-white font-bold text-lg mb-1">{t(s.titleKey as any)}</h3>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">ID</span>
                        <code className="text-xs text-zinc-400 bg-black/50 px-2 py-0.5 rounded border border-zinc-800/80 font-mono">{s.id}</code>
                      </div>
                    </div>
                  </div>
                ))}
              </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Admin.tsx', content);
