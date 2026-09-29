import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaNodeRegistry,MediaNodeNotFoundError} from '../src/media-node-registry.js';
import {validatedControlBaseUrl} from '../src/media-client.js';

const secret='s'.repeat(40),turn='t'.repeat(40);
const node=(id:string,url:string)=>({id,controlBaseUrl:url,turnUdpUrl:`turn:${id}.example.test:3478?transport=udp`,turnTlsUrl:`turns:${id}.example.test:5349?transport=tcp`,mediaSecret:secret,turnSecret:turn});

test('media node registry accepts only fixed trusted destinations and rejects unknown nodes',()=>{
  const registry=new MediaNodeRegistry([node('relay-primary','http://127.0.0.1:16881'),node('relay-secondary','https://198.51.100.20:16881')],'relay-secondary');
  assert.equal(registry.choose(),'relay-secondary');assert.equal(registry.choose('relay-primary'),'relay-primary');
  assert.throws(()=>registry.choose('attacker'),MediaNodeNotFoundError);
  assert.throws(()=>validatedControlBaseUrl('http://192.0.2.23:16881'));
  assert.throws(()=>validatedControlBaseUrl('https://198.51.100.20:16881/path'));
  assert.throws(()=>validatedControlBaseUrl('https://user:pass@example.test'));
  assert.equal(validatedControlBaseUrl('https://media-relay-secondary.example.test'),'https://media-relay-secondary.example.test');
});
