import test from 'node:test';
import assert from 'node:assert/strict';
import {demoHostAllowed,demoRequest,demoCalls,demoMessages} from '../src/demo-data.ts';
test('demo is loopback-only, read-only, and supplies fictional records without network',async()=>{
 for(const host of ['127.0.0.1','localhost','[::1]'])assert.ok(demoHostAllowed(host));
 for(const host of ['example.com','127.0.0.1.example.com','192.0.2.1'])assert.ok(!demoHostAllowed(host));
 const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Network forbidden');};
 try{assert.ok(demoMessages.every(message=>message.canReply===true));const rows=await demoRequest<{items:unknown[]}>('/calls');assert.equal(rows.items.length,4);assert.ok(demoCalls.every(c=>/^\+120255501\d{2}$/.test(c.remoteNumber!)));await assert.rejects(demoRequest('/calls',{}));await assert.rejects(demoRequest('/calls',undefined,'DELETE'));assert.deepEqual(await demoRequest('/calls/'+demoCalls[0].id+'/recordings?source=media_node'),{recording:null});await assert.rejects(demoRequest('/unknown'));}finally{globalThis.fetch=old;}
});
