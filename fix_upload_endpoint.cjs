const fs = require('fs');

let code = fs.readFileSync('server.ts', 'utf8');

const uploadCode = `
const fsModule = require('fs');
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.post('/api/upload', express.json({limit: '500mb'}), (req, res) => {
  try {
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).json({ success: false, error: 'Missing name or data' });
    const matches = data.match(/^data:([A-Za-z-+\\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ success: false, error: 'Invalid base64 data' });
    }
    const ext = name.split('.').pop();
    const filename = \`\${Date.now()}-\${Math.round(Math.random()*1E9)}.\${ext}\`;
    const uploadDir = path.join(process.cwd(), 'uploads');
    if (!fsModule.existsSync(uploadDir)) {
      fsModule.mkdirSync(uploadDir, { recursive: true });
    }
    const buffer = Buffer.from(matches[2], 'base64');
    fsModule.writeFileSync(path.join(uploadDir, filename), buffer);
    res.json({ success: true, url: \`/uploads/\${filename}\` });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
`;

if (!code.includes('/api/upload')) {
    code = code.replace(
        /app\.get\('\/api\/health'/g,
        uploadCode + "\napp.get('/api/health'"
    );
    fs.writeFileSync('server.ts', code);
}
