import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isEmergencyServiceNumber,phoneDigitKey,phoneMatchKeys,smsAddress} from '../src/phone-address.js';
test('SIM country merges national and international addresses without changing raw records',()=>{
 assert.equal(smsAddress('18600000001','cn').conversationAddress,smsAddress('+86 186 0000 0001','CN').conversationAddress);
 assert.equal(smsAddress('020 7946 0018','GB').conversationAddress,'+442079460018');
});
test('unknown country cannot strip country codes or merge unrelated national senders',()=>{
 assert.notEqual(smsAddress('18600000001').conversationAddress,smsAddress('+8618600000001').conversationAddress);
 assert.equal(smsAddress('10086','CN').replyNumber,'10086');
 assert.equal(smsAddress('10086','invalid').conversationAddress,'10086');
});
test('alphanumeric sender and control strings are visible but never auto-replyable',()=>{
 assert.deepEqual(smsAddress('BANK','CN'),{conversationAddress:'BANK',replyNumber:null,canReply:false});
 assert.equal(smsAddress('*123#','CN').canReply,false);
 assert.equal(smsAddress('123;456','CN').canReply,false);
 assert.equal(smsAddress('', 'CN').canReply,false);
});
test('digit keys never guess a country and keep national vs E.164 distinct until country is known',()=>{
 assert.equal(phoneDigitKey('18600000001'),'18600000001');
 assert.equal(phoneDigitKey('+86 186 0000 0001'),'8618600000001');
 assert.notEqual(phoneDigitKey('18600000001'),phoneDigitKey('+8618600000001'));
 assert.deepEqual(phoneMatchKeys('18600000001'),['18600000001']);
 assert.ok(phoneMatchKeys('18600000001','CN').includes('8618600000001'));
 assert.ok(phoneMatchKeys('+8618600000001','CN').includes('8618600000001'));
 assert.equal(phoneDigitKey('BANK'),null);
 assert.equal(phoneDigitKey(''),null);
});
test('emergency 112 and 911 never become match keys',()=>{
 assert.equal(isEmergencyServiceNumber('112'),true);
 assert.equal(isEmergencyServiceNumber('911'),true);
 assert.equal(isEmergencyServiceNumber('+911'),true);
 assert.equal(isEmergencyServiceNumber('13800001234'),false);
 assert.deepEqual(phoneMatchKeys('112','CN'),[]);
 assert.deepEqual(phoneMatchKeys('911'),[]);
});
