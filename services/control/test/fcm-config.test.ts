import assert from 'node:assert/strict';
import test from 'node:test';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import type {Db} from '../src/db.js';

const base={DATABASE_URL:'postgresql://localhost/vodog_test',COOKIE_SECRET:'fcm-config-test-cookie-secret-at-least-32-bytes'};

test('FCM defaults disabled and ignores an unused credentials path',()=>{
  const config=loadConfig({...base,FCM_CREDENTIALS_PATH:'/definitely/not/read.json'});
  assert.equal(config.FCM_ENABLED,false);
  assert.equal(config.FCM_CREDENTIALS_PATH,'/definitely/not/read.json');
});

test('enabled FCM requires both project identity and credentials path',()=>{
  assert.throws(()=>loadConfig({...base,FCM_ENABLED:'true'}),/FCM_PROJECT_ID/);
  assert.throws(()=>loadConfig({...base,FCM_ENABLED:'true',FCM_PROJECT_ID:'vodog-example'}),/FCM_CREDENTIALS_PATH/);
  const config=loadConfig({...base,FCM_ENABLED:'true',FCM_PROJECT_ID:'vodog-example',FCM_CREDENTIALS_PATH:'/tmp/vodog-test-fcm-service-account.json'});
  assert.equal(config.FCM_ENABLED,true);
});

test('disabled FCM starts and closes the app without credential or delivery IO',async()=>{
  const noIo={query:async()=>{throw new Error('unexpected database IO');},connect:async()=>{throw new Error('unexpected database IO');}} as unknown as Db;
  const app=await buildApp(noIo,loadConfig({...base,FCM_ENABLED:'false',FCM_CREDENTIALS_PATH:'/missing/private-key.json'}));
  await app.ready();
  await app.close();
});
