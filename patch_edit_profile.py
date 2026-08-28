import sys

def main():
    with open('src/pages/EditProfile.tsx', 'r') as f:
        content = f.read()

    # Add imports
    import_target = "import { useAuth } from '../AuthContext';"
    import_replacement = "import { useAuth } from '../AuthContext';\nimport MerchantDashboard from '../components/MerchantDashboard';\nimport { Store } from 'lucide-react';"
    if import_target in content:
        content = content.replace(import_target, import_replacement)
    
    # Add merchant mode state
    state_target = "const [saved, setSaved] = useState(false);"
    state_replacement = "const [saved, setSaved] = useState(false);\n  const [merchantMode, setMerchantMode] = useState(user?.isAdmin || true); // Assuming admin or default true for demo"
    if state_target in content:
        content = content.replace(state_target, state_replacement)
        
    # Replace render body
    render_target = """      <div className="flex items-center justify-between p-4 pt-12 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-10 border-b border-zinc-800/50">"""
    
    render_replacement = """      {/* Merchant Mode Toggle (Demo) */}
      <div className="flex justify-center pt-8 bg-[#0a0a0a]">
        <button 
          onClick={() => setMerchantMode(!merchantMode)}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold transition-colors ${merchantMode ? 'bg-gold/20 text-gold border border-gold/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}
        >
          <Store className="w-4 h-4" />
          {merchantMode ? 'Merchant Mode: ON' : 'Merchant Mode: OFF'}
        </button>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between p-4 pt-4 bg-[#0a0a0a]/80 backdrop-blur-md sticky top-0 z-10 border-b border-zinc-800/50">"""
    
    if render_target in content:
        content = content.replace(render_target, render_replacement)
        
    body_target = """      <div className="px-4 pb-8 pt-4 space-y-6 max-w-md mx-auto">"""
    body_replacement = """      {merchantMode ? (
        <MerchantDashboard />
      ) : (
        <div className="px-4 pb-8 pt-4 space-y-6 max-w-md mx-auto">"""
        
    if body_target in content:
        content = content.replace(body_target, body_replacement)
        
    # Close the paren we added
    end_target = """      </div>
    </div>
  );
}"""
    end_replacement = """        </div>
      )}
    </div>
  );
}"""
    
    if end_target in content:
        content = content.replace(end_target, end_replacement)

    with open('src/pages/EditProfile.tsx', 'w') as f:
        f.write(content)
        print("Success")

if __name__ == "__main__":
    main()
