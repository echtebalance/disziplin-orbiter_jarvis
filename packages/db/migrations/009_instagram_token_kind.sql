-- Token-Art: Instagram-Login (graph.instagram.com) oder Facebook-Login (graph.facebook.com).
ALTER TABLE instagram.accounts
  ADD COLUMN token_kind text NOT NULL DEFAULT 'instagram' CHECK (token_kind IN ('instagram', 'facebook'));
