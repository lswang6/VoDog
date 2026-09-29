CREATE TABLE IF NOT EXISTS transcript_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  snapshot_owner_id uuid NOT NULL REFERENCES users(id),
  manifest jsonb NOT NULL,
  manifest_fingerprint text NOT NULL CHECK (manifest_fingerprint ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (call_id, snapshot_owner_id, manifest_fingerprint),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'succeeded') = (result IS NOT NULL)),
  CHECK (state <> 'succeeded' OR completed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS transcript_jobs_due_idx
  ON transcript_jobs(next_attempt_at, created_at)
  WHERE state IN ('queued','retry','running');
CREATE INDEX IF NOT EXISTS transcript_jobs_owner_call_idx
  ON transcript_jobs(snapshot_owner_id, call_id, created_at DESC);
