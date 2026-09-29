import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { safeRollback, withClient, type Db } from './db.js';
type Identity = { userId: string; sessionId: string; platform: string | null };
export function registerPushRoutes(app: FastifyInstance, db: Db, authorize: (request: FastifyRequest) => Identity) {
  const token = z.string().min(32).max(512).regex(/^[0-9a-f]+$/i).transform(v => v.toLowerCase());
  // S67: absent = keep the stored choice (older clients push no badge at all).
  const badge = z.object({ calls: z.boolean(), sms: z.boolean() }).optional();
  const fcmToken = z.string().min(32).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value),'FCM token contains control characters');
  app.put('/api/v1/push/registrations/:installationId', async (req, reply) => {
    const identity = authorize(req);
    const { installationId } = z.object({ installationId: z.uuid() }).parse(req.params);
    const platform = z.object({platform:z.enum(['ios','android'])}).parse(req.body).platform;
    if (identity.platform !== platform) return reply.code(403).send({ error: { code: 'PLATFORM_MISMATCH', message: `An ${platform} session is required` } });
    const body = platform === 'ios'
      ? z.object({ platform: z.literal('ios'), bundleId: z.literal('org.vodog'), environment: z.enum(['development','production']), deviceName: z.string().min(1).max(120), apnsToken: token.optional(), voipToken: token.optional(), badge }).parse(req.body)
      : z.object({ platform: z.literal('android'), packageName: z.literal('org.vodog'), deviceName: z.string().min(1).max(120), fcmToken, badge }).parse(req.body);
    const badgeCalls = body.badge?.calls ?? null, badgeSms = body.badge?.sms ?? null;
    return withClient(db, async (client) => {
     try {
      await client.query('BEGIN');
      // Token rotation/reinstall/account switching has one active destination binding.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('vodog-push-registration'))");
      if (body.platform === 'android') {
        await client.query(`UPDATE push_registrations SET fcm_token=NULL,updated_at=now()
          WHERE installation_id<>$1 AND fcm_token=$2`,[installationId,body.fcmToken]);
        const result=await client.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,fcm_token,apns_token,voip_token,badge_calls,badge_sms)
          VALUES($1,$2,$3,'android',NULL,$4,$5,$6,NULL,NULL,COALESCE($7::boolean,false),COALESCE($8::boolean,false))
          ON CONFLICT(installation_id) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,platform='android',environment=NULL,
          package_name=excluded.package_name,device_name=excluded.device_name,fcm_token=excluded.fcm_token,apns_token=NULL,voip_token=NULL,
          badge_calls=COALESCE($7::boolean,push_registrations.badge_calls),badge_sms=COALESCE($8::boolean,push_registrations.badge_sms),disabled_at=NULL,updated_at=now() RETURNING id,installation_id,fcm_token IS NOT NULL fcm_enabled,updated_at`,
          [installationId,identity.userId,identity.sessionId,body.packageName,body.deviceName,body.fcmToken,badgeCalls,badgeSms]);
        await client.query('COMMIT');const row=result.rows[0];
        return {registration:{id:row.id,installationId:row.installation_id,fcmEnabled:row.fcm_enabled,updatedAt:row.updated_at}};
      }
      await client.query(`UPDATE push_registrations SET
        apns_token=CASE WHEN apns_token=$2 THEN NULL ELSE apns_token END,
        voip_token=CASE WHEN voip_token=$3 THEN NULL ELSE voip_token END,updated_at=now()
        WHERE installation_id<>$1 AND environment=$4 AND (apns_token=$2 OR voip_token=$3)`, [installationId,body.apnsToken??null,body.voipToken??null,body.environment]);
      const result = await client.query(`INSERT INTO push_registrations(installation_id,user_id,session_id,platform,environment,package_name,device_name,apns_token,voip_token,fcm_token,badge_calls,badge_sms)
        VALUES($1,$2,$3,'ios',$4,NULL,$5,$6,$7,NULL,COALESCE($8::boolean,false),COALESCE($9::boolean,false))
        ON CONFLICT(installation_id) DO UPDATE SET user_id=excluded.user_id,session_id=excluded.session_id,platform='ios',environment=excluded.environment,package_name=NULL,device_name=excluded.device_name,
        apns_token=CASE WHEN push_registrations.user_id=excluded.user_id AND push_registrations.environment=excluded.environment THEN COALESCE(excluded.apns_token,push_registrations.apns_token) ELSE excluded.apns_token END,
        voip_token=CASE WHEN push_registrations.user_id=excluded.user_id AND push_registrations.environment=excluded.environment THEN COALESCE(excluded.voip_token,push_registrations.voip_token) ELSE excluded.voip_token END,
        fcm_token=NULL,badge_calls=COALESCE($8::boolean,push_registrations.badge_calls),badge_sms=COALESCE($9::boolean,push_registrations.badge_sms),disabled_at=NULL,updated_at=now() RETURNING id,installation_id,apns_token IS NOT NULL apns_enabled,voip_token IS NOT NULL voip_enabled,updated_at`,
        [installationId,identity.userId,identity.sessionId,body.environment,body.deviceName,body.apnsToken??null,body.voipToken??null,badgeCalls,badgeSms]);
      await client.query('COMMIT'); const row=result.rows[0];
      return {registration:{id:row.id,installationId:row.installation_id,apnsEnabled:row.apns_enabled,voipEnabled:row.voip_enabled,updatedAt:row.updated_at}};
     } catch(error) { await safeRollback(client); throw error; }
    });
  });
  app.delete('/api/v1/push/registrations/:installationId', async (req, reply) => {
    const identity=authorize(req);const {installationId}=z.object({installationId:z.uuid()}).parse(req.params);
    await db.query('UPDATE push_registrations SET disabled_at=now(),apns_token=NULL,voip_token=NULL,fcm_token=NULL,updated_at=now() WHERE installation_id=$1 AND user_id=$2 AND session_id=$3',[installationId,identity.userId,identity.sessionId]);
    return reply.code(204).send();
  });
}
