import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect} from 'node:http2';
import {generateKeyPairSync,verify} from 'node:crypto';
import {ApnsClient} from '../src/apns.js';
test('APNs uses ES256, a dedicated VoIP topic and an expiring payload without private call details',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer();let received:any;let auth='';
 server.on('stream',(stream,headers)=>{auth=String(headers.authorization);let raw='';stream.setEncoding('utf8');stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{received={headers,body:JSON.parse(raw)};stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const address=server.address();assert.ok(address&&typeof address==='object');
  const client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,url=>{assert.equal(url,'https://api.sandbox.push.apple.com');return connect('http://127.0.0.1:'+address.port);});
  const result=await client.sendIncoming({token:'a'.repeat(64),environment:'development',callId:'11111111-1111-4111-8111-111111111111',notificationId:'22222222-2222-4222-8222-222222222222'});assert.equal(result.status,200);
  assert.equal(received.headers['apns-topic'],'org.vodog.voip');assert.equal(received.headers['apns-expiration'],'0');assert.equal(received.headers['apns-push-type'],'voip');assert.equal(received.body.remoteNumber,undefined);
  const [head,body,sig]=auth.slice(7).split('.');assert.equal(JSON.parse(Buffer.from(head!,'base64url').toString()).alg,'ES256');assert.equal(JSON.parse(Buffer.from(body!,'base64url').toString()).iss,'TESTTEAM01');
  assert.equal(verify('sha256',Buffer.from(head+'.'+body),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig!,'base64url')),true);
  assert.deepEqual(Object.keys(received.body).sort(),['aps','callId','event','version'],'no contact name or SIM label means no optional key');
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('the VoIP payload carries the contact name, number and called SIM label at the top level and adds no other key',async()=>{
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const pem=privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const server=createServer();let received:any;
 server.on('stream',(stream)=>{let raw='';stream.setEncoding('utf8');stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{received=JSON.parse(raw);stream.respond({':status':200});stream.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const address=server.address();assert.ok(address&&typeof address==='object');
  const client=new ApnsClient('TESTKEY001','TESTTEAM01',pem,()=>connect('http://127.0.0.1:'+address.port));
  const push={token:'a'.repeat(64),environment:'development' as const,callId:'11111111-1111-4111-8111-111111111111',notificationId:'22222222-2222-4222-8222-222222222222'};
  await client.sendIncoming({...push,contactName:'  张三\n  ',remoteNumber:' +15551234567\n',simLabel:' Test SIM A\n'});
  // iOS reads `contactName` from the payload top level for CXCallUpdate.localizedCallerName and,
  // since S36 C1, `remoteNumber` for its remoteHandle.
  assert.deepEqual(Object.keys(received).sort(),['aps','callId','contactName','event','remoteNumber','simLabel','version']);
  assert.equal(received.simLabel,'Test SIM A','S81: an ordinary call carries the called SIM label, bounded and trimmed');
  assert.equal(received.contactName,'张三','control characters stripped and trimmed');
  assert.equal(received.remoteNumber,'+15551234567','the number is bounded and trimmed the same way');
  await client.sendIncoming({...push,contactName:'   ',remoteNumber:null,simLabel:null});
  assert.equal('simLabel' in received,false,'no SIM label means no key');
  assert.equal('contactName' in received,false,'a blank name is omitted rather than sent empty');
  assert.equal('remoteNumber' in received,false,'an unknown number is omitted rather than sent empty');
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
