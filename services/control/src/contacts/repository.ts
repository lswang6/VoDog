import type {PoolClient,QueryResult} from 'pg';
import {isEmergencyServiceNumber,phoneCandidateKeys,phoneDigitKey,smsAddress} from '../phone-address.js';
import {blockedEntryFor as matchBlockedEntry,loadBlockedCandidates,type BlocklistScope} from '../blocklist.js';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};

export const CONTACT_SOURCES=['ios','android','web_vcard','web_csv','web_picker','manual'] as const;
export type ContactSource=(typeof CONTACT_SOURCES)[number];
/** S21 §A: a single import may not exceed this many entries (the 4 MB body cap is enforced by the route). */
export const CONTACT_IMPORT_MAX_ITEMS=2000;
export const CONTACT_IMPORT_MAX_BYTES=4*1024*1024;

export type PhoneInput={rawNumber:string;label?:string|null};
export type EmailInput={address:string;label?:string|null};
export type AddressInput={formatted?:string|null;label?:string|null;street?:string|null;city?:string|null;region?:string|null;postalCode?:string|null;country?:string|null};
export type ContactInput={
 displayName:string;givenName?:string|null;familyName?:string|null;organization?:string|null;notes?:string|null;
 phones?:PhoneInput[];emails?:EmailInput[];addresses?:AddressInput[];
};
export type ImportEntry=ContactInput&{sourceContactId?:string|null};

export type ContactDto={
 id:string;version:number;displayName:string;givenName:string|null;familyName:string|null;organization:string|null;notes:string|null;
 source:ContactSource;sourceDeviceId:string|null;sourceContactId:string|null;
 phones:{id:string;rawNumber:string;e164:string|null;canonicalKey:string;label:string|null;isPrimary:boolean;blocked:boolean;blockedEntryId:string|null}[];
 emails:{id:string;address:string;label:string|null}[];
 addresses:{id:string;formatted:string|null;label:string|null;street:string|null;city:string|null;region:string|null;postalCode:string|null;country:string|null}[];
 /** Contact level: true when any number is blocked; the entry id is the first blocked phone's. */
 blocked:boolean;blockedEntryId:string|null;createdAt:Date;updatedAt:Date;
};

/**
 * Trim, collapse internal whitespace, casefold. The import merge rule and the "same person" lookup
 * must agree exactly, so both go through this one function instead of ad-hoc SQL `lower()`.
 */
export function normalizeContactName(value:unknown):string{
 return String(value??'').trim().replace(/\s+/g,' ').toLowerCase();
}

/** Owner country for number parsing: any SIM the owner holds, otherwise CN. Never guessed per call. */
export async function ownerCountryIso(db:Queryable,ownerUserId:string):Promise<string>{
 const q=await db.query(
  `SELECT country_iso FROM sims WHERE owner_user_id=$1 AND country_iso IS NOT NULL ORDER BY slot_index NULLS LAST,id LIMIT 1`,
  [ownerUserId],
 );
 const iso=q.rows[0]?.country_iso;
 return typeof iso==='string'&&/^[A-Za-z]{2}$/.test(iso)?iso.toUpperCase():'CN';
}

export type NormalizedPhone={rawNumber:string;canonicalKey:string;e164:string|null;label:string|null};

/**
 * `canonical_key` is the E.164 spelling when the number parses for the owner country, otherwise the
 * digits-only key. Emergency and non-dialable inputs return null and are counted as skipped.
 */
export function normalizePhone(input:PhoneInput,countryIso:string):NormalizedPhone|null{
 const rawNumber=String(input?.rawNumber??'').trim();
 if(!rawNumber||rawNumber.length>64)return null;
 if(isEmergencyServiceNumber(rawNumber))return null;
 const digits=phoneDigitKey(rawNumber);
 if(!digits)return null;
 const addressed=smsAddress(rawNumber,countryIso).conversationAddress;
 const e164=addressed.startsWith('+')?addressed:null;
 const label=input.label==null?null:String(input.label).trim().slice(0,60)||null;
 return {rawNumber,canonicalKey:e164??digits,e164,label};
}

