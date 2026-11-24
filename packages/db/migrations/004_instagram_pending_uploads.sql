-- Einzeln geschickte Export-Dateien (following.json, followers_1.json, ...) warten hier,
-- bis der Nutzer /import aufruft. Gespeichert werden nur die bereits geprüften Einträge.
CREATE TABLE instagram.pending_uploads (
  account_id  bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('follower', 'following')),
  entries     jsonb NOT NULL,                       -- [{"username": "...", "followedAt": "..."}]
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, filename)
);

-- Die Spalte status unterscheidet jetzt auch Konten ohne Meta-Verbindung (nur Export).
ALTER TABLE instagram.accounts DROP CONSTRAINT accounts_status_check;
ALTER TABLE instagram.accounts ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('export_only', 'pending', 'active', 'token_invalid'));
ALTER TABLE instagram.accounts ALTER COLUMN status SET DEFAULT 'export_only';
