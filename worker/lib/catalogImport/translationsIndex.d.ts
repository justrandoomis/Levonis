/**
 * The translation memory's bundled index (data/bambu-import/translations/index.json; I18N-DESIGN §A.3). Wrangler
 * may bundle it as text or as a JSON module and Node parses it: worker/lib/catalogImport/translations.ts reads
 * either form, so it is typed as unknown here.
 */
declare module '*bambu-import/translations/index.json' {
  const value: unknown;
  export default value;
}
