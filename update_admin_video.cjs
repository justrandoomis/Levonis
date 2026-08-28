const fs = require('fs');
let content = fs.readFileSync('src/pages/Admin.tsx', 'utf8');

const regex = /<h3 className="text-lg font-bold text-white mb-4">Currency Settings<\/h3>/;

const newSection = `
              <div className="bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800 mb-8">
                <h3 className="text-lg font-bold text-white mb-4">Rewards Settings</h3>
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
                <h3 className="text-lg font-bold text-white mb-4">Currency Settings</h3>`;

content = content.replace(regex, newSection);

// add adVideoUrl to useWallet destructuring in Admin.tsx
content = content.replace(
  "  const { updateTransactionStatus, updatePaymentMethods, exchangeRate, setExchangeRate } = useWallet();",
  "  const { updateTransactionStatus, updatePaymentMethods, exchangeRate, setExchangeRate, adVideoUrl, setAdVideoUrl } = useWallet();"
);

fs.writeFileSync('src/pages/Admin.tsx', content);
