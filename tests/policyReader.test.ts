import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyVersion, policyDocumentUrl, policyHeadings } from '../src/lib/policyReader';

test('historical versions are explicit and invalid input never selects the latest', () => {
  assert.deepEqual(parsePolicyVersion(null), {valid:true,version:null});
  assert.deepEqual(parsePolicyVersion('12'), {valid:true,version:12});
  for (const value of ['', '0', '-1', '1.5', 'NaN', '1e2', '1000001']) assert.deepEqual(parsePolicyVersion(value), {valid:false,version:null});
});
test('document requests pin both historical version and supported locale', () => {
  assert.equal(policyDocumentUrl('terms',2,'en'), '/api/policies/terms?lang=en&version=2');
  assert.equal(policyDocumentUrl('privacy',null,'ckb'), '/api/policies/privacy?lang=ckb');
  assert.equal(policyDocumentUrl('terms?evil',1,'bad&x=y'), '/api/policies/terms%3Fevil?lang=ar&version=1');
});
test('table of contents matches rendered line identifiers even for repeated headings', () => {
  assert.deepEqual(policyHeadings('## Title\nbody\n\n## Title'), [{id:'policy-section-0',title:'Title'},{id:'policy-section-3',title:'Title'}]);
});
