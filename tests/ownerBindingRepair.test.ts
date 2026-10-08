import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerRestorationPlan } from '../scripts/restore-finance-owner';

const admin = { id: 'owner', username: 'owner.name', email: 'Owner@Example.com', email_verified_at: '2026-01-01', role: 'admin', admin_scope: 'full' };
const bindings = [{ name: 'DB', type: 'd1', id: 'live-db' }, { name: 'TOKEN', type: 'secret_text' }, { name: 'INITIAL_ADMIN_EMAIL', type: 'plain_text', text: '' }];
test('restoration needs exact confirmation, a unique verified existing full administrator and an empty owner', () => {
  assert.throws(() => ownerRestorationPlan(bindings,[admin],admin.username,''));
  assert.throws(() => ownerRestorationPlan(bindings,[],admin.username,'SET-OWNER:owner.name'));
  assert.throws(() => ownerRestorationPlan(bindings,[admin,admin],admin.username,'SET-OWNER:owner.name'));
  for (const replacement of [{ role: 'customer' }, { admin_scope: 'assistant' }, { admin_scope: 'unknown' }, { email_verified_at: null }, { email_verified_at: '' }, { email_verified_at: '   ' }, { username: 'other' }]) {
    assert.throws(() => ownerRestorationPlan(bindings,[{ ...admin,...replacement }],admin.username,'SET-OWNER:owner.name'));
  }
  assert.throws(() => ownerRestorationPlan([...bindings.slice(0,2), {name:'INITIAL_ADMIN_EMAIL',type:'plain_text',text:'different@example.com'}],[admin],admin.username,'SET-OWNER:owner.name'));
  assert.throws(() => ownerRestorationPlan([{name:'INITIAL_ADMIN_EMAIL',type:'secret_text'}],[admin],admin.username,'SET-OWNER:owner.name'));
});
test('only the owner binding changes; secrets and database are inherited, and a repeated repair is a no-op', () => {
  const plan = ownerRestorationPlan(bindings,[admin],admin.username,'SET-OWNER:owner.name');
  assert.equal(plan.changed,true);
  assert.deepEqual(plan.bindings,[{name:'DB',type:'inherit'},{name:'TOKEN',type:'inherit'},{name:'INITIAL_ADMIN_EMAIL',type:'plain_text',text:'owner@example.com'}]);
  assert.equal(bindings[2].text,'');
  assert.equal(ownerRestorationPlan(plan.bindings,[admin],admin.username,'SET-OWNER:owner.name').changed,false);
});
