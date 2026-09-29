import type {PoolClient} from 'pg';

/**
 * Ends a Control-originated outgoing call whose dial the gateway has not been handed yet. The dial
 * stays `pending` with its expiry pulled to now: that is the existing "undelivered dial timed out"
 * state, so the heartbeat only ever offers it `reconciliationOnly` (never placed), the gateway rejects
 * it `command_expired`/`not_executed` and that bound ACK retires it from the replay horizon. No
 * hangup is queued: nothing reached the device. The caller holds the gateway and call row locks —
 * the heartbeat stamps `delivered_at` under the same gateway lock, so NULL here means undelivered.
 * Returns the dial command id, or null when the dial was delivered (the caller keeps its hangup path).
 */
export async function cancelUndeliveredDial(c:PoolClient,callId:string,failureReason:string|null):Promise<string|null>{
 const dial=await c.query(`UPDATE commands cmd SET expires_at=LEAST(cmd.expires_at,now())
   FROM call_records call
   WHERE cmd.call_id=$1 AND call.id=cmd.call_id AND cmd.kind='dial' AND cmd.status='pending' AND cmd.delivered_at IS NULL
     AND call.direction='outgoing' AND call.state='outgoing_pending' AND call.device_call_id IS NULL
   RETURNING cmd.id`,[callId]);
 if(!dial.rowCount)return null;
 await c.query(`UPDATE call_records SET state='ended',ended_at=COALESCE(ended_at,now()),failure_reason=$2,
   gateway_time_zone=COALESCE(gateway_time_zone,(SELECT time_zone FROM gateways WHERE id=call_records.gateway_id))
   WHERE id=$1`,[callId,failureReason]);
 await c.query(`DELETE FROM gateway_call_locks WHERE call_id=$1`,[callId]);
 return dial.rows[0].id as string;
}
