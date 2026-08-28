const fs = require('fs');
let content = fs.readFileSync('src/pages/Rewards.tsx', 'utf8');

const historySection = `
        {/* Points History Section */}
        <div className="mt-8 mb-8">
          <h2 className="text-[17px] font-bold mb-4 px-1 text-white">Points History</h2>
          <div className="space-y-3 px-1">
            {pointTransactions.length === 0 && (
              <div className="text-white/40 text-center py-4 text-sm">No recent activity</div>
            )}
            {pointTransactions.slice(0, 10).map((tx, i) => (
              <div key={tx.id || i} className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                    <Star className="w-5 h-5 text-gold" fill="currentColor" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-[14px] capitalize">{tx.note || 'Points Earned'}</h4>
                    <span className="text-white/40 font-medium text-[12px]">{new Date(tx.date).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="text-gold font-bold text-[16px]">
                  +{tx.amount} pts
                </div>
              </div>
            ))}
          </div>
        </div>
`;

content = content.replace(
  /        <\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*\);\s*\}/,
  `        </div>\n        </div>\n${historySection}\n      </div>\n    </div>\n  );\n}`
);

fs.writeFileSync('src/pages/Rewards.tsx', content);
