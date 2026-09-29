import {createHash} from 'node:crypto';
import {getCountries,getCountryCallingCode} from 'libphonenumber-js';
import type {PoolClient,QueryResult} from 'pg';
import {isEmergencyServiceNumber,phoneDigitKey,phoneMatchKeys,smsAddress} from './phone-address.js';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};

export type BlockedNumberRow={
 id:string;
 owner_user_id:string;
 canonical_key:string;
 remote_number:string;
 source_call_id:string|null;
 /** S55: 'phone' = reported by a Pixel's own system blocklist. */
 source:'client'|'phone';
 /** S66: which list — 'call' rejects calls, 'sms' intercepts SMS. */
 scope:BlocklistScope;
 created_at:Date;
};

export type BlocklistScope='call'|'sms';

export type BlocklistItemDto={
 id:string;
 remoteNumber:string;
 createdAt:Date;
 sourceCallId:string|null;
 source:'client'|'phone';
 scope:BlocklistScope;
};

export type NumberBlocklistHeartbeat={
 version:number;
 /** S66: `numbers` is the call list (old gateways read only this); `smsNumbers` the SMS list. */
 items:{simId:string;numbers:string[];smsNumbers:string[]}[];
};

export type PhoneBlocklistSyncMode='off'|'dry_run'|'on';

/** S55: read per request, so a flag flip needs no rebuild of the app. */
export function phoneBlocklistSyncMode(config:{PHONE_BLOCKLIST_SYNC_ENABLED?:boolean;PHONE_BLOCKLIST_SYNC_DRY_RUN?:boolean}):PhoneBlocklistSyncMode{
 if(!config.PHONE_BLOCKLIST_SYNC_ENABLED)return 'off';
 return config.PHONE_BLOCKLIST_SYNC_DRY_RUN===false?'on':'dry_run';
}

/*
 * S55 CN number equivalence. Caller IDs and the Pixel's own blocklist spell one number several ways:
 * mobiles `+8613800001234` ≡ `13800001234`; landlines `+8675583765432` ≡ `075583765432` (never the
 * bare local part); a national service code reached through an area code `+8675595501` ≡ `075595501`
 * ≡ `95501`. A digit key maps to a set of match classes; two keys are the same number when their sets
 * overlap. Any country code in front of a CN service code is dropped too (Android prefixes the SIM or
 * roaming country: `+85295008` ≡ `95008`); ordinary numbers keep their country code strictly.
 * ponytail: CN-only; derive from sims.country_iso if a non-CN gateway ever ships.
 */
const CN_MOBILE=/^1[3-9]\d{9}$/;
const CN_SERVICE_SHORT=/^(?:95\d{3,4}|96\d{3}|10\d{3,6}|12\d{3})$/;
const CN_NATIONAL_SERVICE=/^[48]00\d{7}$/;
const CN_AREA_PATTERN='(?:10|2[0-9]|[3-9][0-9]{2})';
const CN_LANDLINE=new RegExp(`^(${CN_AREA_PATTERN})(\\d{5,8})$`);
const CALLING_CODES=new Set(getCountries().map(country=>String(getCountryCallingCode(country))));

/** `n` is a national significant number without trunk 0: `0n`, plus its service short code if it is one. */
function cnLandlineClasses(n:string):string[]{
 const match=CN_LANDLINE.exec(n);
 if(!match)return [];
 const local=match[2]!;
 return CN_SERVICE_SHORT.test(local)?[`0${n}`,local]:[`0${n}`];
}

export function blocklistMatchClasses(key:string):string[]{
 const classes=new Set([key]);
 if(key.startsWith('86')){
  const rest=key.slice(2);
  // A national code is never re-read as a landline: `+8610101196` is 10101196, not Beijing + 101196.
  if(CN_MOBILE.test(rest)||CN_SERVICE_SHORT.test(rest)||CN_NATIONAL_SERVICE.test(rest))classes.add(rest);
  else for(const value of cnLandlineClasses(rest))classes.add(value);
 }else if(key.startsWith('0')){
  for(const value of cnLandlineClasses(key.slice(1)))classes.add(value);
 }
 for(let length=1;length<=3;length++){
  const rest=key.slice(length);
  if(CALLING_CODES.has(key.slice(0,length))&&CN_SERVICE_SHORT.test(rest))classes.add(rest);
 }
 classes.delete('112');
 classes.delete('911');
 return [...classes];
}

