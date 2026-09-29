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
 call_id uuid NOT NULL REFERENCES call_records(id),
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
