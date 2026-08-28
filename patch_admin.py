import sys

def main():
    with open('src/pages/Admin.tsx', 'r') as f:
        content = f.read()

    # Add DashboardLayout import if not present
    if "import DashboardLayout" not in content:
        content = content.replace("import AdminStoreSettings from '../components/AdminStoreSettings';", "import AdminStoreSettings from '../components/AdminStoreSettings';\nimport DashboardLayout from '../components/DashboardLayout';")

    # The block to replace starts at `return (` and ends at the very end of the file.
    # We will search for the return block and replace it.
    
    start_index = content.find('  return (\n    <div className="w-full h-full flex flex-col md:flex-row')
    
    if start_index == -1:
        print("Could not find start index")
        return
        
    replacement = """  const sidebarItems = [
    { id: 'wallet_requests', icon: Bell, label: 'Wallet Requests' },
    { id: 'products', icon: Package, label: t('adminProducts') },
    { id: 'sections', icon: LayoutList, label: t('adminSections') },
    { id: 'users', icon: Users, label: t('adminUsers') },
    { id: 'wallet_settings', icon: Wallet, label: 'Wallet Settings' },
    { id: 'store_settings', icon: Settings, label: 'Store Settings' }
  ];

  return (
    <DashboardLayout 
      title="ADMIN"
      sidebarItems={sidebarItems}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as any)}
    >
      <div className="max-w-[1200px] mx-auto bg-white/70 backdrop-blur-xl border border-white/60 rounded-3xl p-6 md:p-8 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.05)] text-slate-800">
        
        {activeTab === 'products' && (
          <AdminProducts />
        )}

        {activeTab === 'sections' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black text-slate-800">{t('adminSections')}</h2>
              <button className="flex items-center gap-2 bg-[#6B46FF] hover:bg-[#5A38E6] text-white px-5 py-2.5 rounded-full transition-all font-bold shadow-[0_4px_12px_rgba(107,70,255,0.4)] hover:scale-105">
                <Plus className="w-4 h-4" />
                Add Section
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {MAIN_SECTIONS.map(s => (
                <div key={s.id} className="group bg-white border border-slate-100 rounded-3xl p-6 hover:border-[#6B46FF]/30 transition-all hover:shadow-[0_10px_40px_-10px_rgba(107,70,255,0.15)] relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-[#6B46FF]/5 to-transparent rounded-bl-full pointer-events-none"></div>
                  
                  <div className="flex justify-between items-start mb-6">
                    <div className="w-12 h-12 rounded-2xl bg-[#F0F4FD] flex items-center justify-center border border-white group-hover:bg-[#6B46FF]/10 transition-colors shadow-inner">
                      <LayoutList className="w-5 h-5 text-slate-400 group-hover:text-[#6B46FF] transition-colors" />
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-2 text-slate-400 hover:text-[#6B46FF] hover:bg-[#6B46FF]/10 rounded-xl transition-colors" title="Edit">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button className="p-2 text-slate-400 hover:text-[#FF6B6B] hover:bg-[#FF6B6B]/10 rounded-xl transition-colors" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-slate-800 font-bold text-lg mb-1">{t(s.titleKey as any)}</h3>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">ID</span>
                      <code className="text-xs text-slate-500 bg-slate-50 px-2 py-0.5 rounded-lg border border-slate-100 font-mono">{s.id}</code>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black text-slate-800">{t('adminUsers')}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[600px]">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Name</th>
                    <th className="py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Email</th>
                    <th className="py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Role</th>
                    <th className="py-3 px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">Plan</th>
                  </tr>
                </thead>
                <tbody>
                  {allUsers.map((u, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                      <td className="py-4 px-4 font-bold text-slate-700">{u.name || u.username || 'N/A'}</td>
                      <td className="py-4 px-4 text-sm text-slate-500">{u.email}</td>
                      <td className="py-4 px-4">
                        <span className={`px-2 py-1 rounded-lg text-xs font-bold ${u.isAdmin ? 'bg-[#6B46FF]/10 text-[#6B46FF]' : 'bg-slate-100 text-slate-500'}`}>
                          {u.isAdmin ? 'Admin' : 'User'}
                        </span>
                      </td>
                      <td className="py-4 px-4">
                         <span className="text-xs font-bold text-slate-600 capitalize bg-slate-100 px-2 py-1 rounded-lg">{u.subscription_plan || 'free'}</span>
                      </td>
                    </tr>
                  ))}
                  {allUsers.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-400 text-sm">No users found</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'wallet_requests' && (
           <div>
             <div className="flex items-center gap-3 mb-6">
               <h2 className="text-2xl font-black text-slate-800">Wallet Requests</h2>
               {pendingCount > 0 && (
                 <span className="bg-[#FF6B6B] text-white px-3 py-1 rounded-full text-xs font-bold shadow-sm">{pendingCount} Pending</span>
               )}
             </div>
             
             <div className="space-y-4">
               {allTransactions.map(t => (
                 <div key={t.id} className="bg-white border border-slate-100 rounded-3xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm hover:shadow-md transition-shadow">
                   <div className="flex items-center gap-4">
                     <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-inner shrink-0 ${
                       t.type === 'deposit' ? 'bg-[#2CE59B]/10 border-[#2CE59B]/20' : 'bg-[#FF6B9E]/10 border-[#FF6B9E]/20'
                     }`}>
                       <Wallet className={`w-5 h-5 ${t.type === 'deposit' ? 'text-[#2CE59B]' : 'text-[#FF6B9E]'}`} />
                     </div>
                     <div>
                       <div className="flex items-center gap-2">
                         <h3 className="font-bold text-slate-800 capitalize text-lg">{t.type}</h3>
                         <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                           t.status === 'pending' ? 'bg-[#FFD166]/20 text-[#FFB703]' :
                           t.status === 'approved' ? 'bg-[#2CE59B]/20 text-[#06D6A0]' : 'bg-[#FF6B6B]/20 text-[#EF476F]'
                         }`}>
                           {t.status}
                         </span>
                       </div>
                       <div className="text-sm text-slate-500 font-medium">
                         User: <span className="text-slate-700">{t.email}</span> • Method: <span className="uppercase">{t.paymentMethod}</span>
                       </div>
                     </div>
                   </div>
                   
                   <div className="flex flex-col md:items-end gap-2 border-t md:border-t-0 md:border-l border-slate-100 pt-4 md:pt-0 md:pl-6">
                     <div className="text-xl font-black text-slate-800">
                       ${t.amount.toFixed(2)}
                     </div>
                     {t.status === 'pending' && (
                       <div className="flex gap-2">
                         <button 
                           onClick={() => handleApprove(t.id)}
                           disabled={!!loadingAction}
                           className="flex items-center gap-1 bg-[#2CE59B] hover:bg-[#06D6A0] text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-[0_4px_10px_rgba(44,229,155,0.4)] hover:scale-105 disabled:opacity-50"
                         >
                           <Check className="w-3 h-3" /> Approve
                         </button>
                         <button 
                           onClick={() => handleReject(t.id)}
                           disabled={!!loadingAction}
                           className="flex items-center gap-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-sm hover:scale-105 disabled:opacity-50"
                         >
                           <X className="w-3 h-3" /> Reject
                         </button>
                       </div>
                     )}
                   </div>
                 </div>
               ))}
               {allTransactions.length === 0 && (
                 <div className="text-center text-slate-400 py-12">No requests found</div>
               )}
             </div>
           </div>
        )}

        {activeTab === 'wallet_settings' && (
           <div className="space-y-8">
             <div className="flex justify-between items-center">
               <h2 className="text-2xl font-black text-slate-800">Wallet Settings</h2>
             </div>
             
             <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
               <h3 className="text-lg font-bold text-slate-800 mb-4">Exchange Rate (1 USD to IQD)</h3>
               <div className="flex items-center gap-4 max-w-sm">
                 <div className="flex-1 relative">
                   <input 
                     type="number" 
                     value={exchangeRate}
                     onChange={(e) => setExchangeRate(Number(e.target.value))}
                     className="w-full bg-[#F0F4FD] border-none text-slate-800 px-4 py-3 rounded-2xl font-bold focus:ring-2 focus:ring-[#6B46FF]/50"
                   />
                   <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">IQD</span>
                 </div>
               </div>
             </div>
             
             <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
               <h3 className="text-lg font-bold text-slate-800 mb-4">Ad Video Configuration</h3>
               <div className="flex flex-col gap-4 max-w-xl">
                 <label className="text-sm font-bold text-slate-500">Video URL (Direct link to mp4 or YouTube)</label>
                 <input 
                   type="text" 
                   value={adVideoUrl}
                   onChange={(e) => setAdVideoUrl(e.target.value)}
                   placeholder="e.g. https://www.w3schools.com/html/mov_bbb.mp4"
                   className="w-full bg-[#F0F4FD] border-none text-slate-800 px-4 py-3 rounded-2xl font-medium focus:ring-2 focus:ring-[#6B46FF]/50"
                 />
                 <div className="text-xs font-semibold text-slate-400 flex items-center gap-1">
                   <Check className="w-3 h-3 text-[#2CE59B]" /> Saved automatically
                 </div>
               </div>
             </div>
           </div>
        )}

        {activeTab === 'store_settings' && (
           <AdminStoreSettings />
        )}
      </div>
    </DashboardLayout>
  );
}
"""

    content = content[:start_index] + replacement
    
    with open('src/pages/Admin.tsx', 'w') as f:
        f.write(content)

if __name__ == "__main__":
    main()
