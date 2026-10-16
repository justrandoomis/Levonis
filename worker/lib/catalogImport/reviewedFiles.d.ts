/**
 * The reviewed files of the catalogue import, bundled as wrangler `Text` modules
 * (wrangler.jsonc `rules`): each import's default export is the file's exact
 * text. Only these eight paths are declared, so no other JSON import is typed
 * as text by accident. Under Node (the tests) the same import yields a parsed
 * object instead; worker/lib/catalogImport/bundle.ts refuses anything that is
 * not a string, and the tests inject the texts they read with `fs`.
 */
declare module '*bambu-import/manifest.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/taxonomy-map.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/existing-matches.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/compat-targets.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/identity-map.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/media-overrides.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/curated/index.json' {
  const text: string;
  export default text;
}
declare module '*bambu-import/search-synonyms.json' {
  const text: string;
  export default text;
}
