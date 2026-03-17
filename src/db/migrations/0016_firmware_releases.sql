CREATE TABLE IF NOT EXISTS "firmware_releases" (
    "id" serial PRIMARY KEY NOT NULL,
    "version" text NOT NULL,
    "description" text NOT NULL DEFAULT '',
    "url" text NOT NULL,
    "size_bytes" integer NOT NULL,
    "released_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_firmware_releases_version" ON "firmware_releases" ("version");
