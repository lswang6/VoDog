import assert from 'node:assert/strict';
import test from 'node:test';
import { aaguidName, clientPlatformLabel, normalizeAaguid, passkeyDisplayName, toPasskeyItem } from '../src/passkey-metadata.js';

test('AAGUID names cover the curated vendors and fall back to null',()=>{
  assert.equal(aaguidName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd'),'iCloud 钥匙串');
  assert.equal(aaguidName('DD4EC289-E01D-41C9-BB89-70FA845D4BF2'),'iCloud 钥匙串（托管）');
  assert.equal(aaguidName('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4'),'Google 密码管理器');
  assert.equal(aaguidName('adce0002-35bc-c60a-648b-0b25f1f05503'),'Chrome on Mac');
  assert.equal(aaguidName('08987058-cadc-4b81-b6e1-30de50dcbe96'),'Windows Hello');
  assert.equal(aaguidName('6028b017-b1d4-4c02-b4b3-afcdafc96bb2'),'Windows Hello');
  assert.equal(aaguidName('bada5566-a7aa-401f-bd96-45619a55120d'),'1Password');
  assert.equal(aaguidName('53414d53-554e-4700-0000-000000000000'),'Samsung Pass');
  assert.equal(aaguidName('00000000-0000-0000-0000-000000000000'),null);
  assert.equal(aaguidName('11111111-2222-3333-4444-555555555555'),null);
  assert.equal(aaguidName('not-a-uuid'),null);
  assert.equal(aaguidName(null),null);
  assert.equal(normalizeAaguid(' FBFC3007-154E-4ECC-8C0B-6E020557D7BD '),'fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
  assert.equal(normalizeAaguid('00000000-0000-0000-0000-000000000000'),null);
});

test('client platform labels name native apps and parse browser and OS from the User-Agent',()=>{
  assert.equal(clientPlatformLabel('ios','anything'),'iOS App');
  assert.equal(clientPlatformLabel('android',undefined),'Android App');
  assert.equal(clientPlatformLabel('macos',undefined),'macOS App');
  assert.equal(clientPlatformLabel(null,'Mozilla/5.0'),null);
  assert.equal(clientPlatformLabel(undefined,'Mozilla/5.0'),null);
  const ua={
    chromeMac:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    edgeWindows:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
    operaLinux:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/120.0.0.0',
    safariMac:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    safariIPhone:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    safariIPad:'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/604.1',
    firefoxWindows:'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
    chromeAndroid:'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
  };
  assert.equal(clientPlatformLabel('web',ua.chromeMac),'Chrome on macOS');
  assert.equal(clientPlatformLabel('web',ua.edgeWindows),'Edge on Windows');
  assert.equal(clientPlatformLabel('web',ua.operaLinux),'Opera on Linux');
  assert.equal(clientPlatformLabel('web',ua.safariMac),'Safari on macOS');
  assert.equal(clientPlatformLabel('web',ua.safariIPhone),'Safari on iOS');
  assert.equal(clientPlatformLabel('web',ua.safariIPad),'Safari on iPadOS');
  assert.equal(clientPlatformLabel('web',ua.firefoxWindows),'Firefox on Windows');
  assert.equal(clientPlatformLabel('web',ua.chromeAndroid),'Chrome on Android');
  assert.equal(clientPlatformLabel('web','curl/8.7.1'),'浏览器');
  assert.equal(clientPlatformLabel('web',undefined),'浏览器');
});

test('display name prefers the user label, then the AAGUID vendor, then the platform',()=>{
  assert.equal(passkeyDisplayName({label:'办公 MacBook',aaguid:'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',clientPlatform:'Chrome on macOS'}),'办公 MacBook');
  assert.equal(passkeyDisplayName({label:'  ',aaguid:'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',clientPlatform:'Chrome on macOS'}),'iCloud 钥匙串');
  assert.equal(passkeyDisplayName({label:null,aaguid:null,clientPlatform:'iOS App'}),'iOS App');
  assert.equal(passkeyDisplayName({label:null,aaguid:'00000000-0000-0000-0000-000000000000',clientPlatform:null}),'Passkey');
  assert.equal(passkeyDisplayName({}),'Passkey');
});

test('passkey items expose metadata only and accept both id encodings',()=>{
  const id=Buffer.from([0xfb,0xff,0x00,0x10,0x20]);
  const row={id,created_at:'2026-09-11T00:00:00.000Z',device_type:'multiDevice',backed_up:true,
    transports:['internal','hybrid'],label:null,aaguid:'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
    client_platform:'Chrome on macOS',authenticator_attachment:'platform',last_used_at:null,
    public_key:Buffer.from('secret'),counter:7} as never;
  const item=toPasskeyItem(row);
  assert.deepEqual(item,{id:id.toString('base64url'),createdAt:'2026-09-11T00:00:00.000Z',deviceType:'multiDevice',
    backedUp:true,transports:['internal','hybrid'],label:null,aaguid:'fbfc3007-154e-4ecc-8c0b-6e020557d7bd',
    clientPlatform:'Chrome on macOS',authenticatorAttachment:'platform',lastUsedAt:null,displayName:'iCloud 钥匙串'});
  assert.ok(!('publicKey' in item)&&!('public_key' in item)&&!('counter' in item));
  const encoded=toPasskeyItem({id:id.toString('base64'),created_at:null,device_type:null,backed_up:null,transports:null,
    label:'我的钥匙',aaguid:null,client_platform:null,authenticator_attachment:null,last_used_at:'2026-09-11T01:00:00.000Z'});
  assert.equal(encoded.id,id.toString('base64url'));
  assert.equal(encoded.backedUp,false);
  assert.equal(encoded.displayName,'我的钥匙');
  assert.equal(encoded.lastUsedAt,'2026-09-11T01:00:00.000Z');
});
