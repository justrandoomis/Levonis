const { SPEC_KEYS } = await import('/home/user/levonis-curated/packages/catalog/src/bambuImport/registry/specKeys.ts');
for (const k of SPEC_KEYS) {
  const applies = k.appliesTo.length === 0 || k.appliesTo.includes('hotend');
  if (!applies) continue;
  console.log([k.key, k.type, k.unit, k.labels.en, k.appliesTo.join('/') || 'ANY', (k.expectedFor||[]).join('/'), k.ownerOnly ? 'OWNER' : '', k.regionDependent ?? ''].join(' | '));
}