const text=(value:unknown,max=500)=>{
 if(value===null||value===undefined)return null;
 const trimmed=String(value).trim();
 return trimmed?trimmed.slice(0,max):null;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function hydrate(db:Queryable,ownerUserId:string,rows:any[]):Promise<ContactDto[]>{
 if(!rows.length)return [];
 const ids=rows.map(row=>row.id);
 const [phones,emails,addresses]=await Promise.all([
  db.query(`SELECT id,contact_id,raw_number,canonical_key,e164,label,is_primary FROM contact_phones WHERE contact_id=ANY($1::uuid[]) ORDER BY sort,id`,[ids]),
  db.query(`SELECT id,contact_id,address,label FROM contact_emails WHERE contact_id=ANY($1::uuid[]) ORDER BY sort,id`,[ids]),
  db.query(`SELECT id,contact_id,formatted,label,street,city,region,postal_code,country FROM contact_addresses WHERE contact_id=ANY($1::uuid[]) ORDER BY sort,id`,[ids]),
 ]);
 const allKeys=[...new Set(phones.rows.map((row:any)=>row.canonical_key as string))];
 // The stored blocklist key is digits-only, so expand each contact key the same way the call
 // annotation does instead of comparing the two canonical spellings directly. Same page-driven
 // shape as `annotateNumbers`: never the owner's whole blocklist. S55: CN spellings match too.
 const blockedCandidates=allKeys.length?await loadBlockedCandidates(db,ownerUserId,'call',allKeys.flatMap(key=>phoneCandidateKeys(key))):[];
 const blockedEntryFor=(canonicalKey:string):string|null=>matchBlockedEntry(blockedCandidates,phoneCandidateKeys(canonicalKey));
 const group=<T extends {contact_id:string}>(result:QueryResult<any>)=>{
  const map=new Map<string,T[]>();
  for(const row of result.rows as T[]){const list=map.get(row.contact_id)??[];list.push(row);map.set(row.contact_id,list);}
  return map;
 };
 const phoneMap=group(phones),emailMap=group(emails),addressMap=group(addresses);
 return rows.map(row=>{
  const rowPhones=(phoneMap.get(row.id)??[]).map((phone:any)=>{
   const blockedEntryId=blockedEntryFor(phone.canonical_key);
   return {id:phone.id,rawNumber:phone.raw_number,e164:phone.e164??null,canonicalKey:phone.canonical_key,
    label:phone.label??null,isPrimary:phone.is_primary===true,blocked:blockedEntryId!==null,blockedEntryId};
  });
  return {
   id:row.id,
   version:Number(row.version??1),
   displayName:row.display_name,
   givenName:row.given_name??null,
   familyName:row.family_name??null,
   organization:row.organization??null,
   notes:row.notes??null,
   source:row.source as ContactSource,
   sourceDeviceId:row.source_device_id??null,
   sourceContactId:row.source_contact_id??null,
   phones:rowPhones,
   emails:(emailMap.get(row.id)??[]).map((email:any)=>({id:email.id,address:email.address,label:email.label??null})),
   addresses:(addressMap.get(row.id)??[]).map((address:any)=>({id:address.id,formatted:address.formatted??null,label:address.label??null,street:address.street??null,city:address.city??null,region:address.region??null,postalCode:address.postal_code??null,country:address.country??null})),
   blocked:rowPhones.some(phone=>phone.blocked),
   blockedEntryId:rowPhones.find(phone=>phone.blocked)?.blockedEntryId??null,
   createdAt:row.created_at,
   updatedAt:row.updated_at,
  };
 });
}

export async function listContacts(db:Queryable,ownerUserId:string,options:{query?:string;limit:number;offset:number}):Promise<ContactDto[]>{
 const search=options.query?.trim();
 const rows=search
  ? await db.query(
     `SELECT c.* FROM contacts c WHERE c.owner_user_id=$1 AND c.deleted_at IS NULL AND (
        c.normalized_name LIKE '%'||$2||'%'
        OR EXISTS(SELECT 1 FROM contact_phones p WHERE p.contact_id=c.id AND (p.canonical_key LIKE '%'||$3||'%' OR p.raw_number LIKE '%'||$3||'%')))
      ORDER BY c.display_name,c.id LIMIT $4 OFFSET $5`,
     [ownerUserId,normalizeContactName(search),search.replace(/[%_\\]/g,''),options.limit,options.offset],
    )
  : await db.query(
     `SELECT c.* FROM contacts c WHERE c.owner_user_id=$1 AND c.deleted_at IS NULL ORDER BY c.display_name,c.id LIMIT $2 OFFSET $3`,
     [ownerUserId,options.limit,options.offset],
    );
 return hydrate(db,ownerUserId,rows.rows);
}

export async function readContact(db:Queryable,ownerUserId:string,contactId:string):Promise<ContactDto|null>{
 const rows=await db.query(`SELECT * FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,[contactId,ownerUserId]);
 if(!rows.rowCount)return null;
 return (await hydrate(db,ownerUserId,rows.rows))[0]??null;
}

/** Dial-pad lookup: the most recently updated contact holding any key of this number. */
export async function lookupContact(db:Queryable,ownerUserId:string,number:string,countryIso:string):Promise<ContactDto|null>{
 const keys=phoneCandidateKeys(number,countryIso);
 if(!keys.length)return null;
 const rows=await db.query(
  `SELECT c.* FROM contacts c WHERE c.owner_user_id=$1 AND c.deleted_at IS NULL
     AND EXISTS(SELECT 1 FROM contact_phones p WHERE p.contact_id=c.id AND p.canonical_key=ANY($2::text[]))
   ORDER BY c.updated_at DESC,c.id LIMIT 1`,
  [ownerUserId,keys],
 );
 if(!rows.rowCount)return null;
 return (await hydrate(db,ownerUserId,rows.rows))[0]??null;
}

// ---------------------------------------------------------------------------
// DTO enrichment (S21 §A): page-driven, never the whole address book
// ---------------------------------------------------------------------------

export type NumberAnnotation={contactId:string|null;contactName:string|null;blocked:boolean;blockedEntryId:string|null};
export const EMPTY_NUMBER_ANNOTATION:NumberAnnotation={contactId:null,contactName:null,blocked:false,blockedEntryId:null};
export type AnnotationTarget={remoteNumber:unknown;countryIso?:unknown};

/**
 * S66: `scope` picks which list `blocked` reflects — 'call' for calls/reports/contacts, 'sms' for SMS rows.
 * Resolves contact name and block state for one page of rows with two `= ANY($2)` queries.
 *
 * A per-request full address-book load is forbidden: clients poll every 1-2 s and relay-primary has roughly
 * 370 MB free. The key set is bounded by 4 keys per row.
 */
/** S69: `scope: null` skips the block lookup (the blocklist page itself: every row is its own entry). */
export async function annotateNumbers(db:Queryable,ownerUserId:string,targets:AnnotationTarget[],scope:BlocklistScope|null):Promise<NumberAnnotation[]>{
 if(!targets.length)return [];
 let fallback:string|null=null;
 const perTarget:string[][]=[];
 for(const target of targets){
  const iso=typeof target.countryIso==='string'&&target.countryIso?target.countryIso:(fallback??=await ownerCountryIso(db,ownerUserId));
  perTarget.push(phoneCandidateKeys(target.remoteNumber,iso));
 }
 const union=[...new Set(perTarget.flat())];
 if(!union.length)return targets.map(()=>({...EMPTY_NUMBER_ANNOTATION}));
 const [contacts,blocked]=await Promise.all([
  db.query(
   `SELECT p.canonical_key,c.id,c.display_name,c.updated_at FROM contact_phones p
      JOIN contacts c ON c.id=p.contact_id AND c.deleted_at IS NULL
    WHERE p.owner_user_id=$1 AND p.canonical_key=ANY($2::text[])
    ORDER BY c.updated_at DESC,c.id`,
   [ownerUserId,union],
  ),
  scope===null?[]:loadBlockedCandidates(db,ownerUserId,scope,union),
 ]);
 const contactByKey=new Map<string,{id:string;name:string;updatedAt:number}>();
 for(const row of contacts.rows){
  const current=contactByKey.get(row.canonical_key);
  const updatedAt=new Date(row.updated_at).getTime();
  // Several contacts may share a number; the most recently updated one wins.
  if(!current||updatedAt>current.updatedAt)contactByKey.set(row.canonical_key,{id:row.id,name:row.display_name,updatedAt});
 }
 return perTarget.map(keys=>{
  let contact:{id:string;name:string;updatedAt:number}|undefined;
  const blockedEntryId=keys.length&&blocked.length?matchBlockedEntry(blocked,keys):null;
  for(const key of keys){
   const hit=contactByKey.get(key);
   if(hit&&(!contact||hit.updatedAt>contact.updatedAt))contact=hit;
  }
  return {contactId:contact?.id??null,contactName:contact?.name??null,blocked:blockedEntryId!==null,blockedEntryId};
 });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function writeChildren(c:PoolClient,contactId:string,ownerUserId:string,input:ContactInput,countryIso:string,mode:'replace'|'merge'){
 let phonesSkipped=0;
 const phones:NormalizedPhone[]=[];
 const seen=new Set<string>();
 for(const raw of input.phones??[]){
  const phone=normalizePhone(raw,countryIso);
  if(!phone){phonesSkipped++;continue;}
  if(seen.has(phone.canonicalKey))continue;
  seen.add(phone.canonicalKey);
  phones.push(phone);
 }
 if(mode==='replace'){
  await c.query(`DELETE FROM contact_phones WHERE contact_id=$1`,[contactId]);
  await c.query(`DELETE FROM contact_emails WHERE contact_id=$1`,[contactId]);
  await c.query(`DELETE FROM contact_addresses WHERE contact_id=$1`,[contactId]);
 }
 const existingCount=mode==='merge'
  ? Number((await c.query(`SELECT count(*)::int n FROM contact_phones WHERE contact_id=$1`,[contactId])).rows[0].n)
  : 0;
 let sort=existingCount;
 for(const phone of phones){
  await c.query(
   `INSERT INTO contact_phones(contact_id,owner_user_id,raw_number,canonical_key,e164,label,is_primary,sort)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(contact_id,canonical_key) DO NOTHING`,
   [contactId,ownerUserId,phone.rawNumber,phone.canonicalKey,phone.e164,phone.label,sort===0,sort],
  );
  sort++;
 }
 const emails=(input.emails??[]).map(email=>({address:text(email?.address,320),label:text(email?.label,60)})).filter(email=>email.address);
 if(mode==='merge'&&emails.length){
  const have=new Set((await c.query(`SELECT lower(address) address FROM contact_emails WHERE contact_id=$1`,[contactId])).rows.map((row:any)=>row.address));
  let index=Number((await c.query(`SELECT count(*)::int n FROM contact_emails WHERE contact_id=$1`,[contactId])).rows[0].n);
  for(const email of emails){
   if(have.has(email.address!.toLowerCase()))continue;
   have.add(email.address!.toLowerCase());
   await c.query(`INSERT INTO contact_emails(contact_id,address,label,sort)VALUES($1,$2,$3,$4)`,[contactId,email.address,email.label,index++]);
  }
 }else if(mode==='replace'){
  let index=0;
  for(const email of emails)await c.query(`INSERT INTO contact_emails(contact_id,address,label,sort)VALUES($1,$2,$3,$4)`,[contactId,email.address,email.label,index++]);
 }
 const addresses=(input.addresses??[]).map(address=>({
  formatted:text(address?.formatted,500),label:text(address?.label,60),street:text(address?.street,300),
  city:text(address?.city,120),region:text(address?.region,120),postalCode:text(address?.postalCode,40),country:text(address?.country,120),
 })).filter(address=>Object.values(address).some(value=>value!==null));
 if(mode==='merge'&&addresses.length){
  const have=new Set((await c.query(`SELECT COALESCE(formatted,'')||'|'||COALESCE(street,'') key FROM contact_addresses WHERE contact_id=$1`,[contactId])).rows.map((row:any)=>row.key));
  let index=Number((await c.query(`SELECT count(*)::int n FROM contact_addresses WHERE contact_id=$1`,[contactId])).rows[0].n);
  for(const address of addresses){
   const key=`${address.formatted??''}|${address.street??''}`;
   if(have.has(key))continue;
   have.add(key);
   await c.query(`INSERT INTO contact_addresses(contact_id,formatted,label,street,city,region,postal_code,country,sort)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [contactId,address.formatted,address.label,address.street,address.city,address.region,address.postalCode,address.country,index++]);
  }
 }else if(mode==='replace'){
  let index=0;
  for(const address of addresses)await c.query(`INSERT INTO contact_addresses(contact_id,formatted,label,street,city,region,postal_code,country,sort)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
   [contactId,address.formatted,address.label,address.street,address.city,address.region,address.postalCode,address.country,index++]);
 }
 return {phonesSkipped,phones};
}

export async function insertContact(c:PoolClient,ownerUserId:string,input:ContactInput&{source:ContactSource;sourceDeviceId?:string|null;sourceContactId?:string|null},countryIso:string){
 const displayName=text(input.displayName,200);
 if(!displayName)throw new Error('displayName is required');
 const contact=(await c.query(
  `INSERT INTO contacts(owner_user_id,display_name,normalized_name,given_name,family_name,organization,notes,source,source_device_id,source_contact_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [ownerUserId,displayName,normalizeContactName(displayName),text(input.givenName,120),text(input.familyName,120),
   text(input.organization,200),text(input.notes,2000),input.source,text(input.sourceDeviceId,200),text(input.sourceContactId,200)],
 )).rows[0];
 const written=await writeChildren(c,contact.id,ownerUserId,input,countryIso,'replace');
 return {id:contact.id as string,...written};
}

