-- Meta-API: Token-Erneuerung und "neu seit der letzten Benachrichtigung".
ALTER TABLE instagram.accounts ADD COLUMN token_updated_at timestamptz;
ALTER TABLE instagram.comments ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX posts_account_posted ON instagram.posts (account_id, posted_at DESC);
