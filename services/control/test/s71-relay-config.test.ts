import assert from 'node:assert/strict';
import test from 'node:test';
import {loadConfig} from '../src/config.js';

const base={DATABASE_URL:'postgresql://localhost/vodog_test',COOKIE_SECRET:'s71-relay-config-test-cookie-secret-32-bytes'};
const url='turns:203.0.113.20:16801?transport=tcp',hostname='vodog.example.com';

test('S71 relay TURN config is off by default and accepts an IP URL with a DNS hostname',()=>{
  const off=loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:'',MEDIA_RELAY_TURN_HOSTNAME:''});
  assert.equal(off.MEDIA_RELAY_TURN_TLS_URL,undefined);assert.equal(off.MEDIA_RELAY_TURN_HOSTNAME,undefined);
  const on=loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:url,MEDIA_RELAY_TURN_HOSTNAME:hostname,MEDIA_RELAY_NODE_ID:'relay-primary'});
  assert.equal(on.MEDIA_RELAY_TURN_TLS_URL,url);assert.equal(on.MEDIA_RELAY_TURN_HOSTNAME,hostname);assert.equal(on.MEDIA_RELAY_NODE_ID,'relay-primary');
  assert.equal(loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:'turns:relay.example.com:443?transport=tcp',MEDIA_RELAY_TURN_HOSTNAME:hostname,MEDIA_RELAY_NODE_ID:'relay-primary'}).MEDIA_RELAY_TURN_HOSTNAME,hostname);
});

test('S71 relay TURN config must be set together and well-formed',()=>{
  assert.throws(()=>loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:url}),/set together/);
  assert.throws(()=>loadConfig({...base,MEDIA_RELAY_TURN_HOSTNAME:hostname}),/set together/);
  assert.throws(()=>loadConfig({...base,MEDIA_RELAY_NODE_ID:'relay-primary'}),/set together/);
  assert.throws(()=>loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:url,MEDIA_RELAY_TURN_HOSTNAME:hostname}),/set together/);
  assert.throws(()=>loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:url,MEDIA_RELAY_TURN_HOSTNAME:hostname,MEDIA_RELAY_NODE_ID:'Primary'}),/MEDIA_RELAY_NODE_ID/);
  for(const bad of ['turn:203.0.113.20:16801?transport=udp','turns:203.0.113.20:16801?transport=udp','turns:203.0.113.20?transport=tcp','turns:203.0.113.20:70000?transport=tcp','turns:203.0.113.20:0?transport=tcp','turns:user@203.0.113.20:16801?transport=tcp','https://203.0.113.20:16801'])
    assert.throws(()=>loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:bad,MEDIA_RELAY_TURN_HOSTNAME:hostname,MEDIA_RELAY_NODE_ID:'relay-primary'}),bad);
  for(const bad of ['203.0.113.20','localhost','-bad.example.com','bad_host.example.com','vodog.example.com.','a..b.com'])
    assert.throws(()=>loadConfig({...base,MEDIA_RELAY_TURN_TLS_URL:url,MEDIA_RELAY_TURN_HOSTNAME:bad,MEDIA_RELAY_NODE_ID:'relay-primary'}),bad);
});
