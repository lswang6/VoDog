import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test,{before,after} from 'node:test';
import {buildApp} from '../src/app.js';
import {createDb} from '../src/db.js';
import {hashPassword} from '../src/security.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.includes('test'))throw new Error('isolated TEST_DATABASE_URL required');
const db=createDb(url);let app:Awaited<ReturnType<typeof buildApp>>,owner:string,token:string,gw:string,sim:string;
const config={DATABASE_URL:url,PUBLIC_ORIGIN:'https://vodog.test',RP_ID:'vodog.test',COOKIE_SECRET:'test-only-cookie-secret-at-least-32-characters',GATEWAY_ONLINE_SECONDS:30,PORT:3199,AI_ENABLED:false,AI_WORKER_READY:false,TRANSCRIPTION_ENABLED:false,COMMAND_REPLAY_HORIZON_ENABLED:false,COMMAND_REPLAY_MIGRATION_ENABLED:false};
before(async()=>{
 await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
 await db.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));
 await db.query(await readFile(new URL('../src/transcription/schema.sql',import.meta.url),'utf8'));
 owner=(await db.query(`INSERT INTO users(email,password_hash) VALUES('s89@example.test',$1) RETURNING id`,[await hashPassword('correct horse battery staple')])).rows[0].id;
 gw=(await db.query(`INSERT INTO gateways(name,control_enabled) VALUES('s89',true) RETURNING id`)).rows[0].id;
 sim=(await db.query(`INSERT INTO sims(gateway_id,slot_index,owner_user_id,label,device_present,protected_iccid_hash,country_iso) VALUES($1,0,$2,'s89',true,$3,'CN') RETURNING id`,[gw,owner,crypto.randomUUID()])).rows[0].id;
 app=await buildApp(db,config);
 const r=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'s89@example.test',password:'correct horse battery staple',platform:'android'}});assert.equal(r.statusCode,200,r.body);token=r.json().token;
 // 620 rows: groups of 4 share one microsecond timestamp (ties), sub-millisecond spacing so ms-truncated cursors would break.
 await db.query(`INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,generation,created_at)
   SELECT $1,$2,$3,'incoming','+8613800000000','m'||i,'delivered',1,timestamptz '2026-09-01 00:00:00.000001+00'+((i/4)*7)*interval '1 microsecond'
   FROM generate_series(0,619) i`,[gw,sim,owner]);
});
after(async()=>{await app?.close();await db.end();});
const get=(qs='')=>app.inject({method:'GET',url:`/api/v1/sms${qs}`,headers:{authorization:`Bearer ${token}`}});
async function all(limit:number){
 const ids:string[]=[];let cursor:any=null,pages=0;
 do{const r=await get(`?limit=${limit}`+(cursor?`&before=${encodeURIComponent(cursor.before)}&beforeId=${cursor.beforeId}`:''));assert.equal(r.statusCode,200,r.body);
  const b=r.json();ids.push(...b.items.map((x:any)=>x.id));cursor=b.nextCursor;pages++;
  if(cursor){assert.equal(b.items.length,limit);assert.equal(cursor.beforeId,b.items.at(-1).id);assert.match(cursor.before,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);}
 }while(cursor);
 return {ids,pages};
}
const expected=async()=>(await db.query(`SELECT id FROM sms_messages WHERE snapshot_owner_id=$1 ORDER BY created_at DESC,id DESC`,[owner])).rows.map(r=>r.id);

test('pages over >500 rows with ties are complete, ordered by (created_at,id) desc, no duplicates',async()=>{
 const want=await expected();assert.equal(want.length,620);
 for(const limit of [500,7,3]){const {ids,pages}=await all(limit);assert.deepEqual(ids,want);assert.equal(new Set(ids).size,620);assert.equal(pages,Math.ceil(621/limit));}
});
test('default limit stays 50, max 500, one-sided cursor is 400',async()=>{
 const r=await get();assert.equal(r.statusCode,200);assert.equal(r.json().items.length,50);assert.ok(r.json().nextCursor);
 assert.equal((await get('?limit=501')).statusCode,400);assert.equal((await get('?limit=500')).statusCode,200);
 assert.equal((await get('?before=2026-09-01T00:00:00.000001Z')).statusCode,400);
 assert.equal((await get(`?beforeId=${crypto.randomUUID()}`)).statusCode,400);
 assert.equal((await get(`?before=nope&beforeId=${crypto.randomUUID()}`)).statusCode,400);
});
test('deleted row is absent on the next full fetch',async()=>{
 const want=await expected();const gone=want[250]!;
 await db.query(`DELETE FROM sms_messages WHERE id=$1`,[gone]);
 const {ids}=await all(500);assert.equal(ids.length,619);assert.ok(!ids.includes(gone));assert.deepEqual(ids,want.filter(x=>x!==gone));
});
