CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('admin', 'user'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE call_state AS ENUM ('incoming_ringing','outgoing_pending','connecting','active','ending','ended','failed','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sms_state AS ENUM ('queued','sending','sent','delivered','failed','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
  password_hash text NOT NULL, role user_role NOT NULL DEFAULT 'user', created_at timestamptz NOT NULL DEFAULT now()
);
-- S24 决策 3: the owner picks which AI voice provider answers for them. Additive with a default, so a
-- compatible deploy never leaves a row without a provider and rollback simply stops reading the column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_voice_provider text NOT NULL DEFAULT 'xai';
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_voice_provider_version bigint NOT NULL DEFAULT 1;
DO $$ BEGIN ALTER TABLE users ADD CONSTRAINT users_ai_voice_provider_check CHECK(ai_voice_provider ~ '^[a-z][a-z0-9_-]{0,31}$'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_hash text NOT NULL UNIQUE, refresh_hash text UNIQUE, client_type text NOT NULL CHECK (client_type IN ('web','native')),
  access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz, platform text CHECK(platform IN ('web','ios','android','macos')),
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS platform text CHECK(platform IN ('web','ios','android','macos'));
CREATE TABLE IF NOT EXISTS gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, control_enabled boolean NOT NULL DEFAULT false,
  telephony_ready boolean NOT NULL DEFAULT false, media_ready boolean NOT NULL DEFAULT false,
  sms_ready boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz, device_epoch bigint NOT NULL DEFAULT 1, command_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS sms_ready boolean NOT NULL DEFAULT false;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS time_zone text;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS media_unready_since timestamptz;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS media_unready_heartbeats integer NOT NULL DEFAULT 0;
-- S58: which hardware drives the gateway. Display-only; never gates a capability.
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'pixel';
ALTER TABLE gateways DROP CONSTRAINT IF EXISTS gateways_kind_check;
ALTER TABLE gateways ADD CONSTRAINT gateways_kind_check CHECK (kind IN ('pixel','dji4g'));
CREATE TABLE IF NOT EXISTS device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gateway_id uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  secret_hash text NOT NULL UNIQUE, label text NOT NULL, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS device_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gateway_id uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gateway_id uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  slot_index smallint CHECK (slot_index BETWEEN 0 AND 7), owner_user_id uuid REFERENCES users(id),
  label text NOT NULL, phone_label text, protected_iccid_hash text, version bigint NOT NULL DEFAULT 1,
  subscription_id integer, phone_account_handle text, country_iso char(2), embedded boolean,
  assignment_pending boolean NOT NULL DEFAULT false,
  device_present boolean NOT NULL DEFAULT false
);
ALTER TABLE sims ADD COLUMN IF NOT EXISTS device_present boolean NOT NULL DEFAULT false;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS country_iso char(2);
ALTER TABLE sims ADD COLUMN IF NOT EXISTS embedded boolean;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS identity_kind text;
ALTER TABLE sims DROP CONSTRAINT IF EXISTS sims_identity_kind_check;
ALTER TABLE sims ADD CONSTRAINT sims_identity_kind_check CHECK (identity_kind IS NULL OR identity_kind IN ('iccid','cardId','fallback'));
ALTER TABLE sims DROP CONSTRAINT IF EXISTS sims_gateway_id_slot_index_key;
ALTER TABLE sims ALTER COLUMN slot_index DROP NOT NULL;
UPDATE sims SET device_present=false,slot_index=NULL,subscription_id=NULL,phone_account_handle=NULL,version=version+1
  WHERE device_present AND protected_iccid_hash IS NULL;
UPDATE sims SET slot_index=NULL,subscription_id=NULL,phone_account_handle=NULL WHERE NOT device_present;
-- S65: a SIM's stable identity is global so the row can follow the card across gateways.
DROP INDEX IF EXISTS sims_gateway_stable_identity_idx;
CREATE UNIQUE INDEX IF NOT EXISTS sims_stable_identity_idx
  ON sims(protected_iccid_hash) WHERE protected_iccid_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sims_gateway_active_slot_idx
  ON sims(gateway_id,slot_index) WHERE device_present AND slot_index IS NOT NULL;
CREATE TABLE IF NOT EXISTS sim_settings (
  sim_id uuid PRIMARY KEY REFERENCES sims(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','ai','timeout_ai')),
  timeout_seconds integer NOT NULL DEFAULT 45 CHECK (timeout_seconds BETWEEN 10 AND 120),
  version bigint NOT NULL DEFAULT 1, applied_version bigint, applied_assignment_version bigint,
  applied_generation bigint, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sim_settings ADD COLUMN IF NOT EXISTS applied_assignment_version bigint;
ALTER TABLE sim_settings ADD COLUMN IF NOT EXISTS applied_generation bigint;
CREATE TABLE IF NOT EXISTS passkeys (
  id bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL, counter bigint NOT NULL, transports text[], device_type text, backed_up boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS aaguid text;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS client_platform text;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS authenticator_attachment text;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('register','authenticate')), challenge text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS call_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gateway_id uuid NOT NULL REFERENCES gateways(id), sim_id uuid NOT NULL REFERENCES sims(id),
  snapshot_owner_id uuid NOT NULL REFERENCES users(id), direction text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  remote_number text, state call_state NOT NULL, generation bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz, ended_at timestamptz,
  claimed_by_session_id uuid REFERENCES sessions(id), originating_session_id uuid REFERENCES sessions(id),
  originating_platform text CHECK(originating_platform IN ('web','ios','android','macos','pixel')), answered_by_platform text, answered_by_device text,
  mode_snapshot text NOT NULL, failure_reason text, recording_status text NOT NULL DEFAULT 'none',
  media_node_id text, media_epoch bigint NOT NULL DEFAULT 1,
  CHECK (state <> 'active' OR answered_at IS NOT NULL)
);
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS originating_session_id uuid REFERENCES sessions(id);
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS originating_platform text CHECK(originating_platform IN ('web','ios','android','macos','pixel'));
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS device_call_id text;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS observed_at timestamptz;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS media_node_id text;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS media_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS gateway_time_zone text;
-- One-time display fallback for this Pixel's Beijing history. Never rewrite timestamptz instants.
UPDATE gateways SET time_zone='Asia/Shanghai' WHERE time_zone IS NULL;
UPDATE call_records SET gateway_time_zone='Asia/Shanghai' WHERE gateway_time_zone IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS calls_gateway_device_call_idx
  ON call_records(gateway_id,generation,device_call_id) WHERE device_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_owner_started_idx ON call_records(snapshot_owner_id, started_at DESC);
CREATE TABLE IF NOT EXISTS web_call_liveness_leases (
  call_id uuid PRIMARY KEY REFERENCES call_records(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  media_epoch bigint NOT NULL CHECK(media_epoch>0), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','expired','closed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz,
  last_command_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expired_at timestamptz
);
CREATE INDEX IF NOT EXISTS web_call_liveness_due_idx ON web_call_liveness_leases(COALESCE(next_attempt_at,expires_at)) WHERE state IN ('active','expired');
CREATE TABLE IF NOT EXISTS gateway_call_locks (
  gateway_id uuid PRIMARY KEY REFERENCES gateways(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE REFERENCES call_records(id) ON DELETE CASCADE, generation bigint NOT NULL, acquired_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gateway_id uuid NOT NULL REFERENCES gateways(id), call_id uuid REFERENCES call_records(id) ON DELETE SET NULL,
  sms_id uuid, sim_id uuid REFERENCES sims(id), generation bigint NOT NULL, sequence bigint NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acked','rejected','expired')),
  result jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(gateway_id, generation, sequence)
);
ALTER TABLE commands ADD COLUMN IF NOT EXISTS sim_id uuid REFERENCES sims(id);
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_gateway_id_sequence_key;
CREATE UNIQUE INDEX IF NOT EXISTS commands_gateway_generation_sequence_idx ON commands(gateway_id,generation,sequence);
-- Only authenticated ACKs with immutable wire fingerprint enter replay evidence.
CREATE TABLE IF NOT EXISTS gateway_command_replay_receipts (
 command_id uuid PRIMARY KEY REFERENCES commands(id) ON DELETE RESTRICT,
 fingerprint text NOT NULL, status text NOT NULL CHECK(status IN ('acked','rejected')),
 result jsonb NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gateway_command_replay_horizons (
  gateway_id uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  proposed_floor bigint NOT NULL DEFAULT 1 CHECK(proposed_floor>0), proposed_revision bigint NOT NULL DEFAULT 0,
  proposed_digest text NOT NULL DEFAULT '', committed_floor bigint NOT NULL DEFAULT 1 CHECK(committed_floor>0),
  committed_revision bigint NOT NULL DEFAULT 0, committed_digest text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','quarantined')), quarantine_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(gateway_id,generation),
  CHECK(proposed_floor>=committed_floor), CHECK(proposed_revision>=committed_revision)
);
CREATE TABLE IF NOT EXISTS gateway_command_replay_audits (
  gateway_id uuid NOT NULL, generation bigint NOT NULL, revision bigint NOT NULL,
  from_inclusive bigint NOT NULL, retire_before_sequence bigint NOT NULL, proof_digest text NOT NULL,
  proof jsonb NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(gateway_id,generation,revision),
  FOREIGN KEY(gateway_id,generation) REFERENCES gateway_command_replay_horizons(gateway_id,generation) ON DELETE RESTRICT,
  CHECK(retire_before_sequence>from_inclusive)
);
CREATE TABLE IF NOT EXISTS gateway_command_replay_migrations (
 gateway_id uuid NOT NULL REFERENCES gateways(id), intent_id uuid NOT NULL,
 from_generation bigint NOT NULL, from_sequence bigint NOT NULL,
 input_digest text NOT NULL, input jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','committed')),
 receipt jsonb, last_blockers jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz, committed_at timestamptz, confirmed_at timestamptz,
 PRIMARY KEY(gateway_id,intent_id), CHECK((state='committed')=(receipt IS NOT NULL))
);
ALTER TABLE gateway_command_replay_migrations ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS gateway_replay_one_transition_per_epoch ON gateway_command_replay_migrations(gateway_id,from_generation) WHERE state='committed';
CREATE TABLE IF NOT EXISTS idempotency_requests (
  user_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL, idem_key text NOT NULL,
  request_hash text NOT NULL, resource_type text NOT NULL, resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, operation, idem_key)
);
CREATE TABLE IF NOT EXISTS sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), gateway_id uuid NOT NULL REFERENCES gateways(id), sim_id uuid NOT NULL REFERENCES sims(id),
  snapshot_owner_id uuid NOT NULL REFERENCES users(id), direction text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  remote_number text NOT NULL, body text NOT NULL, state sms_state NOT NULL, generation bigint,
  multipart_reference text, missing_parts boolean NOT NULL DEFAULT false, sent_at timestamptz, delivered_at timestamptz,
  failure_reason text, received_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS received_at timestamptz;
CREATE INDEX IF NOT EXISTS sms_owner_created_idx ON sms_messages(snapshot_owner_id, created_at DESC);
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_sms_id_fkey;
ALTER TABLE commands ADD CONSTRAINT commands_sms_id_fkey FOREIGN KEY (sms_id) REFERENCES sms_messages(id) ON DELETE SET NULL;
-- S29 retention: purged calls must not block the replay ledger; call_id is not part of the replay fingerprint.
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_call_id_fkey;
ALTER TABLE commands ADD CONSTRAINT commands_call_id_fkey FOREIGN KEY (call_id) REFERENCES call_records(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, actor_user_id uuid REFERENCES users(id), action text NOT NULL,
  resource_type text NOT NULL, resource_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS device_events (
  gateway_id uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE, event_id uuid NOT NULL,
  event_type text NOT NULL, resource_id uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(gateway_id,event_id)
);
CREATE TABLE IF NOT EXISTS gateway_telecom_snapshots (
  gateway_id uuid PRIMARY KEY REFERENCES gateways(id) ON DELETE CASCADE,
  generation bigint NOT NULL, snapshot_id uuid NOT NULL, snapshot_sequence bigint NOT NULL DEFAULT 0,
  reported_sequence bigint NOT NULL,
  local_busy boolean NOT NULL, calls jsonb NOT NULL DEFAULT '[]', observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gateway_telecom_snapshots ADD COLUMN IF NOT EXISTS snapshot_sequence bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS media_close_jobs (
  call_id uuid PRIMARY KEY REFERENCES call_records(id) ON DELETE CASCADE,
  node_id text NOT NULL DEFAULT 'relay-primary', media_epoch bigint NOT NULL DEFAULT 1,
  close_mode text NOT NULL DEFAULT 'force' CHECK(close_mode IN ('force','wait_terminal')),
  attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz,
  completed_at timestamptz, lease_owner uuid, lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE media_close_jobs ADD COLUMN IF NOT EXISTS lease_owner uuid;
ALTER TABLE media_close_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE media_close_jobs ADD COLUMN IF NOT EXISTS node_id text NOT NULL DEFAULT 'relay-primary';
ALTER TABLE media_close_jobs ADD COLUMN IF NOT EXISTS media_epoch bigint NOT NULL DEFAULT 1;
ALTER TABLE media_close_jobs ADD COLUMN IF NOT EXISTS close_mode text NOT NULL DEFAULT 'force';
DO $$ BEGIN ALTER TABLE media_close_jobs ADD CONSTRAINT media_close_jobs_close_mode_check CHECK(close_mode IN ('force','wait_terminal')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS media_close_jobs_due_idx ON media_close_jobs(next_attempt_at) WHERE completed_at IS NULL;

-- Native destinations remain bound to the revocable login session.
CREATE TABLE IF NOT EXISTS push_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), installation_id uuid NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users(id), session_id uuid NOT NULL REFERENCES sessions(id),
 environment text NOT NULL CHECK(environment IN ('development','production')),
 device_name text NOT NULL, apns_token text, voip_token text,
 disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_registrations_owner ON push_registrations(user_id) WHERE disabled_at IS NULL;
CREATE TABLE IF NOT EXISTS push_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),call_id uuid NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
 registration_id uuid NOT NULL REFERENCES push_registrations(id),session_id uuid NOT NULL REFERENCES sessions(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,lease_id uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(call_id,registration_id,session_id)
);
CREATE INDEX IF NOT EXISTS push_deliveries_ready ON push_deliveries(next_attempt_at) WHERE state='pending';

-- Android FCM remains separate from APNs delivery state and retry semantics.
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'ios';
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS package_name text;
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS fcm_token text;
ALTER TABLE push_registrations ALTER COLUMN environment DROP NOT NULL;
DO $android_push_registration_constraints$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='push_registrations_platform_shape') THEN
  ALTER TABLE push_registrations ADD CONSTRAINT push_registrations_platform_shape CHECK(
   (platform='ios' AND environment IS NOT NULL AND package_name IS NULL AND fcm_token IS NULL)
   OR
   (platform='android' AND environment IS NULL AND package_name='org.vodog' AND apns_token IS NULL AND voip_token IS NULL)
  );
 END IF;
END $android_push_registration_constraints$;
CREATE UNIQUE INDEX IF NOT EXISTS push_registrations_fcm_token_unique ON push_registrations(fcm_token) WHERE fcm_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS android_push_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 call_id uuid NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
 registration_id uuid NOT NULL REFERENCES push_registrations(id),
 session_id uuid NOT NULL REFERENCES sessions(id),
 event text NOT NULL CHECK(event IN ('call.incoming','call.cancelled')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 lease_id uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(call_id,registration_id,session_id,event)
);
CREATE INDEX IF NOT EXISTS android_push_deliveries_ready ON android_push_deliveries(next_attempt_at) WHERE state='pending';
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS settings_version_snapshot bigint;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS assignment_version_snapshot bigint;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS timeout_seconds_snapshot integer;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS ai_trigger_at timestamptz;

CREATE TABLE IF NOT EXISTS ai_worker_instances (
  instance_id uuid PRIMARY KEY,
  boot_id uuid NOT NULL,
  protocol text NOT NULL CHECK(protocol='voice-run-v1'),
  capacity integer NOT NULL CHECK(capacity=1),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_worker_instances_live_idx ON ai_worker_instances(expires_at);
-- S24 决策 3: every heartbeat republishes the providers this instance can actually instantiate. A worker
-- that predates the column (or omits the field) keeps advertising xAI, which is the pre-S24 behaviour.
ALTER TABLE ai_worker_instances ADD COLUMN IF NOT EXISTS providers text[] NOT NULL DEFAULT '{xai}';

CREATE TABLE IF NOT EXISTS ai_call_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL UNIQUE REFERENCES call_records(id) ON DELETE CASCADE,
  gateway_id uuid NOT NULL REFERENCES gateways(id),
  snapshot_owner_id uuid NOT NULL REFERENCES users(id),
  device_generation bigint NOT NULL,
  media_epoch bigint NOT NULL CHECK(media_epoch>0),
  mode_snapshot text NOT NULL CHECK(mode_snapshot IN ('ai','timeout_ai')),
  settings_version_snapshot bigint NOT NULL,
  assignment_version_snapshot bigint NOT NULL,
  timeout_seconds_snapshot integer NOT NULL CHECK(timeout_seconds_snapshot BETWEEN 10 AND 120),
  trigger_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN (
    'pending','preparing','answer_committed','awaiting_active','active',
    'ending','reconcile_unknown','ended','failed_before_answer','lost_race'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz,
  lease_owner uuid,
  lease_boot_id uuid,
  lease_hash text,
  lease_until timestamptz,
  answer_command_id uuid UNIQUE REFERENCES commands(id),
  hangup_command_id uuid REFERENCES commands(id),
  media_attempted_at timestamptz,
  activated_at timestamptz,
  cleanup_required boolean NOT NULL DEFAULT false,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_call_runs_due_idx ON ai_call_runs(COALESCE(next_attempt_at,trigger_at),id)
  WHERE state IN ('pending','preparing','answer_committed','awaiting_active','active','ending','reconcile_unknown');
-- S24 决策 3: the provider is frozen with the rest of the incoming snapshot, so changing the setting
-- mid-call (or between claim attempts) never re-targets a run that is already in flight.
ALTER TABLE ai_call_runs ADD COLUMN IF NOT EXISTS voice_provider text NOT NULL DEFAULT 'xai';
DO $$ BEGIN ALTER TABLE ai_call_runs ADD CONSTRAINT ai_call_runs_voice_provider_check CHECK(voice_provider ~ '^[a-z][a-z0-9_-]{0,31}$'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS session_revoked_call_cleanups (
  call_id uuid PRIMARY KEY REFERENCES call_records(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  last_command_id uuid REFERENCES commands(id), last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_revoked_call_cleanups_due_idx ON session_revoked_call_cleanups(next_attempt_at,call_id) WHERE state='pending';

ALTER TABLE call_records ADD COLUMN IF NOT EXISTS ai_run_id uuid;
DO $ai_run_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_records_ai_run_id_fkey') THEN
    ALTER TABLE call_records ADD CONSTRAINT call_records_ai_run_id_fkey FOREIGN KEY(ai_run_id) REFERENCES ai_call_runs(id);
  END IF;
END $ai_run_fk$;
CREATE UNIQUE INDEX IF NOT EXISTS call_records_ai_run_unique_idx ON call_records(ai_run_id) WHERE ai_run_id IS NOT NULL;

-- Pixel recording capture identity is immutable even when call_records.generation advances for cleanup.
CREATE TABLE IF NOT EXISTS recording_capture_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL UNIQUE REFERENCES call_records(id) ON DELETE CASCADE,
  gateway_id uuid NOT NULL REFERENCES gateways(id),
  snapshot_owner_id uuid NOT NULL REFERENCES users(id),
  device_call_id text NOT NULL CHECK(length(device_call_id) BETWEEN 1 AND 200),
  telecom_creation_time_millis bigint NOT NULL CHECK(telecom_creation_time_millis>0),
  capture_generation bigint NOT NULL CHECK(capture_generation>0),
  media_node_id text NOT NULL CHECK(media_node_id ~ '^[a-z][a-z0-9_-]{0,31}$'),
  media_epoch bigint NOT NULL CHECK(media_epoch>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pixel_recording_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL UNIQUE REFERENCES call_records(id) ON DELETE CASCADE,
  capture_binding_id uuid NOT NULL UNIQUE REFERENCES recording_capture_bindings(id),
  gateway_id uuid NOT NULL REFERENCES gateways(id),
  snapshot_owner_id uuid NOT NULL REFERENCES users(id),
  client_manifest_sha256 char(64) NOT NULL CHECK(client_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  client_manifest jsonb NOT NULL,
  state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','verifying','complete','rejected')),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pixel_recording_archives_owner ON pixel_recording_archives(snapshot_owner_id,completed_at DESC) WHERE state='complete';
CREATE TABLE IF NOT EXISTS pixel_recording_upload_objects (
  archive_id uuid NOT NULL REFERENCES pixel_recording_archives(id) ON DELETE CASCADE,
  object_name text NOT NULL CHECK(object_name IN ('remote_original.wav.gz','caller_original.wav.gz','timeline.jsonl.gz')),
  kind text NOT NULL CHECK(kind IN ('wav','timeline')),
  compressed_bytes bigint NOT NULL CHECK(compressed_bytes>0), compressed_sha256 char(64) NOT NULL CHECK(compressed_sha256 ~ '^[0-9a-f]{64}$'),
  original_bytes bigint NOT NULL CHECK(original_bytes>0), original_sha256 char(64) NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$'),
  committed_offset bigint NOT NULL DEFAULT 0 CHECK(committed_offset>=0 AND committed_offset<=compressed_bytes),
  state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','uploaded','verified')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(archive_id,object_name)
);

-- Upgrade existing v2 installations before accepting v3 derived playout objects; S94 adds the v4 owner uplink.
ALTER TABLE pixel_recording_upload_objects DROP CONSTRAINT IF EXISTS pixel_recording_upload_objects_object_name_check;
ALTER TABLE pixel_recording_upload_objects ADD CONSTRAINT pixel_recording_upload_objects_object_name_check CHECK(object_name IN ('remote_original.wav.gz','caller_original.wav.gz','timeline.jsonl.gz','caller_playout.wav.gz','caller_uplink.wav.gz'));

-- S31 deletion evidence is intentionally content-free. BEFORE DELETE triggers cover both the UI
-- routes and infra/retention.py's direct SQL in the same transaction as the destructive operation.
-- The 400-day window is far beyond the gateway's one-hour retry ceiling while bounding metadata.
CREATE TABLE IF NOT EXISTS call_deletion_tombstones (
  call_id uuid PRIMARY KEY,
  gateway_id uuid NOT NULL,
  gateway_generation bigint NOT NULL CHECK(gateway_generation>0),
  archive_id uuid,
  previously_verified boolean NOT NULL,
  previously_complete boolean NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS call_deletion_tombstones_archive_idx
  ON call_deletion_tombstones(archive_id) WHERE archive_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_deletion_tombstones_expiry_idx ON call_deletion_tombstones(deleted_at);

-- S39 §B: the remote media node's copy is deleted once inside the request and then retried by
-- infra/retention.py, so the outcome has to outlive the request that produced it.
ALTER TABLE call_deletion_tombstones ADD COLUMN IF NOT EXISTS media_node_id text;
ALTER TABLE call_deletion_tombstones ADD COLUMN IF NOT EXISTS remote_recording_state text NOT NULL DEFAULT 'pending';
ALTER TABLE call_deletion_tombstones DROP CONSTRAINT IF EXISTS call_deletion_tombstones_remote_state_check;
ALTER TABLE call_deletion_tombstones ADD CONSTRAINT call_deletion_tombstones_remote_state_check
  CHECK (remote_recording_state IN ('pending','deleted','skipped','unsupported','failed'));
ALTER TABLE call_deletion_tombstones ADD COLUMN IF NOT EXISTS remote_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE call_deletion_tombstones ADD COLUMN IF NOT EXISTS remote_last_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS call_deletion_tombstones_remote_pending_idx
  ON call_deletion_tombstones(deleted_at) WHERE remote_recording_state='pending';
-- Tombstones written before this column existed carry no node; they are the local node's by
-- construction (the remote node predates none of them). Idempotent: the trigger below always
-- writes a node, so a row can never fall back into this predicate.
UPDATE call_deletion_tombstones SET remote_recording_state='skipped'
  WHERE media_node_id IS NULL AND remote_recording_state='pending';

-- S39 §决策2: the Pixel's own CallLog row is matched by number and time window, so this queue is the
-- one place a deleted call's number still lives. No foreign key on gateway_id — same reason as
-- call_deletion_tombstones: deleting the gateway must not be blocked by its own deletion evidence.
-- The trigger prunes rows after 7 days, which also bounds how long the number is retained.
CREATE TABLE IF NOT EXISTS call_log_purges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_id uuid NOT NULL,
  call_id uuid NOT NULL UNIQUE,
  device_call_id text,
  remote_number text,
  direction text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz,
  ack_status text,
  ack_deleted_rows integer
);
CREATE INDEX IF NOT EXISTS call_log_purges_gateway_pending_idx ON call_log_purges(gateway_id, created_at) WHERE acked_at IS NULL;

CREATE OR REPLACE FUNCTION preserve_call_deletion_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding_generation bigint;
  deleted_archive_id uuid;
  archive_version integer;
  was_verified boolean := false;
  was_complete boolean := false;
BEGIN
  SELECT capture_generation INTO binding_generation
    FROM recording_capture_bindings WHERE call_id=OLD.id;
  SELECT id,state='complete',COALESCE((client_manifest->>'version')::integer,2)
    INTO deleted_archive_id,was_complete,archive_version
    FROM pixel_recording_archives WHERE call_id=OLD.id;
  IF deleted_archive_id IS NOT NULL THEN
    SELECT (SELECT count(*) FROM pixel_recording_upload_objects WHERE archive_id=deleted_archive_id)
             = CASE WHEN archive_version=3 THEN 4 ELSE 3 END
       AND NOT EXISTS(
         SELECT 1 FROM pixel_recording_upload_objects
          WHERE archive_id=deleted_archive_id AND state<>'verified'
       ) INTO was_verified;
  END IF;
  INSERT INTO call_deletion_tombstones(
    call_id,gateway_id,gateway_generation,archive_id,previously_verified,previously_complete,deleted_at,
    media_node_id,remote_recording_state
  ) VALUES(
    OLD.id,OLD.gateway_id,COALESCE(binding_generation,OLD.generation),deleted_archive_id,
    COALESCE(was_verified,false),COALESCE(was_complete,false),now(),
    COALESCE(OLD.media_node_id,'relay-primary'),
    CASE WHEN COALESCE(OLD.media_node_id,'relay-primary')='relay-primary' THEN 'skipped' ELSE 'pending' END
  ) ON CONFLICT(call_id) DO NOTHING;
  DELETE FROM call_deletion_tombstones WHERE call_id IN (
    SELECT call_id FROM call_deletion_tombstones
     WHERE deleted_at < now()-interval '400 days' ORDER BY deleted_at LIMIT 1000
  );
  -- S39 §决策2: the Pixel's CallLog purge queue is written by the same trigger, so retention's own
  -- direct DELETEs are covered exactly like the UI route is.
  IF OLD.gateway_id IS NOT NULL THEN
    INSERT INTO call_log_purges(gateway_id,call_id,device_call_id,remote_number,direction,started_at,ended_at)
    VALUES(OLD.gateway_id,OLD.id,OLD.device_call_id,OLD.remote_number,OLD.direction,OLD.started_at,
           COALESCE(OLD.ended_at,OLD.started_at))
    ON CONFLICT(call_id) DO NOTHING;
  END IF;
  DELETE FROM call_log_purges WHERE id IN (
    SELECT id FROM call_log_purges
     WHERE created_at < now()-interval '7 days' ORDER BY created_at LIMIT 1000
  );
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS call_records_preserve_deletion_proof ON call_records;
CREATE TRIGGER call_records_preserve_deletion_proof BEFORE DELETE ON call_records
  FOR EACH ROW EXECUTE FUNCTION preserve_call_deletion_proof();

CREATE TABLE IF NOT EXISTS sms_deletion_tombstones (
  sms_id uuid PRIMARY KEY,
  gateway_id uuid NOT NULL,
  gateway_generation bigint,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_deletion_tombstones_expiry_idx ON sms_deletion_tombstones(deleted_at);
CREATE OR REPLACE FUNCTION preserve_sms_deletion_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sms_deletion_tombstones(sms_id,gateway_id,gateway_generation,deleted_at)
    VALUES(OLD.id,OLD.gateway_id,OLD.generation,now()) ON CONFLICT(sms_id) DO NOTHING;
  DELETE FROM sms_deletion_tombstones WHERE sms_id IN (
    SELECT sms_id FROM sms_deletion_tombstones
     WHERE deleted_at < now()-interval '400 days' ORDER BY deleted_at LIMIT 1000
  );
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS sms_messages_preserve_deletion_proof ON sms_messages;
CREATE TRIGGER sms_messages_preserve_deletion_proof BEFORE DELETE ON sms_messages
  FOR EACH ROW EXECUTE FUNCTION preserve_sms_deletion_proof();

-- Owner-number blocklist. Canonical key is digits-only; stored remote_number is never rewritten.
CREATE TABLE IF NOT EXISTS owner_blocked_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_key text NOT NULL,
  remote_number text NOT NULL,
  source_call_id uuid NULL REFERENCES call_records(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, canonical_key)
);
CREATE TABLE IF NOT EXISTS owner_blocklist_revisions (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- S21 §C: owner address book. Control is authoritative; clients only upload.
-- `normalized_name` is trim + whitespace collapse + casefold, computed in TS so
-- the import merge rule matches the lookup rule exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  given_name text, family_name text, organization text, notes text,
  source text NOT NULL CHECK (source IN ('ios','android','web_vcard','web_csv','web_picker','manual')),
  source_device_id text, source_contact_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS contacts_owner_name_idx ON contacts(owner_user_id, normalized_name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_source_idx ON contacts(owner_user_id, source, source_device_id, source_contact_id) WHERE source_contact_id IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS contact_phones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raw_number text NOT NULL, canonical_key text NOT NULL, e164 text, label text,
  is_primary boolean NOT NULL DEFAULT false, sort integer NOT NULL DEFAULT 0,
  UNIQUE (contact_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS contact_phones_owner_key_idx ON contact_phones(owner_user_id, canonical_key);
CREATE TABLE IF NOT EXISTS contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  address text NOT NULL, label text, sort integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contact_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  formatted text, label text, street text, city text, region text, postal_code text, country text, sort integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- S21 §B: "intercept and record". Blocked SMS never reaches sms_messages, so the
-- owner-visible evidence lives here. `message_key` is a content hash so a gateway
-- retry under a fresh eventId still deduplicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_interceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sim_id uuid NOT NULL REFERENCES sims(id),
  gateway_id uuid NOT NULL REFERENCES gateways(id),
  remote_number text NOT NULL,
  canonical_key text,
  body text NOT NULL DEFAULT '',
  message_key text NOT NULL,
  received_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('gateway','control')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway_id, message_key)
);
CREATE INDEX IF NOT EXISTS sms_interceptions_owner_idx ON sms_interceptions(owner_user_id, received_at DESC);
-- Which side decided the block, for the interception feed's `source` field.
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS blocked_source text;
ALTER TABLE call_records DROP CONSTRAINT IF EXISTS call_records_blocked_source_check;
ALTER TABLE call_records ADD CONSTRAINT call_records_blocked_source_check CHECK (blocked_source IS NULL OR blocked_source IN ('gateway','control','phone'));
CREATE INDEX IF NOT EXISTS call_records_owner_blocked_idx ON call_records(snapshot_owner_id, started_at DESC) WHERE failure_reason='number_blocked';
-- ---------------------------------------------------------------------------
-- S38: busy-conflict disposition and Pixel-originated calls. `originating_platform`
-- gains 'pixel'; its inline CHECK above is only created on a fresh database, so the
-- deployed constraint is replaced here by its auto-generated name.
-- ---------------------------------------------------------------------------
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS conflict_disposition text;
ALTER TABLE call_records DROP CONSTRAINT IF EXISTS call_records_conflict_disposition_check;
ALTER TABLE call_records ADD CONSTRAINT call_records_conflict_disposition_check CHECK (conflict_disposition IS NULL OR conflict_disposition IN ('rejected','ai_answered'));
ALTER TABLE call_records DROP CONSTRAINT IF EXISTS call_records_originating_platform_check;
ALTER TABLE call_records ADD CONSTRAINT call_records_originating_platform_check CHECK (originating_platform IS NULL OR originating_platform IN ('web','ios','android','macos','pixel'));
-- S54: native macOS client (CellDock). Sessions gain 'macos' the same way; the list above
-- was widened in place so a re-run never re-validates macos rows against the S38 list.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_platform_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_platform_check CHECK (platform IS NULL OR platform IN ('web','ios','android','macos'));


-- ---------------------------------------------------------------------------
-- S21 §D: remote power (standby beacon). `desired_power` is consume-on-delivery
-- and expires after two minutes; `standby_seen_at` never feeds online judgement.
-- ---------------------------------------------------------------------------
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS remote_power_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS standby_seen_at timestamptz;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS desired_power text;
ALTER TABLE gateways DROP CONSTRAINT IF EXISTS gateways_desired_power_check;
ALTER TABLE gateways ADD CONSTRAINT gateways_desired_power_check CHECK (desired_power IS NULL OR desired_power IN ('on','off'));
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS desired_power_requested_by uuid REFERENCES users(id);
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS desired_power_requested_at timestamptz;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS last_power_result jsonb;

-- ---------------------------------------------------------------------------
-- S21 §E: realtime AI transcript. One monotonic sequence per run across roles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_run_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES ai_call_runs(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('ai','caller')),
  sequence integer NOT NULL CHECK (sequence >= 0),
  text text NOT NULL,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS ai_run_transcripts_call_idx ON ai_run_transcripts(call_id, sequence);

-- ---------------------------------------------------------------------------
-- S22 决策 2: telephony_ready 与 media_ready 同源去抖（3 拍 / 15 s）。AI 音频权威
-- 与人工通话读同一对计数器，单拍抖动不再撤销 capability。
-- ---------------------------------------------------------------------------
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS telephony_unready_since timestamptz;
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS telephony_unready_heartbeats integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- S22 全部通话搜索: 与 contact_phones.canonical_key 同一归一化（E.164 否则纯数字），
-- 由插入路径写入，启动时有界回填历史行；NULL 只降级为号码子串搜索。
-- ---------------------------------------------------------------------------
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS remote_canonical_key text;
CREATE INDEX IF NOT EXISTS call_records_owner_canonical_idx ON call_records(snapshot_owner_id, remote_canonical_key);

-- S29 retention: ON DELETE upgrades for existing databases (CREATE TABLE IF NOT EXISTS above is a no-op there).
ALTER TABLE push_deliveries DROP CONSTRAINT IF EXISTS push_deliveries_call_id_fkey;
ALTER TABLE push_deliveries ADD CONSTRAINT push_deliveries_call_id_fkey FOREIGN KEY (call_id) REFERENCES call_records(id) ON DELETE CASCADE;
ALTER TABLE android_push_deliveries DROP CONSTRAINT IF EXISTS android_push_deliveries_call_id_fkey;
ALTER TABLE android_push_deliveries ADD CONSTRAINT android_push_deliveries_call_id_fkey FOREIGN KEY (call_id) REFERENCES call_records(id) ON DELETE CASCADE;
ALTER TABLE owner_blocked_numbers DROP CONSTRAINT IF EXISTS owner_blocked_numbers_source_call_id_fkey;
ALTER TABLE owner_blocked_numbers ADD CONSTRAINT owner_blocked_numbers_source_call_id_fkey FOREIGN KEY (source_call_id) REFERENCES call_records(id) ON DELETE SET NULL;
-- S55: entries the Pixel's own system blocklist reported ('phone') versus every client ('client').
ALTER TABLE owner_blocked_numbers ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'client';
ALTER TABLE owner_blocked_numbers DROP CONSTRAINT IF EXISTS owner_blocked_numbers_source_check;
ALTER TABLE owner_blocked_numbers ADD CONSTRAINT owner_blocked_numbers_source_check CHECK (source IN ('client','phone'));
ALTER TABLE owner_blocked_numbers ADD COLUMN IF NOT EXISTS source_gateway_id uuid NULL;
ALTER TABLE owner_blocked_numbers DROP CONSTRAINT IF EXISTS owner_blocked_numbers_source_gateway_id_fkey;
ALTER TABLE owner_blocked_numbers ADD CONSTRAINT owner_blocked_numbers_source_gateway_id_fkey FOREIGN KEY (source_gateway_id) REFERENCES gateways(id) ON DELETE SET NULL;
-- S66: separate call and SMS blocklists. Existing rows are the call list; one number may sit in both (two rows).
ALTER TABLE owner_blocked_numbers ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'call';
ALTER TABLE owner_blocked_numbers DROP CONSTRAINT IF EXISTS owner_blocked_numbers_scope_check;
ALTER TABLE owner_blocked_numbers ADD CONSTRAINT owner_blocked_numbers_scope_check CHECK (scope IN ('call','sms'));
ALTER TABLE owner_blocked_numbers DROP CONSTRAINT IF EXISTS owner_blocked_numbers_owner_user_id_canonical_key_key;
ALTER TABLE owner_blocked_numbers DROP CONSTRAINT IF EXISTS owner_blocked_numbers_owner_scope_canonical_key_key;
ALTER TABLE owner_blocked_numbers ADD CONSTRAINT owner_blocked_numbers_owner_scope_canonical_key_key UNIQUE (owner_user_id, scope, canonical_key);

-- ---------------------------------------------------------------------------
-- S36 C3: structured diagnostics from every platform plus Control itself. Deliberately
-- foreign-key free: a purged call or user must never delete or block a diagnostic, and
-- retention drops the whole table by `received_at` (S36b: 30 days).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diag_events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  device text NOT NULL,
  user_id uuid,
  call_id uuid,
  level text NOT NULL,
  event text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS diag_events_ts_idx ON diag_events(ts);
CREATE INDEX IF NOT EXISTS diag_events_call_idx ON diag_events(call_id);

-- S36b D3: `install_id` follows one client install across sessions and reinstalls of the app's
-- state; the (source,device,ts) index is what the diag summary and a per-device timeline read.
ALTER TABLE diag_events ADD COLUMN IF NOT EXISTS install_id text;
CREATE INDEX IF NOT EXISTS diag_events_source_device_ts_idx ON diag_events(source,device,ts);

-- S48: durable gateway-wide SMS pacing; command sequence and TTL are assigned at release.
ALTER TABLE commands ADD COLUMN IF NOT EXISTS sms_execution_observed_at timestamptz;
CREATE TABLE IF NOT EXISTS gateway_sms_pacing (
  gateway_id uuid PRIMARY KEY REFERENCES gateways(id) ON DELETE CASCADE,
  command_id uuid,
  next_release_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE IF NOT EXISTS sms_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sim_id uuid NOT NULL REFERENCES sims(id) ON DELETE CASCADE,
  country_iso text,
  sms_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sms_dispatch_queue (
  sms_id uuid PRIMARY KEY REFERENCES sms_messages(id) ON DELETE CASCADE,
  gateway_id uuid NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  assignment_version bigint NOT NULL,
  ordinal bigserial UNIQUE,
  batch_id uuid REFERENCES sms_batches(id) ON DELETE SET NULL,
  command_id uuid,
  released_at timestamptz,
  first_delivery_at timestamptz
);
CREATE INDEX IF NOT EXISTS sms_dispatch_pending ON sms_dispatch_queue(gateway_id,ordinal) WHERE released_at IS NULL;

-- S67 unread badges. `DEFAULT now()` backfills only the rows that exist when the column is added
-- (history counts as seen/read at rollout); dropping the default right after leaves new rows NULL.
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS seen_at timestamptz DEFAULT now();
ALTER TABLE call_records ALTER COLUMN seen_at DROP DEFAULT;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS read_at timestamptz DEFAULT now();
ALTER TABLE sms_messages ALTER COLUMN read_at DROP DEFAULT;
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS badge_calls boolean NOT NULL DEFAULT false;
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS badge_sms boolean NOT NULL DEFAULT false;
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS badge_sent integer;
ALTER TABLE push_registrations ADD COLUMN IF NOT EXISTS badge_retry_at timestamptz;
-- The AI-run half of the pending rule is a subquery, so the call index narrows to unseen incoming rows.
CREATE INDEX IF NOT EXISTS calls_owner_unseen_idx ON call_records(snapshot_owner_id) WHERE seen_at IS NULL AND direction='incoming';
CREATE INDEX IF NOT EXISTS sms_owner_unread_idx ON sms_messages(snapshot_owner_id) WHERE read_at IS NULL AND direction='incoming';

-- S69: every diag row carries the reporting app's version (Control's own rows: short app.js SHA).
ALTER TABLE diag_events ADD COLUMN IF NOT EXISTS app_version text;

-- S72 internal calls: one owner's hosted SIM dialing another. No FK on purpose: deleting (S29/S30)
-- one leg must leave the other intact; readers treat a dangling peer_call_id as "no peer".
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS internal_call boolean NOT NULL DEFAULT false;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS peer_call_id uuid;
ALTER TABLE call_records ADD COLUMN IF NOT EXISTS peer_sim_id uuid;

-- S75: device clock skew at upload (Control receive time − X-Diag-Sent-At, ms; NULL if absent or
-- beyond a day); the call-timeline tool orders by ts + clock_offset_ms. device_events by resource.
ALTER TABLE diag_events ADD COLUMN IF NOT EXISTS clock_offset_ms integer;
CREATE INDEX IF NOT EXISTS device_events_resource_idx ON device_events(resource_id);

-- Hangup before dial delivery: `delivered_at` is stamped when a heartbeat hands a dial to the gateway
-- for execution. The ADD stamps every pre-existing row once (unknown = delivered, today's hangup path);
-- rows created afterwards start NULL. DROP DEFAULT is idempotent on every boot.
ALTER TABLE commands ADD COLUMN IF NOT EXISTS delivered_at timestamptz DEFAULT now();
ALTER TABLE commands ALTER COLUMN delivered_at DROP DEFAULT;
-- S93 refresh grace: the refresh token a rotation replaced stays redeemable until the new access
-- token is first used, so a native app killed before saving the new pair is not logged out.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_refresh_hash text;
CREATE INDEX IF NOT EXISTS sessions_previous_refresh_hash ON sessions(previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