export async function replaceContact(c:PoolClient,ownerUserId:string,contactId:string,input:ContactInput,countryIso:string,expectedVersion:number){
 const displayName=text(input.displayName,200);
 if(!displayName)throw new Error('displayName is required');
 const updated=await c.query(
  `UPDATE contacts SET display_name=$3,normalized_name=$4,given_name=$5,family_name=$6,organization=$7,notes=$8,
     version=version+1,updated_at=now()
   WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL AND version=$9 RETURNING id,version`,
  [contactId,ownerUserId,displayName,normalizeContactName(displayName),text(input.givenName,120),text(input.familyName,120),text(input.organization,200),text(input.notes,2000),expectedVersion],
 );
 if(!updated.rowCount){
  const current=await c.query(`SELECT version FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,[contactId,ownerUserId]);
  return current.rowCount?{status:'conflict' as const,currentVersion:Number(current.rows[0].version)}:{status:'not_found' as const};
 }
 await writeChildren(c,contactId,ownerUserId,input,countryIso,'replace');
 return {status:'updated' as const,version:Number(updated.rows[0].version)};
}

export async function softDeleteContact(c:PoolClient,ownerUserId:string,contactId:string,expectedVersion:number){
 const q=await c.query(`UPDATE contacts SET deleted_at=now(),version=version+1,updated_at=now()
   WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL AND version=$3 RETURNING id`,[contactId,ownerUserId,expectedVersion]);
 if(q.rowCount)return {status:'deleted' as const};
 const current=await c.query(`SELECT version FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,[contactId,ownerUserId]);
 return current.rowCount?{status:'conflict' as const,currentVersion:Number(current.rows[0].version)}:{status:'not_found' as const};
}

/** "Add to an existing contact": already-present numbers are a no-op, never a duplicate row. */
export async function addContactPhone(c:PoolClient,ownerUserId:string,contactId:string,input:PhoneInput,countryIso:string){
 const existing=await c.query(`SELECT id FROM contacts WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE`,[contactId,ownerUserId]);
 if(!existing.rowCount)return {found:false,created:false};
 const phone=normalizePhone(input,countryIso);
 if(!phone)return {found:true,created:false,invalid:true};
 const sort=Number((await c.query(`SELECT count(*)::int n FROM contact_phones WHERE contact_id=$1`,[contactId])).rows[0].n);
 const inserted=await c.query(
  `INSERT INTO contact_phones(contact_id,owner_user_id,raw_number,canonical_key,e164,label,is_primary,sort)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(contact_id,canonical_key) DO NOTHING RETURNING id`,
  [contactId,ownerUserId,phone.rawNumber,phone.canonicalKey,phone.e164,phone.label,sort===0,sort],
 );
 if(inserted.rowCount)await c.query(`UPDATE contacts SET version=version+1,updated_at=now() WHERE id=$1`,[contactId]);
 return {found:true,created:inserted.rowCount!==0};
}

export type ImportSummary={total:number;created:number;updated:number;merged:number;skipped:number;phonesSkipped:number};

/**
 * S21 §A import rules, one transaction:
 *   (owner, source, source_device_id, source_contact_id) hit -> update (children replaced)
 *   same normalized name sharing any canonical key      -> merge (children topped up)
 *   same name, no shared number                         -> still a new contact
 * Re-submitting the same payload is idempotent; the counters simply move to updated/merged.
 */
export async function importContacts(
 c:PoolClient,
 ownerUserId:string,
 payload:{source:ContactSource;sourceDeviceId?:string|null;contacts:ImportEntry[]},
 countryIso:string,
):Promise<ImportSummary>{
 const summary:ImportSummary={total:payload.contacts.length,created:0,updated:0,merged:0,skipped:0,phonesSkipped:0};
 const sourceDeviceId=text(payload.sourceDeviceId,200);
 // Same request, same person twice: collapse on canonical key + normalized name before touching the DB.
 const byIdentity=new Map<string,ImportEntry>();
 const staged:ImportEntry[]=[];
 for(const entry of payload.contacts){
  const displayName=text(entry?.displayName,200);
  if(!displayName){summary.skipped++;continue;}
  const normalized=normalizeContactName(displayName);
  const keys:string[]=[];
  for(const raw of entry.phones??[]){
   const phone=normalizePhone(raw,countryIso);
   if(phone)keys.push(phone.canonicalKey);
  }
  const identity=keys.length?keys.map(key=>`${normalized}|${key}`):null;
  const duplicate=identity?.find(key=>byIdentity.has(key));
  if(duplicate){
   const target=byIdentity.get(duplicate)!;
   target.phones=[...(target.phones??[]),...(entry.phones??[])];
   target.emails=[...(target.emails??[]),...(entry.emails??[])];
   target.addresses=[...(target.addresses??[]),...(entry.addresses??[])];
   summary.skipped++;
   continue;
  }
  const normalizedEntry:ImportEntry={...entry,displayName};
  for(const key of identity??[])byIdentity.set(key,normalizedEntry);
  staged.push(normalizedEntry);
 }
 for(const entry of staged){
  const sourceContactId=text(entry.sourceContactId,200);
  const usablePhones=(entry.phones??[]).map(phone=>normalizePhone(phone,countryIso));
  const keys=usablePhones.filter((phone):phone is NormalizedPhone=>phone!==null).map(phone=>phone.canonicalKey);
  const emails=(entry.emails??[]).filter(email=>text(email?.address,320));
  if(!keys.length&&!emails.length){
   summary.skipped++;
   summary.phonesSkipped+=usablePhones.filter(phone=>phone===null).length;
   continue;
  }
  if(sourceContactId){
   // Partial unique indexes treat NULLs as distinct, so the source lookup is an explicit
   // IS NOT DISTINCT FROM read instead of ON CONFLICT.
   const hit=await c.query(
    `SELECT id FROM contacts WHERE owner_user_id=$1 AND source=$2 AND source_device_id IS NOT DISTINCT FROM $3
       AND source_contact_id=$4 AND deleted_at IS NULL FOR UPDATE`,
    [ownerUserId,payload.source,sourceDeviceId,sourceContactId],
   );
   if(hit.rowCount){
    const displayName=text(entry.displayName,200)!;
    await c.query(
     `UPDATE contacts SET display_name=$2,normalized_name=$3,given_name=$4,family_name=$5,organization=$6,notes=$7,version=version+1,updated_at=now() WHERE id=$1`,
     [hit.rows[0].id,displayName,normalizeContactName(displayName),text(entry.givenName,120),text(entry.familyName,120),text(entry.organization,200),text(entry.notes,2000)],
    );
    const written=await writeChildren(c,hit.rows[0].id,ownerUserId,entry,countryIso,'replace');
    summary.phonesSkipped+=written.phonesSkipped;
    summary.updated++;
    continue;
   }
  }
  const normalized=normalizeContactName(entry.displayName);
  const merge=keys.length
   ? await c.query(
      `SELECT c.id FROM contacts c WHERE c.owner_user_id=$1 AND c.normalized_name=$2 AND c.deleted_at IS NULL
         AND EXISTS(SELECT 1 FROM contact_phones p WHERE p.contact_id=c.id AND p.canonical_key=ANY($3::text[]))
       ORDER BY c.updated_at DESC,c.id LIMIT 1`,
      [ownerUserId,normalized,keys],
     )
   : {rowCount:0,rows:[] as any[]};
  if(merge.rowCount){
   const written=await writeChildren(c,merge.rows[0].id,ownerUserId,entry,countryIso,'merge');
   await c.query(`UPDATE contacts SET version=version+1,updated_at=now() WHERE id=$1`,[merge.rows[0].id]);
   summary.phonesSkipped+=written.phonesSkipped;
   summary.merged++;
   continue;
  }
  const created=await insertContact(c,ownerUserId,{...entry,source:payload.source,sourceDeviceId,sourceContactId},countryIso);
  summary.phonesSkipped+=created.phonesSkipped;
  summary.created++;
 }
 return summary;
}
