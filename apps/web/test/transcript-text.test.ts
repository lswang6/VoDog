import assert from 'node:assert/strict';
import test from 'node:test';
import {joinTranscriptText,mergeTranscriptSegments,transcriptTrackLabel} from '../src/transcript-text.ts';

const word=(text:string,startMs:number)=>({track:'remote_original',speaker:'remote',text,startMs,endMs:startMs+200});

test('per-word segments collapse into one readable block per track', () => {
 const segments=['尊','敬','的','客','户','，','欢','迎','致','电','中','国','电','信'].map((text,index)=>word(text,index*200));
 const blocks=mergeTranscriptSegments(segments);
 assert.deepEqual(blocks,[{track:'remote_original',speaker:'remote',text:'尊敬的客户，欢迎致电中国电信',startMs:0}]);
});

test('separate tracks and speakers stay separate blocks and keep their first timestamp', () => {
 const blocks=mergeTranscriptSegments([
  {track:'remote_original',speaker:'remote',text:'你好',startMs:0,endMs:400},
  {track:'caller_original',speaker:'vodog_user',text:'你好，请问',startMs:500,endMs:900},
  {track:'caller_original',speaker:'vodog_user',text:'有什么可以帮您',startMs:900,endMs:1400},
 ]);
 assert.deepEqual(blocks.map(block=>[block.track,block.text,block.startMs]),[
  ['remote_original','你好',0],
  ['caller_original','你好，请问有什么可以帮您',500],
 ]);
 const split=mergeTranscriptSegments([
  {track:'remote_original',speaker:'spk_1',text:'甲说'},
  {track:'remote_original',speaker:'spk_2',text:'乙说'},
 ]);
 assert.equal(split.length,2);
});

test('joins latin words with a space and CJK words without one', () => {
 assert.equal(joinTranscriptText(['Hello','world']),'Hello world');
 assert.equal(joinTranscriptText(['Hello','世界']),'Hello 世界');
 assert.equal(joinTranscriptText(['你','好']),'你好');
 assert.equal(joinTranscriptText(['你好','，','世界']),'你好，世界');
 assert.equal(joinTranscriptText(['a','.','b']),'a. b');
});

test('ignores empty segments and tolerates a missing segment list', () => {
 assert.deepEqual(mergeTranscriptSegments(undefined),[]);
 assert.deepEqual(mergeTranscriptSegments(null),[]);
 assert.deepEqual(mergeTranscriptSegments([{track:'remote_original',text:'   '}]),[]);
 assert.deepEqual(mergeTranscriptSegments([{track:'remote_original',text:'原文',startMs:null}]),[{track:'remote_original',speaker:'',text:'原文'}]);
});

test('labels known and unknown tracks', () => {
 assert.equal(transcriptTrackLabel('remote_original'),'对方原声');
 assert.equal(transcriptTrackLabel('caller_original'),'我的原声');
 assert.equal(transcriptTrackLabel('weird'),'其他声轨');
});
