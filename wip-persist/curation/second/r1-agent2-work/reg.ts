import { SPEC_KEYS } from '../../../../../../../../home/user/levonis-curated/packages/catalog/src/bambuImport/registry/specKeys';
for (const s of SPEC_KEYS) {
  const applies = s.appliesTo.length === 0 || s.appliesTo.includes('laser_machine');
  console.log(`${applies ? 'Y' : '-'} ${s.key} | ${s.type} | ${s.unit} | applies=${s.appliesTo.join(',')} | exp=${(s.expectedFor ?? []).join(',')} | reg=${s.regionDependent ?? ''}${s.ownerOnly ? ' | OWNER' : ''} | syn=${s.synonyms.slice(0,6).join(' / ')}`);
}
