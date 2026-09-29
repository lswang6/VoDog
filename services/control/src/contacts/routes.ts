import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Db} from '../db.js';
import {
 CONTACT_IMPORT_MAX_BYTES,
 CONTACT_IMPORT_MAX_ITEMS,
 CONTACT_SOURCES,
 addContactPhone,
 importContacts,
 insertContact,
 listContacts,
 lookupContact,
 ownerCountryIso,
 readContact,
 replaceContact,
 softDeleteContact,
} from './repository.js';

type Fail=(status:number,code:string,message:string,details?:unknown)=>never;
type Deps={
 requireUser:(req:FastifyRequest)=>{userId:string};
 mutationOrigin:(req:FastifyRequest)=>void;
 fail:Fail;
 tx:<T>(fn:(c:PoolClient)=>Promise<T>)=>Promise<T>;
 requestFingerprint:(value:unknown)=>string;
};

const phone=z.object({rawNumber:z.string().min(1).max(64),label:z.string().max(60).nullish()});
const email=z.object({address:z.string().min(3).max(320),label:z.string().max(60).nullish()});
const address=z.object({
 formatted:z.string().max(500).nullish(),label:z.string().max(60).nullish(),street:z.string().max(300).nullish(),
 city:z.string().max(120).nullish(),region:z.string().max(120).nullish(),postalCode:z.string().max(40).nullish(),country:z.string().max(120).nullish(),
});
const scalars={
 displayName:z.string().min(1).max(200),
 givenName:z.string().max(120).nullish(),
 familyName:z.string().max(120).nullish(),
 organization:z.string().max(200).nullish(),
 notes:z.string().max(2000).nullish(),
};
const contactBody=z.object({
 ...scalars,
 phones:z.array(phone).max(50).default([]),
 emails:z.array(email).max(50).default([]),
 addresses:z.array(address).max(20).default([]),
});
const contactReplaceBody=contactBody.extend({expectedVersion:z.number().int().min(1)});
const importBody=z.object({
 source:z.enum(CONTACT_SOURCES),
 sourceDeviceId:z.string().max(200).nullish(),
 contacts:z.array(z.object({
  ...scalars,
  sourceContactId:z.string().max(200).nullish(),
  phones:z.array(phone).max(50).default([]),
  emails:z.array(email).max(50).default([]),
  addresses:z.array(address).max(20).default([]),
 })).min(1).max(CONTACT_IMPORT_MAX_ITEMS),
});

/** Optional on this route, unlike the call/SMS mutations: present means it must be well formed. */
function optionalIdemKey(req:FastifyRequest,fail:Fail):string|null{
 const key=req.headers['idempotency-key'];
 if(key===undefined)return null;
 if(typeof key!=='string'||key.length<8||key.length>200)
  fail(400,'IDEMPOTENCY_KEY_REQUIRED','A valid Idempotency-Key header is required');
 return key as string;
}

