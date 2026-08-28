const fs = require('fs');
let content = fs.readFileSync('src/pages/Rewards.tsx', 'utf8');

if (!content.includes('const [pushEarned, setPushEarned] = useState')) {
  content = content.replace(
    '  const [loadingMission, setLoadingMission] = useState<string | null>(null);',
    '  const [loadingMission, setLoadingMission] = useState<string | null>(null);\n  const [pushEarned, setPushEarned] = useState(() => !!localStorage.getItem(\'levo_push_earned\'));\n  const [videoEarned, setVideoEarned] = useState(() => !!localStorage.getItem(\'levo_video_earned_\' + new Date().toISOString().split(\'T\')[0]));'
  );
  
  content = content.replace(
    /                     localStorage\.setItem\('levo_push_earned', 'true'\);\n                     setLoadingMission\(null\);\n                     alert\('You have enabled push notifications and earned 50 pts!'\);/,
    "                     localStorage.setItem('levo_push_earned', 'true');\n                     setPushEarned(true);\n                     setLoadingMission(null);\n                     alert('You have enabled push notifications and earned 50 pts!');"
  );
  
  content = content.replace(
    /                     localStorage\.setItem\('levo_video_earned_' \+ new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\], 'true'\);\n                     setLoadingMission\(null\);\n                     alert\('You watched a video and earned 20 pts!'\);/,
    "                     localStorage.setItem('levo_video_earned_' + new Date().toISOString().split('T')[0], 'true');\n                     setVideoEarned(true);\n                     setLoadingMission(null);\n                     alert('You watched a video and earned 20 pts!');"
  );
  
  // conditionally render the items
  content = content.replace(
    /            <div className="bg-\[#0F2F25\] rounded-\[20px\] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-\[#184235\] transition-colors"\s*onClick=\{async \(\) => \{\s*if \(loadingMission\) return;\s*const earned = localStorage\.getItem\('levo_push_earned'\);/g,
    "{!pushEarned && (\n            <div className=\"bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors\"\n                 onClick={async () => {\n                   if (loadingMission) return;\n                   const earned = localStorage.getItem('levo_push_earned');"
  );
  
  content = content.replace(
    /              <div className="text-gold font-bold text-\[16px\]">\s*\+50 pts\s*<\/div>\s*<\/div>/,
    "              <div className=\"text-gold font-bold text-[16px]\">\n                +50 pts\n              </div>\n            </div>\n            )}"
  );
  
  content = content.replace(
    /            <div className="bg-\[#0F2F25\] rounded-\[20px\] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-\[#184235\] transition-colors"\s*onClick=\{async \(\) => \{\s*if \(loadingMission\) return;\s*const earned = localStorage\.getItem\('levo_video_earned_'/g,
    "{!videoEarned && (\n            <div className=\"bg-[#0F2F25] rounded-[20px] p-4 flex items-center justify-between shadow-sm cursor-pointer hover:bg-[#184235] transition-colors\"\n                 onClick={async () => {\n                   if (loadingMission) return;\n                   const earned = localStorage.getItem('levo_video_earned_'"
  );
  
  content = content.replace(
    /              <div className="text-gold font-bold text-\[16px\]">\s*\+20 pts\s*<\/div>\s*<\/div>/,
    "              <div className=\"text-gold font-bold text-[16px]\">\n                +20 pts\n              </div>\n            </div>\n            )}"
  );

  // if both are earned, maybe we hide the whole Earn Points section? Or just show a message.
  content = content.replace(
    /          <div className="space-y-3 px-1">\s*\{!pushEarned/,
    "          <div className=\"space-y-3 px-1\">\n            {pushEarned && videoEarned && <div className=\"text-white/40 text-center py-4 text-sm\">You're all caught up for today!</div>}\n            {!pushEarned"
  );
  
  fs.writeFileSync('src/pages/Rewards.tsx', content);
}
