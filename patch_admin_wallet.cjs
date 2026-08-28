const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const target = `          {activeTab === 'wallet_settings' && (
            <div>
              
              
                
              <div className="bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800 mb-8">
                <h3 className="text-lg font-bold text-gold mb-4">Rewards Settings</h3>
                <div className="flex flex-col gap-2">
                  <label className="text-sm text-zinc-400 font-medium">Ad Video URL (MP4 format)</label>
                  <div className="flex items-center gap-2">
                    <input 
                      type="text"
                      placeholder="https://example.com/video.mp4"
                      value={adVideoUrl}
                      onChange={(e) => setAdVideoUrl(e.target.value)}
                      className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-olive flex-1"
                    />
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">Users will watch this video to earn points in the Rewards section.</p>
                </div>
              </div>
              <div className="bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800 mb-8">
                <h3 className="text-lg font-bold text-gold mb-4">Currency Settings</h3>
                <div className="flex flex-col gap-2">
                  <label className="text-sm text-zinc-400 font-medium">Exchange Rate (IQD per 1 USD)</label>
                  <div className="flex items-center gap-2">
                    <input 
                      type="number"
                      value={exchangeRate}
                      onChange={(e) => setExchangeRate(Number(e.target.value))}
                      className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:border-olive flex-1"
                    />
                    <span className="text-zinc-500 font-bold">IQD</span>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">This rate is used to convert USD balances to IQD.</p>
                </div>
              </div>
              
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold text-gold">Payment Methods</h2>
              </div>
              <div className="space-y-4 max-w-xl">
                {paymentMethods.map(method => (
                  <div key={method.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                    <div className="mb-3 flex flex-col gap-1">
                      <label className="text-xs text-zinc-500 font-bold uppercase">Method Name</label>
                      <input 
                        type="text" 
                        value={method.name} 
                        onChange={(e) => handleUpdatePaymentMethod(method.id, 'name', e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white focus:outline-none focus:border-olive"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500 font-bold uppercase">Account Details (Phone/Card)</label>
                      <input 
                        type="text" 
                        value={method.details} 
                        onChange={(e) => handleUpdatePaymentMethod(method.id, 'details', e.target.value)}
                        className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white font-mono focus:outline-none focus:border-olive"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}`;

const replacement = `          {activeTab === 'wallet_settings' && (
            <div className="space-y-8">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="bg-black/40 p-6 rounded-2xl border border-zinc-800/80 hover:border-olive/30 transition-colors shadow-lg">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-olive/10 flex items-center justify-center border border-olive/20">
                      <Wallet className="w-5 h-5 text-gold" />
                    </div>
                    <h3 className="text-lg font-bold text-gold tracking-tight">Rewards Settings</h3>
                  </div>
                  <div className="flex flex-col gap-3">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Ad Video URL (MP4 format)</label>
                    <input 
                      type="text"
                      placeholder="https://example.com/video.mp4"
                      value={adVideoUrl}
                      onChange={(e) => setAdVideoUrl(e.target.value)}
                      className="bg-black/50 border border-zinc-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-olive focus:ring-1 focus:ring-olive/50 transition-all font-mono text-sm w-full"
                    />
                    <p className="text-xs text-zinc-500 leading-relaxed">Users will watch this video to earn points in the Rewards section. Make sure it's a direct MP4 link.</p>
                  </div>
                </div>

                <div className="bg-black/40 p-6 rounded-2xl border border-zinc-800/80 hover:border-olive/30 transition-colors shadow-lg">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-olive/10 flex items-center justify-center border border-olive/20">
                      <Wallet className="w-5 h-5 text-gold" />
                    </div>
                    <h3 className="text-lg font-bold text-gold tracking-tight">Currency Settings</h3>
                  </div>
                  <div className="flex flex-col gap-3">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Exchange Rate (IQD per 1 USD)</label>
                    <div className="relative">
                      <input 
                        type="number"
                        value={exchangeRate}
                        onChange={(e) => setExchangeRate(Number(e.target.value))}
                        className="bg-black/50 border border-zinc-800 rounded-xl pl-4 pr-16 py-3 text-white focus:outline-none focus:border-olive focus:ring-1 focus:ring-olive/50 transition-all font-mono text-lg w-full"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-bold">IQD</span>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed">This rate is used to convert USD balances to IQD across the application.</p>
                  </div>
                </div>
              </div>
              
              <div>
                <div className="flex items-center gap-3 mb-6">
                  <h2 className="text-xl font-bold text-gold tracking-tight">Payment Methods</h2>
                  <div className="h-px flex-1 bg-zinc-800/50 ml-4"></div>
                </div>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {paymentMethods.map(method => (
                    <div key={method.id} className="bg-black/40 border border-zinc-800/80 rounded-xl p-5 hover:border-olive/30 transition-colors shadow-lg group">
                      <div className="mb-4 flex flex-col gap-2">
                        <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Method Name</label>
                        <input 
                          type="text" 
                          value={method.name} 
                          onChange={(e) => handleUpdatePaymentMethod(method.id, 'name', e.target.value)}
                          className="bg-black/50 border border-zinc-800/80 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-olive focus:bg-zinc-900/50 transition-all font-medium group-hover:border-zinc-700"
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Account Details (Phone/Card)</label>
                        <input 
                          type="text" 
                          value={method.details} 
                          onChange={(e) => handleUpdatePaymentMethod(method.id, 'details', e.target.value)}
                          className="bg-black/50 border border-zinc-800/80 rounded-lg px-3 py-2 text-gold focus:outline-none focus:border-olive focus:bg-zinc-900/50 transition-all font-mono text-sm group-hover:border-zinc-700"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Admin.tsx', content);