export function registerContactRoutes(app:FastifyInstance,db:Db,deps:Deps){
 const {requireUser,mutationOrigin,fail,tx,requestFingerprint}=deps;

 app.get('/api/v1/contacts',async req=>{
  const {userId}=requireUser(req);
  const query=z.object({
   query:z.string().max(120).optional(),
   limit:z.coerce.number().int().min(1).max(500).default(200),
   offset:z.coerce.number().int().min(0).max(100000).default(0),
  }).parse(req.query);
  return {items:await listContacts(db,userId,query)};
 });

 // Static segment before the `:id` parameter so a lookup is never parsed as a UUID.
 app.get('/api/v1/contacts/lookup',async req=>{
  const {userId}=requireUser(req);
  const {number}=z.object({number:z.string().min(1).max(64)}).parse(req.query);
  const iso=await ownerCountryIso(db,userId);
  return {item:await lookupContact(db,userId,number,iso)};
 });

 app.get('/api/v1/contacts/:id',async req=>{
  const {userId}=requireUser(req);
  const {id}=z.object({id:z.uuid()}).parse(req.params);
  const item=await readContact(db,userId,id);
  if(!item)fail(404,'NOT_FOUND','Contact not found');
  return {item};
 });

 app.post('/api/v1/contacts',async(req,reply)=>{
  const {userId}=requireUser(req);
  mutationOrigin(req);
  const key=optionalIdemKey(req,fail);
  const body=contactBody.parse(req.body);
  if(!body.phones.length&&!body.emails.length)
   fail(400,'INVALID_REQUEST','A contact needs at least one phone number or email address');
  const iso=await ownerCountryIso(db,userId);
  const created=await tx(async c=>{
   if(key){
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${userId}:contact.create:${key}`]);
    const fingerprint=requestFingerprint(body);
    const prior=await c.query(
     `SELECT request_hash,resource_id FROM idempotency_requests WHERE user_id=$1 AND operation='contact.create' AND idem_key=$2`,
     [userId,key],
    );
    if(prior.rowCount){
     if(prior.rows[0].request_hash!==fingerprint)
      fail(409,'IDEMPOTENCY_CONFLICT','Idempotency key was used with different parameters');
     return {id:prior.rows[0].resource_id as string,replayed:true};
    }
    const inserted=await insertContact(c,userId,{...body,source:'manual'},iso);
    await c.query(
     `INSERT INTO idempotency_requests(user_id,operation,idem_key,request_hash,resource_type,resource_id)VALUES($1,'contact.create',$2,$3,'contact',$4)`,
     [userId,key,fingerprint,inserted.id],
    );
    return {id:inserted.id,replayed:false};
   }
   return {id:(await insertContact(c,userId,{...body,source:'manual'},iso)).id,replayed:false};
  });
  const item=await readContact(db,userId,created.id);
  if(!item)fail(404,'NOT_FOUND','Contact not found');
  return reply.code(created.replayed?200:201).send({item});
 });

 app.put('/api/v1/contacts/:id',async req=>{
  const {userId}=requireUser(req);
  mutationOrigin(req);
  const {id}=z.object({id:z.uuid()}).parse(req.params);
  if(!req.body||typeof req.body!=='object'||!Object.prototype.hasOwnProperty.call(req.body,'expectedVersion'))
   fail(428,'CONTACT_VERSION_REQUIRED','expectedVersion is required');
  const body=contactReplaceBody.parse(req.body);
  if(!body.phones.length&&!body.emails.length)
   fail(400,'INVALID_REQUEST','A contact needs at least one phone number or email address');
  const iso=await ownerCountryIso(db,userId);
  const updated=await tx(c=>replaceContact(c,userId,id,body,iso,body.expectedVersion));
  if(updated.status==='not_found')fail(404,'NOT_FOUND','Contact not found');
  if(updated.status==='conflict')fail(409,'CONTACT_VERSION_CONFLICT','Contact changed; refresh before saving',{currentVersion:updated.currentVersion});
  const item=await readContact(db,userId,id);
  if(!item)fail(404,'NOT_FOUND','Contact not found');
  return {item};
 });

 app.delete('/api/v1/contacts/:id',async(req,reply)=>{
  const {userId}=requireUser(req);
  mutationOrigin(req);
  const {id}=z.object({id:z.uuid()}).parse(req.params);
  const raw=req.query as Record<string,unknown>;
  if(!raw||raw.expectedVersion===undefined)fail(428,'CONTACT_VERSION_REQUIRED','expectedVersion is required');
  const {expectedVersion}=z.object({expectedVersion:z.coerce.number().int().min(1)}).parse(raw);
  const removed=await tx(c=>softDeleteContact(c,userId,id,expectedVersion));
  if(removed.status==='not_found')fail(404,'NOT_FOUND','Contact not found');
  if(removed.status==='conflict')fail(409,'CONTACT_VERSION_CONFLICT','Contact changed; refresh before deleting',{currentVersion:removed.currentVersion});
  return reply.code(204).send();
 });

 app.post('/api/v1/contacts/:id/phones',async req=>{
  const {userId}=requireUser(req);
  mutationOrigin(req);
  const {id}=z.object({id:z.uuid()}).parse(req.params);
  const body=phone.parse(req.body);
  const iso=await ownerCountryIso(db,userId);
  const result=await tx(c=>addContactPhone(c,userId,id,body,iso));
  if(!result.found)fail(404,'NOT_FOUND','Contact not found');
  if((result as {invalid?:boolean}).invalid)fail(400,'INVALID_REQUEST','A dialable number is required');
  const item=await readContact(db,userId,id);
  if(!item)fail(404,'NOT_FOUND','Contact not found');
  return {item};
 });

 // Fastify's default body limit is 1 MB; the frozen contract allows 4 MB here and nowhere else.
 app.post('/api/v1/contacts/import',{bodyLimit:CONTACT_IMPORT_MAX_BYTES},async req=>{
  const {userId}=requireUser(req);
  mutationOrigin(req);
  const body=importBody.parse(req.body);
  const iso=await ownerCountryIso(db,userId);
  return tx(c=>importContacts(c,userId,body,iso));
 });
}
