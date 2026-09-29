import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blocklistKeysOverlap,canonicalBlocklistKey,phoneBlocklistSyncMode,remoteMatchesOwnerBlocklist} from '../src/blocklist.js';

const item=(remote_number:string,canonical_key=canonicalBlocklistKey(remote_number)!)=>{
 return{canonical_key,remote_number};
};

test('blocklist matching uses digit keys plus SIM-country E.164 without rewriting stored originals',()=>{
 const stored=item('18600000001');
 assert.equal(stored.canonical_key,'18600000001');
 assert.equal(remoteMatchesOwnerBlocklist('18600000001',[stored]),true);
 // S55: an explicit +86 is the country itself, so it matches without a SIM country.
 assert.equal(remoteMatchesOwnerBlocklist('+8618600000001',[stored]),true);
 assert.equal(remoteMatchesOwnerBlocklist('+8618600000001',[stored],'CN'),true);
 assert.equal(remoteMatchesOwnerBlocklist('18600000001',[item('+8618600000001')],'CN'),true);
 assert.equal(remoteMatchesOwnerBlocklist('18600000001',[item('+8618600000001')]),true);
});

test('emergency numbers never match a blocklist entry',()=>{
 assert.equal(canonicalBlocklistKey('112'),null);
 assert.equal(canonicalBlocklistKey('911'),null);
 assert.equal(remoteMatchesOwnerBlocklist('112',[item('112','112')],'CN'),false);
 assert.equal(remoteMatchesOwnerBlocklist('911',[{canonical_key:'911',remote_number:'911'}]),false);
});

test('other owners and unrelated numbers do not match',()=>{
 const stored=item('+15551212');
 assert.equal(remoteMatchesOwnerBlocklist('+15559999',[stored]),false);
 assert.equal(remoteMatchesOwnerBlocklist('BANK',[stored],'CN'),false);
});

test('S55: CN spellings of one number match; service codes drop any country code; ordinary numbers and bare landline locals do not',()=>{
 for(const country of [undefined,'CN']){
  assert.equal(remoteMatchesOwnerBlocklist('075595501',[item('+8675595501')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('95501',[item('075595501')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('+8675595501',[item('075595501')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('075595501',[item('95501')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('+8613800001234',[item('13800001234')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('+8675583765432',[item('075583765432')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('83765432',[item('075583765432')],country),false);
  assert.equal(remoteMatchesOwnerBlocklist('95008',[item('+85295008')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('+85295008',[item('95008')],country),true);
  assert.equal(remoteMatchesOwnerBlocklist('91234567',[item('+85291234567')],country),false);
  assert.equal(remoteMatchesOwnerBlocklist('+8691234567',[item('+85291234567')],country),false);
 }
 assert.equal(blocklistKeysOverlap(['10101196'],['8610101196']),true);
 assert.equal(blocklistKeysOverlap(['10105501'],['8610105501']),true);
 assert.equal(blocklistKeysOverlap(['8610101196'],['101196']),false);
 assert.equal(blocklistKeysOverlap(['85295008'],['95008']),true);
 assert.equal(blocklistKeysOverlap(['85291234567'],['91234567']),false);
});

test('S55: phoneSync mode is off unless enabled, dry_run unless dry-run is explicitly false',()=>{
 assert.equal(phoneBlocklistSyncMode({}),'off');
 assert.equal(phoneBlocklistSyncMode({PHONE_BLOCKLIST_SYNC_ENABLED:false,PHONE_BLOCKLIST_SYNC_DRY_RUN:false}),'off');
 assert.equal(phoneBlocklistSyncMode({PHONE_BLOCKLIST_SYNC_ENABLED:true}),'dry_run');
 assert.equal(phoneBlocklistSyncMode({PHONE_BLOCKLIST_SYNC_ENABLED:true,PHONE_BLOCKLIST_SYNC_DRY_RUN:true}),'dry_run');
 assert.equal(phoneBlocklistSyncMode({PHONE_BLOCKLIST_SYNC_ENABLED:true,PHONE_BLOCKLIST_SYNC_DRY_RUN:false}),'on');
});
