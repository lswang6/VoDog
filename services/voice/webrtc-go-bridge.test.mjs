import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const run = process.env.VOICE_RUN_GO_BRIDGE_INTEGRATION === '1';

test('Node client role completes PCM to Opus round trip through isolated Go bridge',{skip:!run,timeout:60_000},async t=>{
  const script=resolve(import.meta.dirname,'scripts/probe-go-bridge.mjs');
  const child=spawn(process.execPath,[script],{env:{...process.env,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',resolveExit)});
  assert.equal(code,0,stderr||stdout);const lines=stdout.trim().split('\n');const result=JSON.parse(lines.at(-1));assert.equal(result.ok,true);assert.equal(result.manifestComplete,true);assert.ok(result.decodedPcmFrames>=20);assert.ok(result.encodedOpusPackets>=20);
  t.diagnostic(`decodedPcmFrames=${result.decodedPcmFrames} encodedOpusPackets=${result.encodedOpusPackets}`);
});
