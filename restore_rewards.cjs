const fs = require('fs');
let content = fs.readFileSync('src/pages/Rewards.tsx', 'utf8');

const earnRewardsSection = `
        {/* Earn Rewards Section */}
        <div className="mt-8 mb-8">
          <h2 className="text-[17px] font-bold mb-4 px-1 text-white">Earn Points</h2>
          <div className="space-y-3 px-1">
            <div className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors"
                 onClick={() => {
                   const earned = localStorage.getItem('levo_push_earned');
                   if (!earned) {
                     alert('You have enabled push notifications and earned 50 pts!');
                     localStorage.setItem('levo_push_earned', 'true');
                     addReward(50, 'Enabled Push Notifications');
                   } else {
                     alert('You have already claimed this reward.');
                   }
                 }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  <Bell className="w-5 h-5 text-gold" fill="currentColor" />
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Enable Notifications</h4>
                  <span className="text-white/40 font-medium text-[12px]">Stay updated</span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +50 pts
              </div>
            </div>
            
            <div className="bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors"
                 onClick={() => {
                   const earned = localStorage.getItem('levo_video_earned_' + new Date().toISOString().split('T')[0]);
                   if (!earned) {
                     alert('You watched a video and earned 20 pts!');
                     localStorage.setItem('levo_video_earned_' + new Date().toISOString().split('T')[0], 'true');
                     addReward(20, 'Watched 3 Mins Video');
                   } else {
                     alert('You have already claimed this daily reward.');
                   }
                 }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gold/10 flex items-center justify-center">
                  <PlayCircle className="w-5 h-5 text-gold" fill="currentColor" />
                </div>
                <div>
                  <h4 className="text-white font-bold text-[14px]">Watch 3 Mins</h4>
                  <span className="text-white/40 font-medium text-[12px]">Daily reward</span>
                </div>
              </div>
              <div className="text-gold font-bold text-[16px]">
                +20 pts
              </div>
            </div>
          </div>
        </div>
`;

content = content.replace(
  /        \{\/\* Points History Section \*\/\}/,
  earnRewardsSection + "\n        {/* Points History Section */}"
);

fs.writeFileSync('src/pages/Rewards.tsx', content);
