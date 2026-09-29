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
-- S24 决策 3, mirrored from src/schema.sql (the file the compatible deploy actually applies).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_voice_provider text NOT NULL DEFAULT 'xai';
DO $$ BEGIN ALTER TABLE users ADD CONSTRAINT users_ai_voice_provider_check CHECK(ai_voice_provider ~ '^[a-z][a-z0-9_-]{0,31}$'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
ALTER TABLE ai_call_runs ADD COLUMN IF NOT EXISTS voice_provider text NOT NULL DEFAULT 'xai';
DO $$ BEGIN ALTER TABLE ai_call_runs ADD CONSTRAINT ai_call_runs_voice_provider_check CHECK(voice_provider ~ '^[a-z][a-z0-9_-]{0,31}$'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE call_records ADD COLUMN IF NOT EXISTS ai_run_id uuid;
DO $ai_run_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='call_records_ai_run_id_fkey') THEN
    ALTER TABLE call_records ADD CONSTRAINT call_records_ai_run_id_fkey FOREIGN KEY(ai_run_id) REFERENCES ai_call_runs(id);
  END IF;
END $ai_run_fk$;
CREATE UNIQUE INDEX IF NOT EXISTS call_records_ai_run_unique_idx ON call_records(ai_run_id) WHERE ai_run_id IS NOT NULL;
