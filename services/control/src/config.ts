import { z } from 'zod';

const optionalSecret=z.preprocess(value=>value===""?undefined:value,z.string().min(32).optional());
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PUBLIC_ORIGIN: z.string().url().default('https://vodog.example.com'),
  RP_ID: z.string().min(1).default('vodog.example.com'),
  ANDROID_PASSKEY_ORIGINS: z.string().regex(/^android:apk-key-hash:[A-Za-z0-9_-]{43}(,android:apk-key-hash:[A-Za-z0-9_-]{43})*$/).optional(),
  COOKIE_SECRET: z.string().min(32),
  GATEWAY_ONLINE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  // Command doorbell hold ceiling. 0 disables the long poll entirely; the 8 s hard cap keeps the
  // suspended request well inside every proxy read timeout on the path. Out of range refuses to start.
  GATEWAY_COMMAND_DOORBELL_MAX_MS: z.coerce.number().int().min(0).max(8000).default(0),
  // S21 §D standby beacon hold ceiling. Separate from the command doorbell's 8 s cap: this request
  // carries no telephony data and only has to stay inside nginx's 65 s read timeout. 0 disables the wait.
  GATEWAY_STANDBY_MAX_HOLD_MS: z.coerce.number().int().min(0).max(20000).default(20000),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  AI_ENABLED: z.enum(['true','false']).default('false').transform(v => v === 'true'),
  AI_WORKER_READY: z.enum(['true','false']).default('false').transform(v => v === 'true'),
  AI_INTERNAL_TOKEN: optionalSecret,
  AI_MEDIA_NODE_ID: z.preprocess(value=>value===""?undefined:value,z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional()),
  // S24 决策 3. Comma-separated ids of the voice providers this deployment is actually configured for.
  // Stays a string in Config on purpose: the DB tests build config objects by hand and never see this
  // key, so every reader goes through `parseVoiceProviders`, which defaults to xAI alone.
  AI_VOICE_PROVIDERS: z.preprocess(value=>value===""?undefined:value,
    z.string().regex(/^[a-z][a-z0-9_-]{0,31}(,[a-z][a-z0-9_-]{0,31})*$/).default('xai')),
  MEDIA_QUALITY_PROBES_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  MEDIA_NODES_JSON: z.string().min(2).optional(),
  MEDIA_DEFAULT_NODE_ID: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).default('relay-primary'),
  // S73b: human-call room node when both ends' probe evidence does not show it failing. Unset = probe selection only.
  MEDIA_PREFERRED_NODE_ID: z.preprocess(value=>value===""?undefined:value,z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional()),
  // S71: gateway-on-cellular TURN relay (relay-secondary TCP → tunnel → relay-primary coturn TLS). Both or neither; unset = off.
  MEDIA_RELAY_TURN_TLS_URL: z.preprocess(value=>value===""?undefined:value,z.string().regex(/^turns:[A-Za-z0-9.-]+:([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\?transport=tcp$/).optional()),
  MEDIA_RELAY_NODE_ID: z.preprocess(value=>value===""?undefined:value,z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional()),
  MEDIA_RELAY_TURN_HOSTNAME: z.preprocess(value=>value===""?undefined:value,z.string().max(253).regex(/^(?=.*[A-Za-z])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/).optional()),
  APNS_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_KEY_PATH: z.string().startsWith("/").optional(),
  MEDIA_SECRET: optionalSecret,
  TURN_SECRET: optionalSecret,
  RECORDING_ROOT: z.preprocess(value=>value===""?undefined:value,z.string().min(1).optional()),
  // S36 C4: where transcoded MP3 exports are cached. Unset keeps `format=mp3` on its 501.
  RECORDING_MP3_CACHE_DIR: z.preprocess(value=>value===""?undefined:value,z.string().startsWith('/').optional()),
  PIXEL_ARCHIVE_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  PIXEL_ARCHIVE_ROOT: z.preprocess(value=>value===""?undefined:value,z.string().startsWith('/').optional()),
  PIXEL_ARCHIVE_VALIDATOR_PATH: z.preprocess(value=>value===""?undefined:value,z.string().startsWith('/').optional()),
  PIXEL_ARCHIVE_MAX_BYTES_PER_ARCHIVE: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(2415919104),
  PIXEL_ARCHIVE_MAX_BYTES_PER_GATEWAY: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(21474836480),
  PIXEL_ARCHIVE_MAX_BYTES_PER_OWNER: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(10737418240),
  PIXEL_ARCHIVE_MAX_PENDING_PER_GATEWAY: z.coerce.number().int().min(1).max(16).default(2),
  PIXEL_ARCHIVE_MIN_FREE_BYTES: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1073741824),
  PIXEL_ARCHIVE_FINALIZE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  TRANSCRIPTION_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  TRANSCRIPTION_ENABLED_AT: z.preprocess(value=>value===""?undefined:value,z.string().datetime({offset:true}).optional()),
  TRANSCRIPTION_API_KEY: z.preprocess(value=>value===""?undefined:value,z.string().min(1).optional()),
  TRANSCRIPTION_MODEL: z.preprocess(value=>value===""?undefined:value,z.string().max(120).optional()),
  // S23 决策 5. Set it and transcription goes to the OpenAI-compatible `/chat/completions` server;
  // unset (or empty) keeps the native Gemini `generateContent` path. Rollback is removing the key.
  TRANSCRIPTION_BASE_URL: z.preprocess(value=>value===""?undefined:value,z.string().url().optional()),
  // Optional second model on the same compatible server, tried only after the configured model stalls.
  TRANSCRIPTION_FALLBACK_MODEL: z.preprocess(value=>value===""?undefined:value,z.string().max(120).optional()),
  REPORT_AI_BASE_URL: z.preprocess(value=>value===""?undefined:value,z.string().url().optional()),
  REPORT_AI_API_KEY: z.preprocess(value=>value===""?undefined:value,z.string().min(1).optional()),
  REPORT_AI_MODEL: z.preprocess(value=>value===""?undefined:value,z.string().min(1).max(120).optional()),
  TRANSCRIPTION_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
  TRANSCRIPTION_SCAN_BATCH: z.coerce.number().int().min(1).max(10).default(2),
  WEB_CALL_LIVENESS_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  FCM_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  FCM_PROJECT_ID: z.preprocess(value=>value===""?undefined:value,z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).optional()),
  FCM_CREDENTIALS_PATH: z.preprocess(value=>value===""?undefined:value,z.string().startsWith('/').optional()),
  // S36 C1: an Android client older than the `remoteNumber` data key drops the whole push, so the
  // number only travels after the new client shipped. Rollback is turning this back off.
  FCM_PUSH_REMOTE_NUMBER: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S36 C2: a gateway APK without `dtmf` in REPLAY_COMMAND_KINDS rejects any replay proposal counting
  // one, which blocks the horizon and withdraws the gateway's capabilities. Stays off until every
  // gateway runs the DTMF-capable build; rollback is turning it back off.
  CALL_DTMF_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S38: busy-conflict handling for a second incoming call while the owner is already on a human
  // call. Off = the pre-S38 `local_only` behaviour, which is also the rollback.
  BUSY_CONFLICT_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S86: a call a third-party screening app (拦截猫 etc.) blocked adds its number to the owner's call
  // blocklist. Off = only the call record is kept, which is also the rollback.
  SCREENING_APP_AUTO_BLOCK_ENABLED: z.enum(['true','false']).default('true').transform(v=>v==='true'),
  // S56: let an unanswered VoDog outgoing call open its media leg without a capture identity
  // so clients hear carrier ringback/busy tones; rides the heartbeat as `earlyMedia`. Off = rollback.
  EARLY_MEDIA_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S38: record and archive calls the user dials on the Pixel itself. Off = the gateway's
  // outgoing-observed reports are acknowledged but never become call records.
  PIXEL_ORIGINATED_CALLS_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S39 §决策6: only gates whether the snapshot response carries the queue. The queue rows are
  // written by the deletion trigger regardless, so turning this back off is a complete rollback.
  // S50: store SMS the user sent on the Pixel itself. Default on (the route shipped unflagged); off =
  // reports are still fenced and journaled in device_events but settle `local_only`, the rollback.
  SMS_OUTGOING_OBSERVED_ENABLED: z.enum(['true','false']).default('true').transform(v=>v==='true'),
  CALL_LOG_PURGE_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S55: the Pixel's own system blocklist writes back to Control. Off = the gateway only mirrors
  // Control→phone and the phone-changes route answers 409; dry-run (default) = the gateway only files
  // its merge plan as a diagnostic. Heartbeat carries the mode as `numberBlocklist.phoneSync`.
  PHONE_BLOCKLIST_SYNC_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  PHONE_BLOCKLIST_SYNC_DRY_RUN: z.enum(['true','false']).default('true').transform(v=>v==='true'),
  // S39 §5: relay-primary's hourly relay-secondary→relay-primary recording mirror root. Unset = only retention's orphan sweep reclaims it.
  RECORDING_BACKUP_ROOT: z.preprocess(value=>value===""?undefined:value,z.string().startsWith('/').optional()),
  COMMAND_REPLAY_MIGRATION_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  COMMAND_REPLAY_HORIZON_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  // S67: the 5 s badge worker pushes app-icon counts over APNs (regular token) and FCM.
  BADGE_PUSH_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  TURNSTILE_ENABLED: z.enum(['true','false']).default('false').transform(v=>v==='true'),
  TURNSTILE_SITE_KEY: z.preprocess(value=>value===""?undefined:value,z.string().min(10).max(120).optional()),
  TURNSTILE_SECRET_KEY: z.preprocess(value=>value===""?undefined:value,z.string().min(10).max(120).optional()),
}).superRefine((value,ctx)=>{
  const relaySet=[value.MEDIA_RELAY_TURN_TLS_URL,value.MEDIA_RELAY_TURN_HOSTNAME,value.MEDIA_RELAY_NODE_ID].filter(Boolean).length;
  if(relaySet!==0&&relaySet!==3)ctx.addIssue({code:'custom',path:['MEDIA_RELAY_NODE_ID'],message:'MEDIA_RELAY_TURN_TLS_URL, MEDIA_RELAY_TURN_HOSTNAME and MEDIA_RELAY_NODE_ID must be set together'});
  if(value.FCM_ENABLED&&!value.FCM_PROJECT_ID)ctx.addIssue({code:'custom',path:['FCM_PROJECT_ID'],message:'FCM_PROJECT_ID is required when FCM is enabled'});
  if(value.FCM_ENABLED&&!value.FCM_CREDENTIALS_PATH)ctx.addIssue({code:'custom',path:['FCM_CREDENTIALS_PATH'],message:'FCM_CREDENTIALS_PATH is required when FCM is enabled'});
  if(value.PIXEL_ARCHIVE_ENABLED&&!value.PIXEL_ARCHIVE_ROOT)ctx.addIssue({code:'custom',path:['PIXEL_ARCHIVE_ROOT'],message:'PIXEL_ARCHIVE_ROOT is required when Pixel archive is enabled'});
  if(value.PIXEL_ARCHIVE_ENABLED&&!value.PIXEL_ARCHIVE_VALIDATOR_PATH)ctx.addIssue({code:'custom',path:['PIXEL_ARCHIVE_VALIDATOR_PATH'],message:'PIXEL_ARCHIVE_VALIDATOR_PATH is required when Pixel archive is enabled'});
  if(value.TURNSTILE_ENABLED&&!value.TURNSTILE_SITE_KEY)ctx.addIssue({code:'custom',path:['TURNSTILE_SITE_KEY'],message:'TURNSTILE_SITE_KEY is required when Turnstile is enabled'});
  if(value.TURNSTILE_ENABLED&&!value.TURNSTILE_SECRET_KEY)ctx.addIssue({code:'custom',path:['TURNSTILE_SECRET_KEY'],message:'TURNSTILE_SECRET_KEY is required when Turnstile is enabled'});
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

/** Only configured signing-certificate origins; never accept a client-supplied origin. */
export function passkeyOrigins(config: Pick<Config, "PUBLIC_ORIGIN" | "ANDROID_PASSKEY_ORIGINS">): string[] {
 return [config.PUBLIC_ORIGIN, ...(config.ANDROID_PASSKEY_ORIGINS?.split(",") ?? [])];
}
