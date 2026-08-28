const fs = require('fs');

let content = fs.readFileSync('src/pages/Chat.tsx', 'utf8');

const replacements = [
  ['"刚刚在线"', '"Just online"'],
  ['"推荐~ 🥳"', '"Recommend~ 🥳"'],
  ['"我买过的 😋"', '"I bought this 😋"'],
  ['"适合你 😉"', '"Suits you 😉"'],
  ['"你看看，觉得咋样？"', '"What do you think?"'],
  ['"舒适跑步运动鞋"', '"Comfortable Running Shoes"'],
  ['"官方鞋类专卖店"', '"Official Shoe Store"'],
  ['"高级智能手表"', '"Advanced Smartwatch"'],
  ['"科技数码店"', '"Tech Store"'],
  ['"我通过了你的好友请求"', '"I accepted your friend request"'],
  ['"你好 👋"', '"Hello 👋"'],
  ['"Sam! 好久没聊天了"', '"Sam! Long time no chat"'],
  ['"无绳跳绳垫加厚隔音减震垫家用专业慢..."', '"Thickened Soundproof Jump Rope Mat for Home..."'],
  ['"选择商品规格"', '"Select Product Specs"'],
  ['"pelpo 派普旗舰店"', '"Pelpo Official Store"'],
  ["'相册'", "'Album'"],
  ["'拍摄'", "'Camera'"],
  ["'商品'", "'Products'"],
  ["'店铺'", "'Store'"],
  ["'红包'", "'Red Envelope'"],
  ["'位置'", "'Location'"],
  ["'个人名片'", "'Profile Card'"],
  ["'送礼金'", "'Send Money'"],
  ['"我们现在是好友啦"', '"We are now friends"'],
  ['"我们因淘宝而结缘，以后多多交流哦"', '"We met through the app, let\'s keep in touch"'],
  ["'选择商品'", "'Select Product'"],
  ["'发送消息...'", "'Type a message...'"]
];

for (const [ch, en] of replacements) {
  content = content.replace(ch, en);
  // Also try replacing without quotes in case quotes don't match perfectly, but this is safe
}

fs.writeFileSync('src/pages/Chat.tsx', content, 'utf8');
