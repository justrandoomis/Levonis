const fs = require('fs');
let content = fs.readFileSync('src/WalletContext.tsx', 'utf8');

if (!content.includes('adVideoUrl')) {
  // Add adVideoUrl to WalletContextType
  content = content.replace(
    "  isLoaded: boolean;\n}",
    "  isLoaded: boolean;\n  adVideoUrl: string;\n  setAdVideoUrl: (url: string) => Promise<void>;\n}"
  );

  // Add adVideoUrl to WalletProvider
  content = content.replace(
    "  const [currency, setCurrency] = useState<'IQD' | 'USD'>('USD');",
    "  const [currency, setCurrency] = useState<'IQD' | 'USD'>('USD');\n  const [adVideoUrl, setAdVideoUrl] = useState<string>('');"
  );

  // Update fetchSettings
  content = content.replace(
    "        if (s.key === 'paymentMethods') setPaymentMethods(JSON.parse(s.value));",
    "        if (s.key === 'paymentMethods') setPaymentMethods(JSON.parse(s.value));\n        if (s.key === 'adVideoUrl') setAdVideoUrl(s.value);"
  );

  // Add setAdVideoUrlDb
  content = content.replace(
    "  const setCurrencyDb = async (curr: 'IQD' | 'USD') => {",
    "  const setAdVideoUrlDb = async (url: string) => {\n    try {\n      await queryDb(`INSERT INTO admin_settings (key, value) VALUES ('adVideoUrl', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [url]);\n      setAdVideoUrl(url);\n    } catch (e) {\n      console.error(e);\n    }\n  };\n\n  const setCurrencyDb = async (curr: 'IQD' | 'USD') => {"
  );

  // Export it
  content = content.replace(
    "      isLoaded\n    }}>",
    "      isLoaded,\n      adVideoUrl,\n      setAdVideoUrl: setAdVideoUrlDb\n    }}>"
  );

  fs.writeFileSync('src/WalletContext.tsx', content);
}
