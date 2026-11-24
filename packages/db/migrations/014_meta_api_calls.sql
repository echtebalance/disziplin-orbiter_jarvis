-- Protokoll jeder Anfrage an die Meta-API (ohne Token, ohne Inhalte) für /apicalls.
CREATE TABLE instagram.api_calls (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  called_at  timestamptz NOT NULL DEFAULT now(),
  endpoint   text NOT NULL,          -- z. B. "media", "comments", "me/accounts" (IDs entfernt)
  ok         boolean NOT NULL,
  error      text
);
CREATE INDEX api_calls_account_time ON instagram.api_calls (account_id, called_at DESC);

-- Metas eigene Auslastungsanzeige (Header X-Business-Use-Case-Usage bzw. X-App-Usage), in Prozent
ALTER TABLE instagram.accounts ADD COLUMN api_usage_pct integer, ADD COLUMN api_usage_at timestamptz;
