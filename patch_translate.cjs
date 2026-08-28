const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

const importTarget = `import multer from 'multer';`;
const importNew = `import multer from 'multer';\nimport { GoogleGenAI } from '@google/genai';`;

if(!content.includes('@google/genai')) {
  content = content.replace(importTarget, importNew);
}

const target = `const upload = multer({ storage: multer.memoryStorage() });`;
const endpoint = `const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

app.post('/api/translate', express.json(), async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text) return res.json({ success: true, translation: '' });
    
    // If we have no API key, just return the original text
    if (!process.env.GEMINI_API_KEY) {
      return res.json({ success: true, translation: text });
    }

    const prompt = \`Translate the following text to \${targetLang === 'en' ? 'English' : 'Arabic'}. Only output the translated text, no extra words or explanations.\\n\\n\${text}\`;
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    
    res.json({ success: true, translation: response.text.trim() });
  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({ success: false, error: 'Translation failed' });
  }
});

const upload = multer({ storage: multer.memoryStorage() });`;

content = content.replace(target, endpoint);
fs.writeFileSync('server.ts', content);