export function blocklistKeysOverlap(left:Iterable<string>,right:Iterable<string>):boolean{
 const expanded=new Set([...left].flatMap(blocklistMatchClasses));
 for(const key of right)for(const value of blocklistMatchClasses(key))if(expanded.has(value))return true;
 return false;
}

/**
 * Every stored `canonical_key` whose classes can overlap `keys`, as `canonical_key=ANY(keys) OR
 * canonical_key ~ pattern`: the pattern catches a service code stored behind any area or country code. Over-
 * fetching is fine; callers confirm each hit with `blocklistKeysOverlap`.
 */
export function blocklistLookup(keys:Iterable<string>):{keys:string[];pattern:string|null}{
 const classes=new Set([...keys].flatMap(blocklistMatchClasses));
 const spellings=new Set<string>();
 const shorts:string[]=[];
 for(const value of classes){
  spellings.add(value);
  spellings.add(value.startsWith('0')?`86${value.slice(1)}`:`86${value}`);
  if(CN_SERVICE_SHORT.test(value))shorts.push(value);
 }
 const alternatives=shorts.join('|');
 return{keys:[...spellings],pattern:shorts.length?`^(?:(?:0|86)${CN_AREA_PATTERN}|[1-9][0-9]{0,2})(?:${alternatives})$`:null};
}

/** Candidate entries for `keys` (over-fetched); pick the real match with `blockedEntryFor`. */
export async function loadBlockedCandidates(db:Queryable,ownerUserId:string,scope:BlocklistScope,keys:Iterable<string>):Promise<{id:string;canonical_key:string}[]>{
 const lookup=blocklistLookup([...keys].filter(key=>/^\d+$/.test(key)));
 if(!lookup.keys.length)return [];
 const q=await db.query(
  `SELECT id,canonical_key FROM owner_blocked_numbers
   WHERE owner_user_id=$1 AND scope=$4 AND (canonical_key=ANY($2::text[]) OR ($3::text IS NOT NULL AND canonical_key ~ $3::text))
   ORDER BY created_at,id`,
  [ownerUserId,lookup.keys,lookup.pattern,scope],
 );
 return q.rows;
}

export function blockedEntryFor(candidates:{id:string;canonical_key:string}[],keys:string[]):string|null{
 const digits=keys.filter(key=>/^\d+$/.test(key));
 return candidates.find(row=>blocklistKeysOverlap(digits,[row.canonical_key]))?.id??null;
}

export function blocklistItemDto(row:BlockedNumberRow):BlocklistItemDto{
 return{id:row.id,remoteNumber:row.remote_number,createdAt:row.created_at,sourceCallId:row.source_call_id,source:row.source??'client',scope:row.scope};
}

export async function loadOwnerBlockedNumbers(db:Queryable,ownerUserId:string,scope:BlocklistScope):Promise<BlockedNumberRow[]>{
 const q=await db.query(
  `SELECT id,owner_user_id,canonical_key,remote_number,source_call_id,source,scope,created_at
   FROM owner_blocked_numbers WHERE owner_user_id=$1 AND scope=$2 ORDER BY created_at,id`,
  [ownerUserId,scope],
 );
 return q.rows as BlockedNumberRow[];
}

export function remoteMatchesOwnerBlocklist(
 remote:unknown,
 items:Pick<BlockedNumberRow,'canonical_key'|'remote_number'>[],
 countryIso?:unknown,
):boolean{
 if(isEmergencyServiceNumber(remote)||items.length===0)return false;
 const incoming=phoneMatchKeys(remote,countryIso);
 if(incoming.length===0)return false;
 for(const item of items){
  if(isEmergencyServiceNumber(item.remote_number)||item.canonical_key==='112'||item.canonical_key==='911')continue;
  // S55: CN spellings of one number (`+8675595501` / `075595501` / `95501`) are the same entry.
  if(blocklistKeysOverlap(incoming,[...phoneMatchKeys(item.remote_number,countryIso),item.canonical_key]))return true;
 }
 return false;
}

