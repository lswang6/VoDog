import type {PoolClient,QueryResult} from 'pg';

type Queryable={query:(sql:string,params?:unknown[])=>Promise<QueryResult<any>>};

/** S21 §D: a standby beacon older than this is not a deliverable target for a remote ON. */
export const STANDBY_ONLINE_MS=45_000;
/** An unclaimed power intent expires; a gateway that wakes up much later must not act on it. */
export const DESIRED_POWER_TTL_MS=120_000;
/** Hard ceiling for the standby long poll. nginx `/api/v1/` proxy_read_timeout is 65 s. */
export const GATEWAY_STANDBY_HARD_CAP_MS=20_000;

export type PowerResult={desired:'on'|'off';ok:boolean;reason?:string|null;at:string};

export class GatewayPowerError extends Error{
 constructor(readonly status:number,readonly code:string,message:string){super(message);}
}

const fresh=(value:unknown,windowMs:number)=>{
 if(!value)return false;
 const at=new Date(value as string).getTime();
 return Number.isFinite(at)&&Date.now()-at<=windowMs;
};

function powerResultDto(value:unknown):PowerResult|null{
 if(!value||typeof value!=='object')return null;
 const raw=value as Record<string,unknown>;
 if(raw.desired!=='on'&&raw.desired!=='off')return null;
 return {desired:raw.desired,ok:raw.ok===true,reason:typeof raw.reason==='string'?raw.reason:null,at:String(raw.at??'')};
}

export function gatewayPowerDto(row:any,onlineSeconds:number){
 const online=row.control_enabled===true&&fresh(row.last_seen_at,onlineSeconds*1000);
 const desiredPower=fresh(row.desired_power_requested_at,DESIRED_POWER_TTL_MS)?(row.desired_power??null):null;
 return {
  gatewayId:row.id,
  name:row.name,
  kind:row.kind,
  controlEnabled:row.control_enabled===true,
  online,
  lastSeenAt:row.last_seen_at??null,
  standbyOnline:fresh(row.standby_seen_at,STANDBY_ONLINE_MS),
  standbySeenAt:row.standby_seen_at??null,
  remotePowerAllowed:row.remote_power_allowed===true,
  desiredPower,
  desiredPowerRequestedAt:desiredPower?row.desired_power_requested_at:null,
  lastPowerResult:powerResultDto(row.last_power_result),
  occupied:Number(row.occupied??0)>0,
 };
}

const POWER_COLUMNS=`g.id,g.name,g.kind,g.control_enabled,g.last_seen_at,g.standby_seen_at,g.remote_power_allowed,
  g.desired_power,g.desired_power_requested_at,g.last_power_result,
  (SELECT count(*)::int FROM gateway_call_locks l WHERE l.gateway_id=g.id) occupied`;

/** Visibility: admins see every gateway, a user sees the gateways hosting any SIM they own. */
export async function listGatewayPower(db:Queryable,principal:{userId:string;isAdmin:boolean},onlineSeconds:number){
 const q=principal.isAdmin
  ? await db.query(`SELECT ${POWER_COLUMNS} FROM gateways g ORDER BY g.name,g.id`)
  : await db.query(
     `SELECT ${POWER_COLUMNS} FROM gateways g
      WHERE EXISTS(SELECT 1 FROM sims s WHERE s.gateway_id=g.id AND s.owner_user_id=$1)
      ORDER BY g.name,g.id`,
     [principal.userId],
    );
 return q.rows.map(row=>gatewayPowerDto(row,onlineSeconds));
}

export async function readGatewayPower(db:Queryable,principal:{userId:string;isAdmin:boolean},gatewayId:string,onlineSeconds:number){
 const q=principal.isAdmin
  ? await db.query(`SELECT ${POWER_COLUMNS} FROM gateways g WHERE g.id=$1`,[gatewayId])
  : await db.query(
     `SELECT ${POWER_COLUMNS} FROM gateways g
      WHERE g.id=$1 AND EXISTS(SELECT 1 FROM sims s WHERE s.gateway_id=g.id AND s.owner_user_id=$2)`,
     [gatewayId,principal.userId],
    );
 if(!q.rowCount)return null;
 return gatewayPowerDto(q.rows[0],onlineSeconds);
}

