import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRecording,recordingAttachmentFilename,recordingUrl,verifyPixelTrackHeaders} from '../src/recording-contract.ts';
const id='f0f07951-cd27-48d5-a472-39f547737d7b';
const digest='a'.repeat(64);
const pixel=()=>({source:'pixel',version:2,archiveId:'c0f07951-cd27-48d5-a472-39f547737d7b',callId:id,
 manifestSha256:'f'.repeat(64),
 archiveComplete:true,captureComplete:false,startedAt:'2026-09-10T00:00:00Z',endedAt:'2026-09-10T00:01:00Z',
 tracks:['remote_original','caller_original'].map((track,i)=>({track,sourceRole:'original_capture',mediaType:'audio/wav',bytes:2044,sha256:digest,captureComplete:i===0,gapCount:i,droppedFrames:i})),
 timeline:{mediaType:'application/x-ndjson',bytes:128,sha256:digest}});
const pixelV3=()=>({...pixel(),version:3,derivedTracks:[{track:'caller_playout',sourceRole:'derived_playout',mediaType:'audio/wav',bytes:3244,sha256:'b'.repeat(64),playoutComplete:true,gapCount:0,recoveryFrames:4}]});
const legacy=()=>({version:1,callId:id,complete:true,finalizedAt:'2026-09-10T00:01:00Z',
 artifacts:['remote_original.ogg','caller_original.ogg','timeline.jsonl'].map(name=>({name,bytes:100,sha256:digest}))});
