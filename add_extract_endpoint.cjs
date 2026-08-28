const fs = require('fs');

let code = fs.readFileSync('server.ts', 'utf8');

const extractEndpoint = `
const cheerio = require('cheerio');

app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      return res.status(500).json({ success: false, error: 'Failed to fetch URL' });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let name = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    let description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    let image = $('meta[property="og:image"]').attr('content') || '';
    let price = 0;

    // Try to parse JSON-LD
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).html());
        const parseProduct = (obj) => {
          if (obj['@type'] === 'Product') {
            if (obj.name) name = obj.name;
            if (obj.description) description = obj.description;
            if (obj.image) {
              image = Array.isArray(obj.image) ? obj.image[0] : obj.image;
            }
            if (obj.offers && obj.offers.price) {
              price = parseFloat(obj.offers.price);
            }
          }
        };
        
        if (Array.isArray(data)) {
          data.forEach(parseProduct);
        } else {
          parseProduct(data);
        }
      } catch (e) {}
    });

    res.json({
      success: true,
      product: {
        name,
        description,
        images: image ? [image] : [],
        original_price: price
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
`;

if (!code.includes('/api/extract')) {
  code = code.replace(/app\.get\('\/api\/health'/, extractEndpoint + "\napp.get('/api/health'");
  fs.writeFileSync('server.ts', code);
}
