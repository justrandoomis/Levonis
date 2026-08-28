const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const target = `  return (
    <div className="w-full text-zinc-300 pb-24 overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-10 py-10">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="w-8 h-8 text-olive" />
          <h1 className="text-3xl font-light text-gold tracking-tight">{t('adminDashboard')}</h1>
        </div>

        <div className="flex flex-wrap gap-4 mb-8 border-b border-zinc-800 pb-4">
          <button 
            onClick={() => setActiveTab('products')}
            className={\`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors \${activeTab === 'products' ? 'bg-olive/20 text-gold border border-olive/30 shadow-sm' : 'text-zinc-500 hover:bg-olive/10 hover:text-gold'}\`}
          >
            <Package className="w-5 h-5" />
            {t('adminProducts')}
          </button>
          <button 
            onClick={() => setActiveTab('sections')}
            className={\`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors \${activeTab === 'sections' ? 'bg-olive/20 text-gold border border-olive/30 shadow-sm' : 'text-zinc-500 hover:bg-olive/10 hover:text-gold'}\`}
          >
            <LayoutList className="w-5 h-5" />
            {t('adminSections')}
          </button>
          <button 
            onClick={() => setActiveTab('users')}
            className={\`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors \${activeTab === 'users' ? 'bg-olive/20 text-gold border border-olive/30 shadow-sm' : 'text-zinc-500 hover:bg-olive/10 hover:text-gold'}\`}
          >
            <Users className="w-5 h-5" />
            {t('adminUsers')}
          </button>
          <button 
            onClick={() => setActiveTab('wallet_requests')}
            className={\`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors relative \${activeTab === 'wallet_requests' ? 'bg-olive/20 text-gold border border-olive/30 shadow-sm' : 'text-zinc-500 hover:bg-olive/10 hover:text-gold'}\`}
          >
            <Bell className="w-5 h-5" />
            Wallet Requests
            {pendingCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full">
                {pendingCount}
              </span>
            )}
          </button>
          <button 
            onClick={() => setActiveTab('wallet_settings')}
            className={\`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors \${activeTab === 'wallet_settings' ? 'bg-olive/20 text-gold border border-olive/30 shadow-sm' : 'text-zinc-500 hover:bg-olive/10 hover:text-gold'}\`}
          >
            <Wallet className="w-5 h-5" />
            Wallet Settings
          </button>
        </div>

        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">`;

const replacement = `  const NavButton = ({ id, icon, label, badge = 0 }: { id: string, icon: React.ReactNode, label: string, badge?: number }) => {
    const isActive = activeTab === id;
    return (
      <button 
        onClick={() => setActiveTab(id as any)}
        className={\`flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all relative whitespace-nowrap \${
          isActive 
            ? 'bg-olive/10 text-gold border border-olive/20 shadow-sm' 
            : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 border border-transparent'
        }\`}
      >
        {icon}
        {label}
        {badge > 0 && (
          <span className="ml-auto bg-red-500/20 text-red-400 text-xs font-bold px-2 py-0.5 rounded-full border border-red-500/20">
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="w-full flex flex-col md:flex-row text-zinc-300 pb-24 md:pb-0 overflow-hidden">
      
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-zinc-800 bg-black/40 flex-shrink-0 md:overflow-y-auto">
        <div className="p-6 md:p-8 flex items-center gap-3">
          <Settings className="w-6 h-6 text-olive" />
          <h1 className="text-xl font-light text-gold tracking-tight">{t('adminDashboard')}</h1>
        </div>

        <nav className="flex md:flex-col gap-2 px-4 md:px-6 pb-6 overflow-x-auto md:overflow-visible no-scrollbar">
          <NavButton id="wallet_requests" icon={<Bell className="w-4 h-4" />} label="Wallet Requests" badge={pendingCount} />
          <NavButton id="products" icon={<Package className="w-4 h-4" />} label={t('adminProducts')} />
          <NavButton id="sections" icon={<LayoutList className="w-4 h-4" />} label={t('adminSections')} />
          <NavButton id="users" icon={<Users className="w-4 h-4" />} label={t('adminUsers')} />
          <NavButton id="wallet_settings" icon={<Wallet className="w-4 h-4" />} label="Wallet Settings" />
        </nav>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-black/20">
        <div className="max-w-5xl mx-auto">
          <div className="bg-zinc-900/40 backdrop-blur-xl border border-zinc-800/80 rounded-2xl p-6 md:p-8 shadow-2xl">`;

content = content.replace(target, replacement);

fs.writeFileSync('src/pages/Admin.tsx', content);