test('legacy Ogg preserves unknown capture quality; Pixel quality remains independent of successful archive',()=>{
 const old=parseRecording(legacy(),'media_node',id)!;
 assert.equal(old.version,1);assert.equal(old.captureComplete,null);assert.equal(old.tracks[0].mediaType,'audio/ogg');
 const current=parseRecording(pixel(),'pixel',id)!;
 assert.equal(current.archiveComplete,true);assert.equal(current.captureComplete,false);
 assert.equal(current.manifestSha256,'f'.repeat(64));
 assert.equal(current.tracks[1].gapCount,1);assert.equal(current.tracks[1].mediaType,'audio/wav');
 assert.deepEqual(current.derivedTracks,[]);
});
test('source, version, call identity and unpublished archive cannot be confused',()=>{
 assert.throws(()=>parseRecording(legacy(),'pixel',id));
 assert.throws(()=>parseRecording(pixel(),'media_node',id));
 for(const patch of [{source:'future'},{version:4},{callId:'c0f07951-cd27-48d5-a472-39f547737d7b'},{manifestSha256:undefined},{manifestSha256:'F'.repeat(64)},{manifestSha256:'x'},{archiveComplete:false},{captureComplete:true}])
  assert.throws(()=>parseRecording({...pixel(),...patch},'pixel',id));
 assert.throws(()=>parseRecording({...pixel(),derivedTracks:pixelV3().derivedTracks},'pixel',id));
 assert.equal(parseRecording(null,'pixel',id),null);
});
test('duplicate tracks, MIME substitutions, unsafe sizes, hashes and timeline are rejected',()=>{
 const duplicated=pixel();duplicated.tracks[1]=duplicated.tracks[0];assert.throws(()=>parseRecording(duplicated,'pixel',id));
 for(const patch of [{mediaType:'audio/ogg'},{bytes:43},{bytes:2**31},{gapCount:-1},{sha256:'x'.repeat(64)},{droppedFrames:0.5}]){
  const value=pixel();Object.assign(value.tracks[0],patch);assert.throws(()=>parseRecording(value,'pixel',id));
 }
 assert.throws(()=>parseRecording({...pixel(),timeline:{bytes:5,sha256:digest,mediaType:'text/html'}},'pixel',id));
});
test('v3 keeps derived playout separate and original completeness authoritative',()=>{
 const value=parseRecording(pixelV3(),'pixel',id)!;
 assert.equal(value.version,3);assert.equal(value.captureComplete,false);
 assert.deepEqual(value.tracks.map(track=>[track.id,track.sourceRole]),[
  ['remote_original','original_capture'],['caller_original','original_capture'],
 ]);
 assert.deepEqual(value.derivedTracks.map(track=>[track.id,track.sourceRole,track.recoveryFrames]),[
  ['caller_playout','derived_playout',4],
 ]);
 for(const derivedPatch of [{sourceRole:'original_capture'},{track:'caller_original'},{mediaType:'audio/ogg'},{bytes:43},{playoutComplete:'yes'},{gapCount:-1},{recoveryFrames:.5},{sha256:'c'}]){
  const invalid=pixelV3();Object.assign(invalid.derivedTracks[0],derivedPatch);assert.throws(()=>parseRecording(invalid,'pixel',id));
 }
 assert.throws(()=>parseRecording({...pixelV3(),derivedTracks:[]},'pixel',id));
 assert.throws(()=>parseRecording({...pixelV3(),captureComplete:true},'pixel',id));
});
test('every resource URL carries an explicit source and rejects paths supplied as track names',()=>{
 assert.equal(recordingUrl(id,'media_node'),`/api/v1/calls/${id}/recordings?source=media_node`);
 assert.equal(recordingUrl(id,'pixel','remote_original'),`/api/v1/calls/${id}/recordings/remote_original?source=pixel`);
 assert.equal(recordingUrl(id,'pixel','caller_playout'),`/api/v1/calls/${id}/recordings/caller_playout?source=pixel`);
 assert.equal(recordingUrl(id,'pixel','remote_original','attachment'),`/api/v1/calls/${id}/recordings/remote_original?source=pixel&disposition=attachment`);
 assert.equal(recordingUrl(id,'media_node','caller_original','attachment'),`/api/v1/calls/${id}/recordings/caller_original?source=media_node&disposition=attachment`);
 assert.throws(()=>recordingUrl(id,'media_node','caller_playout'));
 assert.throws(()=>recordingUrl(id,'media_node',undefined,'attachment'));
 assert.throws(()=>recordingUrl('../other','pixel'));
 assert.throws(()=>recordingUrl(id,'pixel','../secret' as never));
 // S36 C4: 只有导出下载才带 format=mp3；播放 URL 不允许带。
 assert.equal(recordingUrl(id,'pixel','remote_original','attachment','mp3'),`/api/v1/calls/${id}/recordings/remote_original?source=pixel&disposition=attachment&format=mp3`);
 assert.equal(recordingUrl(id,'media_node','caller_original','attachment','mp3'),`/api/v1/calls/${id}/recordings/caller_original?source=media_node&disposition=attachment&format=mp3`);
 assert.throws(()=>recordingUrl(id,'pixel','remote_original',undefined,'mp3'));
 assert.throws(()=>recordingUrl(id,'pixel','remote_original','attachment','wav' as never));
});
// S36 C4: `conversation` 是服务端时间对齐后的合成轨，只有 mp3 导出这一种用法。
test('the conversation mix downloads as one mp3 attachment',()=>{
 assert.equal(recordingUrl(id,'pixel','conversation','attachment','mp3'),`/api/v1/calls/${id}/recordings/conversation?source=pixel&disposition=attachment&format=mp3`);
 assert.equal(recordingUrl(id,'media_node','conversation','attachment','mp3'),`/api/v1/calls/${id}/recordings/conversation?source=media_node&disposition=attachment&format=mp3`);
 assert.throws(()=>recordingUrl(id,'pixel','conversation','attachment'));
 assert.throws(()=>recordingUrl(id,'pixel','conversation'));
 assert.equal(recordingAttachmentFilename(id,'pixel','conversation',`attachment; filename="${id}-conversation.mp3"`,'mp3'),`${id}-conversation.mp3`);
 assert.equal(recordingAttachmentFilename(id,'media_node','conversation',null,'mp3'),`${id}-conversation.mp3`);
 assert.equal(recordingAttachmentFilename(id,'pixel','conversation','attachment; filename="../secret.mp3"','mp3'),`${id}-conversation.mp3`);
});
test('optional durationMs is accepted and invalid values cannot be confused with byte-length guesses',()=>{
 const ogg=legacy();(ogg.artifacts[0] as {durationMs?:number}).durationMs=12500;(ogg.artifacts[1] as {durationMs?:number}).durationMs=8000;
 const parsedOgg=parseRecording(ogg,'media_node',id)!;
 assert.equal(parsedOgg.tracks[0].durationMs,12500);assert.equal(parsedOgg.tracks[1].durationMs,8000);
 const wav=pixel();(wav.tracks[0] as {durationMs?:number}).durationMs=32000;
 assert.equal(parseRecording(wav,'pixel',id)!.tracks[0].durationMs,32000);
 const v3=pixelV3();(v3.derivedTracks[0] as {durationMs?:number}).durationMs=4000;
 assert.equal(parseRecording(v3,'pixel',id)!.derivedTracks[0].durationMs,4000);
 const missing=parseRecording(legacy(),'media_node',id)!;
 assert.equal(missing.tracks[0].durationMs,undefined);
 for(const durationMs of [-1,0.5,'12',Number.POSITIVE_INFINITY]){
  const invalid=legacy();(invalid.artifacts[0] as {durationMs?:unknown}).durationMs=durationMs;
  assert.throws(()=>parseRecording(invalid,'media_node',id));
 }
});
test('attachment filenames stay on the owner stream and reject traversal',()=>{
 const expected=`call-${id}-pixel-remote_original.wav`;
 assert.equal(recordingAttachmentFilename(id,'pixel','remote_original',`attachment; filename="${expected}"`),expected);
 assert.equal(recordingAttachmentFilename(id,'media_node','caller_original'),`call-${id}-media_node-caller_original.ogg`);
 assert.equal(recordingAttachmentFilename(id,'pixel','remote_original','attachment; filename="../secret.wav"'),expected);
 // S36 C4: mp3 导出的兜底名必须是 .mp3，服务端不带 call-/来源前缀的名字也要认。
 assert.equal(recordingAttachmentFilename(id,'pixel','remote_original',null,'mp3'),`call-${id}-pixel-remote_original.mp3`);
 assert.equal(recordingAttachmentFilename(id,'media_node','caller_original',`attachment; filename="${id}-caller_original.mp3"`,'mp3'),`${id}-caller_original.mp3`);
 assert.equal(recordingAttachmentFilename(id,'pixel','remote_original','attachment; filename="../secret.mp3"','mp3'),`call-${id}-pixel-remote_original.mp3`);
});
function validHeaders(){return new Headers({'Content-Type':'audio/wav','ETag':`"${digest}"`,'Accept-Ranges':'bytes','Content-Range':'bytes 0-0/2044','Content-Length':'1'});}
test('WAV preflight accepts exactly bound range metadata or a matching full response',()=>{
 const track=parseRecording(pixel(),'pixel',id)!.tracks[0];
 verifyPixelTrackHeaders(206,validHeaders(),track);
 const full=validHeaders();full.delete('Content-Range');full.set('Content-Length','2044');
 verifyPixelTrackHeaders(200,full,track);
 const derived=parseRecording(pixelV3(),'pixel',id)!.derivedTracks[0];
 const derivedRange=new Headers({'Content-Type':'audio/wav','ETag':`"${'b'.repeat(64)}"`,'Accept-Ranges':'bytes','Content-Range':'bytes 0-0/3244','Content-Length':'1'});
 verifyPixelTrackHeaders(206,derivedRange,derived);
});
test('stale hash, weak ETag, wrong range and MIME cannot expose a playable WAV URL',()=>{
 const track=parseRecording(pixel(),'pixel',id)!.tracks[0];
 for(const [key,value] of [['ETag',`W/"${digest}"`],['ETag',`"${'b'.repeat(64)}"`],['Content-Type','audio/ogg'],['Content-Range','bytes 0-0/2045'],['Content-Length','2'],['Accept-Ranges','none']]){
  const headers=validHeaders();headers.set(key,value);assert.throws(()=>verifyPixelTrackHeaders(206,headers,track));
 }
 for(const status of [401,404,416,503])assert.throws(()=>verifyPixelTrackHeaders(status,validHeaders(),track));
});
