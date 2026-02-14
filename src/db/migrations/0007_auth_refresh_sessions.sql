CREATE TABLE IF NOT EXISTS "auth_refresh_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "family_id" uuid NOT NULL,
  "token_jti" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "rotated_at" timestamptz,
  "revoked_at" timestamptz,
  "replaced_by_jti" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_refresh_sessions_token_jti"
  ON "auth_refresh_sessions" ("token_jti");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_refresh_sessions_user_session_jti"
  ON "auth_refresh_sessions" ("user_id", "session_id", "token_jti");
