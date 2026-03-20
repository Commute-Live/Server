CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "requested_by_ip" text,
  "used_by_ip" text,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "invalidated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_password_reset_tokens_token_hash"
  ON "password_reset_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_user_expiry"
  ON "password_reset_tokens" ("user_id", "expires_at");
