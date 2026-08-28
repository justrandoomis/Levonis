const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const target = `                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="pb-3 px-4 font-medium">User</th>
                      <th className="pb-3 px-4 font-medium">Email</th>
                      <th className="pb-3 px-4 font-medium">Plan</th>
                      <th className="pb-3 px-4 font-medium">Status</th>
                      <th className="pb-3 px-4 font-medium">Card Number</th>
                      <th className="pb-3 px-4 font-medium">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allUsers.length === 0 && (
                      <tr><td colSpan={6} className="text-center py-8 text-zinc-500">No users found.</td></tr>
                    )}
                    {allUsers.map((u: any) => (
                      <tr key={u.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                        <td className="py-4 px-4">
                          <div className="font-medium text-white">{u.name}</div>
                          <div className="text-xs text-zinc-500">@{u.username}</div>
                        </td>
                        <td className="py-4 px-4 text-sm text-zinc-400">{u.email}</td>
                        <td className="py-4 px-4 text-sm uppercase font-bold text-gold">{u.subscription_plan || 'FREE'}</td>
                        <td className="py-4 px-4">
                          <span className={\`text-xs font-bold px-2 py-1 rounded-md \${u.subscription_status === 'active' ? 'bg-olive/20 text-olive' : 'bg-zinc-800 text-zinc-400'}\`}>
                            {u.subscription_status || 'inactive'}
                          </span>
                        </td>
                        <td className="py-4 px-4 text-sm font-mono text-zinc-300">{u.card_number || '-'}</td>
                        <td className="py-4 px-4 text-sm text-zinc-400">
                          {u.subscription_expiry ? new Date(u.subscription_expiry).toLocaleDateString() : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>`;

const replacement = `                <div className="grid gap-4">
                  {allUsers.length === 0 && (
                    <div className="text-center py-12 text-zinc-500 bg-black/20 rounded-xl border border-zinc-800/50">
                      No users found.
                    </div>
                  )}
                  {allUsers.map((u: any) => (
                    <div key={u.id} className="bg-black/40 border border-zinc-800/80 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-olive/30 transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-zinc-800/80 flex items-center justify-center text-lg font-bold text-gold border border-zinc-700/50">
                          {u.name?.charAt(0)?.toUpperCase() || 'U'}
                        </div>
                        <div className="flex flex-col">
                          <span className="font-bold text-white text-base">{u.name}</span>
                          <span className="text-sm text-zinc-400">{u.email}</span>
                          <span className="text-xs text-zinc-500">@{u.username}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-6 sm:gap-8">
                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Plan</span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm uppercase font-bold text-gold">{u.subscription_plan || 'FREE'}</span>
                            <span className={\`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase \${u.subscription_status === 'active' ? 'bg-olive/20 text-olive border border-olive/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700/50'}\`}>
                              {u.subscription_status || 'inactive'}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Card</span>
                          <span className="text-sm font-mono text-zinc-300">{u.card_number || 'N/A'}</span>
                        </div>

                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Expires</span>
                          <span className="text-sm text-zinc-400">{u.subscription_expiry ? new Date(u.subscription_expiry).toLocaleDateString() : 'N/A'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Admin.tsx', content);