export async function ownerBlocksRemote(
 db:Queryable,
 ownerUserId:string,
 scope:BlocklistScope,
 remote:unknown,
 countryIso?:unknown,
):Promise<boolean>{
 const items=await loadOwnerBlockedNumbers(db,ownerUserId,scope);
 return remoteMatchesOwnerBlocklist(remote,items,countryIso);
}

export async function bumpOwnerBlocklistRevision(c:PoolClient,ownerUserId:string):Promise<number>{
 const q=await c.query(
  `INSERT INTO owner_blocklist_revisions(owner_user_id,version) VALUES($1,1)
   ON CONFLICT(owner_user_id) DO UPDATE SET version=owner_blocklist_revisions.version+1
   RETURNING version`,
  [ownerUserId],
 );
 return Number(q.rows[0].version);
}

export function canonicalBlocklistKey(remote:unknown):string|null{
 if(isEmergencyServiceNumber(remote))return null;
 return phoneDigitKey(remote);
}

/**
 * S41 decision 5: `knownVersion` is the version the gateway already applied. The gateway's own
 * apply rule is NO_OP at an equal version, so re-sending the numbers would change nothing there —
 * skip the number query and answer `items:[]`. Any later bump falls through to the full list again.
 */
export async function gatewayNumberBlocklist(c:Queryable,gatewayId:string,knownVersion?:number):Promise<NumberBlocklistHeartbeat>{
 const sims=await c.query(
  `SELECT s.id,s.owner_user_id,s.country_iso
   FROM sims s
   WHERE s.gateway_id=$1 AND s.owner_user_id IS NOT NULL AND s.device_present AND NOT s.assignment_pending
   ORDER BY s.slot_index NULLS LAST, s.id`,
  [gatewayId],
 );
 if(!sims.rowCount)return{version:0,items:[]};
 const ownerIds=[...new Set(sims.rows.map((row:{owner_user_id:string})=>row.owner_user_id))];
 const revisions=await c.query(
  `SELECT COALESCE(SUM(version),0)::bigint AS version FROM owner_blocklist_revisions WHERE owner_user_id=ANY($1::uuid[])`,
  [ownerIds],
 );
 const version=Number(revisions.rows[0]?.version??0);
 if(knownVersion===version)return{version,items:[]};
 const blocked=await c.query(
  `SELECT owner_user_id,remote_number,scope FROM owner_blocked_numbers WHERE owner_user_id=ANY($1::uuid[])`,
  [ownerIds],
 );
 const rows=blocked.rows as {owner_user_id:string;remote_number:string;scope:BlocklistScope}[];
 const items=sims.rows.map((sim:{id:string;owner_user_id:string;country_iso:string|null})=>{
  const spellings=(scope:BlocklistScope)=>{
   const numbers=new Set<string>();
   for(const entry of rows){
    if(entry.owner_user_id!==sim.owner_user_id||entry.scope!==scope)continue;
    numbers.add(entry.remote_number);
    const addressed=smsAddress(entry.remote_number,sim.country_iso).conversationAddress;
    if(addressed)numbers.add(addressed);
   }
   return [...numbers];
  };
  return{simId:sim.id,numbers:spellings('call'),smsNumbers:spellings('sms')};
 });
 return{version,items};
}

/**
 * S21 §B "intercept and record": a blocked SMS never reaches `sms_messages`, so the owner-visible
 * evidence lands here. The key is a content hash, so a gateway retry under a fresh eventId still
 * deduplicates, and a Control-side re-decision of the same message does not double-record.
 */
export async function recordSmsInterception(c:Queryable,input:{
 ownerUserId:string;simId:string;gatewayId:string;remoteNumber:string;body:string;receivedAt:string;source:'gateway'|'control';
}):Promise<void>{
 const messageKey=createHash('sha256')
  .update(`${input.simId} ${input.remoteNumber} ${new Date(input.receivedAt).toISOString()} ${input.body}`)
  .digest('hex');
 await c.query(
  `INSERT INTO sms_interceptions(owner_user_id,sim_id,gateway_id,remote_number,canonical_key,body,message_key,received_at,source)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(gateway_id,message_key) DO NOTHING`,
  [input.ownerUserId,input.simId,input.gatewayId,input.remoteNumber,canonicalBlocklistKey(input.remoteNumber),
   input.body,messageKey,input.receivedAt,input.source],
 );
}