/**
 * Writes the power intent. Remote OFF is deliberately more conservative than the local switch
 * (S21 decision 6): the remote user cannot see the phone, so an occupied gateway refuses.
 */
export async function requestGatewayPower(
 c:PoolClient,
 principal:{userId:string;isAdmin:boolean},
 gatewayId:string,
 desired:'on'|'off',
 onlineSeconds:number,
):Promise<{item:ReturnType<typeof gatewayPowerDto>;written:boolean}>{
 const locked=await c.query(`SELECT id FROM gateways WHERE id=$1 FOR UPDATE`,[gatewayId]);
 if(!locked.rowCount)throw new GatewayPowerError(404,'NOT_FOUND','Gateway not found');
 if(!principal.isAdmin){
  const owns=await c.query(`SELECT 1 FROM sims WHERE gateway_id=$1 AND owner_user_id=$2 LIMIT 1`,[gatewayId,principal.userId]);
  if(!owns.rowCount)throw new GatewayPowerError(404,'NOT_FOUND','Gateway not found');
 }
 const current=gatewayPowerDto((await c.query(`SELECT ${POWER_COLUMNS} FROM gateways g WHERE g.id=$1`,[gatewayId])).rows[0],onlineSeconds);
 if(!current.remotePowerAllowed)
  throw new GatewayPowerError(409,'GATEWAY_REMOTE_POWER_NOT_ALLOWED','Remote power is not enabled on this gateway');
 if(desired==='on'){
  // Checked before the standby freshness: a gateway that is already ON stopped its standby beacon,
  // so the freshness test alone would make the idempotent success unreachable.
  if(current.online)return {item:current,written:false};
  if(!current.standbyOnline)
   throw new GatewayPowerError(409,'GATEWAY_STANDBY_OFFLINE','Gateway standby beacon is not connected');
 }else{
  if(!current.online)throw new GatewayPowerError(409,'GATEWAY_OFFLINE','Gateway is offline or already disabled');
  if(current.occupied)throw new GatewayPowerError(409,'GATEWAY_IN_USE','Gateway currently holds a cellular call');
 }
 const updated=await c.query(
  `UPDATE gateways SET desired_power=$2,desired_power_requested_by=$3,desired_power_requested_at=now(),last_power_result=NULL
   WHERE id=$1 RETURNING id`,
  [gatewayId,desired,principal.userId],
 );
 if(!updated.rowCount)throw new GatewayPowerError(404,'NOT_FOUND','Gateway not found');
 const item=gatewayPowerDto((await c.query(`SELECT ${POWER_COLUMNS} FROM gateways g WHERE g.id=$1`,[gatewayId])).rows[0],onlineSeconds);
 return {item,written:true};
}

/**
 * Consume-on-delivery. One statement so two concurrent standby polls (or a standby racing the
 * POST) can never both take the same intent, and a failed enable cannot hot-loop on a stale one.
 */
export async function consumeDesiredPower(db:Queryable,gatewayId:string,desired:'on'|'off'):Promise<boolean>{
 const q=await db.query(
  `UPDATE gateways SET desired_power=NULL,desired_power_requested_by=NULL,desired_power_requested_at=NULL
   WHERE id=$1 AND desired_power=$2 AND desired_power_requested_at>now()-($3::text||' milliseconds')::interval
   RETURNING id`,
  [gatewayId,desired,DESIRED_POWER_TTL_MS],
 );
 return q.rowCount!==0;
}

/**
 * Standby beacon bookkeeping. `last_seen_at` is deliberately untouched: a phone whose control
 * switch is OFF must never count as online, and the beacon carries no telephony/SIM/media data.
 */
export async function recordStandby(db:Queryable,gatewayId:string,input:{remotePowerAllowed:boolean;lastPowerResult?:PowerResult|null}){
 await db.query(
  `UPDATE gateways SET standby_seen_at=now(),remote_power_allowed=$2,control_enabled=false,
     last_power_result=COALESCE($3::jsonb,last_power_result) WHERE id=$1`,
  [gatewayId,input.remotePowerAllowed,input.lastPowerResult?JSON.stringify(input.lastPowerResult):null],
 );
}
