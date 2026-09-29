import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BLOCKED_BUT_THREAD_DELETE_FAILED,deleteMessages,deleteMessagesAndRefresh,deleteThread,messageThreads,type ThreadMessage} from '../src/message-threads.ts';
const m=(id:string,simId:string,number:string,time:string):ThreadMessage=>({id,simId,remoteNumber:number,createdAt:time,direction:'incoming',body:id,state:'received'});
test('same correspondent on different gateway SIMs remains in separate conversations',()=>{
 const result=messageThreads([m('1','pixel1-sim1','1768','2026-09-09T00:00:00Z'),m('2','pixel2-sim2','1768','2026-09-09T00:01:00Z')]);
 assert.equal(result.length,2);assert.equal(result[0].simId,'pixel2-sim2');
});
test('thread messages are chronological and unknown senders never merge',()=>{
 const input=[m('b','s','1768','2026-09-09T00:01:00Z'),m('a','s','1768','2026-09-09T00:00:00Z'),m('c','s','','2026-09-09T00:02:00Z'),m('d','s','','2026-09-09T00:03:00Z')];
 const result=messageThreads(input);assert.equal(result.length,3);assert.deepEqual(result.find(t=>t.number==='1768')!.messages.map(m=>m.id),['a','b']);assert.equal(input[0].id,'b');
});
test('a thread carries both keys S30 needs: the server thread address and the raw number',()=>{
 const row=(id:string,time:string,extra:Partial<ThreadMessage>):ThreadMessage=>({id,simId:'s',createdAt:time,direction:'incoming',body:id,state:'received',...extra});
 const [full]=messageThreads([
  row('a','2026-09-09T00:00:00Z',{remoteNumber:'2025550110',conversationAddress:'+12025550110'}),
  row('b','2026-09-09T00:01:00Z',{remoteNumber:'2025550110',conversationAddress:'+12025550110'}),
 ]);
 assert.equal(full!.conversationAddress,'+12025550110','删除整段对话用服务端的线程键');
 assert.equal(full!.remoteNumber,'2025550110','屏蔽用原始号码，不是归一化后的地址');
 assert.equal(full!.number,'+12025550110');
 // A pre-S30 Control sends no conversationAddress at all; the thread then falls back to the number it does have.
 const [plain]=messageThreads([row('a','2026-09-09T00:00:00Z',{number:'2025550110'})]);
 assert.equal(plain!.conversationAddress,null);
 assert.equal(plain!.remoteNumber,'2025550110');
 assert.equal(plain!.number,'2025550110');
});
test('a thread takes its contact name from the newest message that carries one (S21 §A)',()=>{
 const withName=(id:string,time:string,contactName?:string|null):ThreadMessage=>({id,simId:'s',remoteNumber:'1768',createdAt:time,direction:'incoming',body:id,state:'received',...(contactName===undefined?{}:{contactName})});
 const named=messageThreads([withName('a','2026-09-09T00:00:00Z','张三'),withName('b','2026-09-09T00:01:00Z','张三丰')]);
 assert.equal(named[0].contactName,'张三丰','a rename shows up without reloading older rows');
 const partial=messageThreads([withName('a','2026-09-09T00:00:00Z','张三'),withName('b','2026-09-09T00:01:00Z',null)]);
 assert.equal(partial[0].contactName,'张三','a row without a name falls back to an older one');
 // An old Control sends no contactName at all, and the thread must still render as a plain number.
 assert.equal(messageThreads([withName('a','2026-09-09T00:00:00Z')])[0].contactName,null);
 assert.equal(messageThreads([withName('a','2026-09-09T00:00:00Z','   ')])[0].contactName,null);
});
test('selected SMS deletion enforces 500 and returns skipped rows unchanged',async()=>{
 const request=async <T,>(_path:string,body?:unknown):Promise<T>=>({deleted:1,skipped:[{id:(body as {ids:string[]}).ids[1],reason:'in_flight'}]}) as T;
 assert.deepEqual(await deleteMessages(request,['a','b']),{deleted:1,skipped:[{id:'b',reason:'in_flight'}]});
 await assert.rejects(()=>deleteMessages(request,Array.from({length:501},(_,index)=>String(index))),/最多选择 500/);
});

test('an accepted partial delete survives a failed follow-up refresh',async()=>{
 const refreshError=new Error('temporary read failure');let reported:unknown;
 const result=await deleteMessagesAndRefresh(
  async <T,>()=>({deleted:1,skipped:[{id:'sending',reason:'in_flight'}]}) as T,
  ['deleted','sending'],
  async()=>{throw refreshError;},
  error=>{reported=error;},
 );
 assert.deepEqual(result,{deleted:1,skipped:[{id:'sending',reason:'in_flight'}]});
 assert.equal(reported,refreshError);
});
test('delete-and-block reports the durable block when thread deletion fails',async()=>{
 const paths:string[]=[];
 const thread=messageThreads([m('a','sim-1','2025550111','2026-09-09T00:00:00Z')])[0]!;
 const bodies:unknown[]=[];
 const request=async <T,>(path:string,body?:unknown):Promise<T>=>{paths.push(path);bodies.push(body);if(path==='/blocklist')return {} as T;throw new Error('network');};
 assert.deepEqual(await deleteThread(request,thread,true),{ok:false,blocked:true,deleted:0,skipped:[],error:BLOCKED_BUT_THREAD_DELETE_FAILED});
 assert.deepEqual(paths,['/blocklist','/sms/threads/delete']);
 assert.deepEqual(bodies[0],{remoteNumber:'2025550111',scope:'sms'},'S66: 删除并屏蔽 only enters the SMS blocklist');
});