export type InterceptionRow={
 id:string;kind:'call'|'sms';sim_id:string;remote_number:string|null;occurred_at:Date;
 /** S38: 'phone' is the Pixel's own screening app; SMS interceptions only ever carry the first two. */
 body:string|null;source:'gateway'|'control'|'phone';sim_country_iso:string|null;sim_label:string|null;gateway_time_zone:string|null;
};

/**
 * One owner-scoped feed over both halves: blocked incoming calls live in `call_records`
 * (`failure_reason='number_blocked'`), blocked SMS in `sms_interceptions`.
 *
 * S28: `offset` is what the paged route adds; omitted, the SQL and the parameter list are the
 * legacy two-parameter ones. The secondary sort is `id DESC` in both modes — an ascending tie-break
 * was harmless while only the first page was ever asked for, but an offset needs one total order.
 * The only visible change is the relative order of two rows sharing an exact `occurred_at`.
 */
export async function loadOwnerInterceptions(db:Queryable,ownerUserId:string,limit:number,offset?:number,kind:'all'|'call'|'sms'='all',simId?:string):Promise<InterceptionRow[]>{
 // S64: the SIM filter lands in both halves before paging and always takes the last parameter.
 const params:unknown[]=offset===undefined?[ownerUserId,limit]:[ownerUserId,limit,offset];
 const sim=simId===undefined?'':`=$${params.push(simId)}`;
 const q=await db.query(
  `(SELECT c.id,'call' kind,c.sim_id,c.remote_number,c.started_at occurred_at,NULL::text body,
      COALESCE(c.blocked_source,'control') source,s.country_iso sim_country_iso,
      CASE WHEN s.owner_user_id=$1 THEN s.label ELSE NULL END sim_label,
      COALESCE(c.gateway_time_zone,g.time_zone) gateway_time_zone
    FROM call_records c LEFT JOIN sims s ON s.id=c.sim_id LEFT JOIN gateways g ON g.id=c.gateway_id
    WHERE c.snapshot_owner_id=$1 AND c.failure_reason='number_blocked'${kind==='sms'?' AND false':''}${sim&&` AND c.sim_id${sim}`})
   UNION ALL
   (SELECT i.id,'sms' kind,i.sim_id,i.remote_number,i.received_at occurred_at,i.body,i.source,s.country_iso sim_country_iso,
      CASE WHEN s.owner_user_id=$1 THEN s.label ELSE NULL END sim_label,g.time_zone gateway_time_zone
    FROM sms_interceptions i LEFT JOIN sims s ON s.id=i.sim_id LEFT JOIN gateways g ON g.id=i.gateway_id
    WHERE i.owner_user_id=$1${kind==='call'?' AND false':''}${sim&&` AND i.sim_id${sim}`})
   ORDER BY occurred_at DESC,id DESC LIMIT $2${offset===undefined?'':' OFFSET $3'}`,
  params,
 );
 return q.rows as InterceptionRow[];
}

/**
 * The feed's total in closed form: the UNION exists only to interleave the two halves for one page,
 * and counting each half by its own owner index is strictly cheaper than counting the union.
 */
export async function countOwnerInterceptions(db:Queryable,ownerUserId:string,kind:'all'|'call'|'sms'='all',simId?:string):Promise<number>{
 const sim=simId===undefined?'':' AND sim_id=$2';
 const q=await db.query(
  `SELECT (SELECT count(*) FROM call_records WHERE snapshot_owner_id=$1 AND failure_reason='number_blocked'${kind==='sms'?' AND false':''}${sim})
        + (SELECT count(*) FROM sms_interceptions WHERE owner_user_id=$1${kind==='call'?' AND false':''}${sim}) total`,
  simId===undefined?[ownerUserId]:[ownerUserId,simId],
 );
 return Number(q.rows[0].total);
}
