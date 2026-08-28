const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

// Wallet Requests Table Replace
const walletRequestsTarget = `                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="pb-3 px-4 font-medium">User</th>
                      <th className="pb-3 px-4 font-medium">Date</th>
                      <th className="pb-3 px-4 font-medium">Type</th>
                      <th className="pb-3 px-4 font-medium">Account</th>
                      <th className="pb-3 px-4 font-medium">Amount</th>
                      <th className="pb-3 px-4 font-medium">Receipt</th>
                      <th className="pb-3 px-4 font-medium">Status</th>
                      <th className="pb-3 px-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allTransactions.length === 0 && (
                      <tr><td colSpan={8} className="text-center py-8 text-zinc-500">No requests found.</td></tr>
                    )}
                    {allTransactions.map(tx => (
                      <tr key={tx.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                        <td className="py-4 px-4 text-sm text-white">{tx.email || 'Unknown'}</td>
                        <td className="py-4 px-4 text-sm text-zinc-400">{new Date(tx.date).toLocaleString()}</td>
                        <td className="py-4 px-4 capitalize font-medium text-white">{tx.type}</td>
                        <td className="py-4 px-4 text-zinc-300 font-mono text-sm">{tx.accountNumber || '-'}</td>
                        <td className="py-4 px-4 text-gold font-bold">\${tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-zinc-500 text-xs ml-1">({(tx.amount * exchangeRate).toLocaleString('en-US')} IQD)</span></td>
                        <td className="py-4 px-4">
                          {tx.receiptUrl ? (
                            <a href={tx.receiptUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline text-sm">View Receipt</a>
                          ) : (
                            <span className="text-zinc-600 text-sm">None</span>
                          )}
                        </td>
                        <td className="py-4 px-4">
                          <span className={\`px-2 py-1 rounded text-xs font-bold \${
                            tx.status === 'pending' ? 'bg-yellow-500/20 text-yellow-500' :
                            tx.status === 'approved' ? 'bg-green-500/20 text-green-500' :
                            'bg-red-500/20 text-red-500'
                          }\`}>
                            {tx.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-4 px-4">
                          {tx.status === 'pending' ? (
                            <div className="flex justify-end gap-2">
                              <button disabled={loadingAction !== null} onClick={() => handleApprove(tx.id)} className="p-2 text-green-500 hover:bg-green-500/10 rounded transition-colors" title="Approve">
                                {loadingAction === \`approve-\${tx.id}\` ? <div className="w-5 h-5 border-2 border-green-500/20 border-t-green-500 rounded-full animate-spin" /> : <Check className="w-5 h-5" />}
                              </button>
                              <button disabled={loadingAction !== null} onClick={() => handleReject(tx.id)} className="p-2 text-red-500 hover:bg-red-500/10 rounded transition-colors" title="Reject">
                                {loadingAction === \`reject-\${tx.id}\` ? <div className="w-5 h-5 border-2 border-red-500/20 border-t-red-500 rounded-full animate-spin" /> : <X className="w-5 h-5" />}
                              </button>
                            </div>
                          ) : (
                            <div className="text-right text-sm text-zinc-500">{tx.adminNote || '-'}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>`;

const walletRequestsNew = `                <div className="grid gap-4">
                  {allTransactions.length === 0 && (
                    <div className="text-center py-12 text-zinc-500 bg-black/20 rounded-xl border border-zinc-800/50">
                      No wallet requests found.
                    </div>
                  )}
                  {allTransactions.map(tx => (
                    <div key={tx.id} className="bg-black/40 border border-zinc-800/80 rounded-xl p-4 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-6 hover:border-olive/30 transition-colors">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-8 flex-1">
                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">User</span>
                          <span className="text-sm font-medium text-white">{tx.email || 'Unknown'}</span>
                          <span className="text-xs text-zinc-500 mt-0.5">{new Date(tx.date).toLocaleString()}</span>
                        </div>
                        
                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Transaction</span>
                          <div className="flex items-center gap-2">
                            <span className="capitalize text-sm font-bold text-white">{tx.type}</span>
                            <span className={\`px-2 py-0.5 rounded text-[10px] font-bold uppercase \${
                              tx.status === 'pending' ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/20' :
                              tx.status === 'approved' ? 'bg-green-500/20 text-green-500 border border-green-500/20' :
                              'bg-red-500/20 text-red-500 border border-red-500/20'
                            }\`}>
                              {tx.status}
                            </span>
                          </div>
                          {tx.accountNumber && (
                            <span className="text-xs text-zinc-400 font-mono mt-1 pr-4">{tx.accountNumber}</span>
                          )}
                        </div>

                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Amount</span>
                          <span className="text-gold font-bold text-lg">\${tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          <span className="text-xs font-medium text-zinc-500">{(tx.amount * exchangeRate).toLocaleString('en-US')} IQD</span>
                        </div>

                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Receipt</span>
                          {tx.receiptUrl ? (
                            <a href={tx.receiptUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors flex items-center gap-1">
                              View File
                            </a>
                          ) : (
                            <span className="text-zinc-600 text-sm">None attached</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-3 lg:border-l lg:border-zinc-800 lg:pl-6">
                        {tx.status === 'pending' ? (
                          <>
                            <button disabled={loadingAction !== null} onClick={() => handleReject(tx.id)} className="px-4 py-2 text-sm font-bold text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors flex items-center gap-2">
                              {loadingAction === \`reject-\${tx.id}\` ? <div className="w-4 h-4 border-2 border-red-500/20 border-t-red-500 rounded-full animate-spin" /> : <X className="w-4 h-4" />}
                              Reject
                            </button>
                            <button disabled={loadingAction !== null} onClick={() => handleApprove(tx.id)} className="px-4 py-2 text-sm font-bold text-green-400 bg-green-500/10 hover:bg-green-500/20 rounded-lg transition-colors flex items-center gap-2">
                              {loadingAction === \`approve-\${tx.id}\` ? <div className="w-4 h-4 border-2 border-green-500/20 border-t-green-500 rounded-full animate-spin" /> : <Check className="w-4 h-4" />}
                              Approve
                            </button>
                          </>
                        ) : (
                          <div className="text-right flex flex-col">
                            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">Admin Note</span>
                            <span className="text-sm text-zinc-400">{tx.adminNote || 'No note provided'}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>`;

content = content.replace(walletRequestsTarget, walletRequestsNew);

fs.writeFileSync('src/pages/Admin.tsx', content);
