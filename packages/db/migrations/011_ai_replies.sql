-- KI-Antwortvorschläge: eigenes Freischalt-Modul, eigener KI-Schlüssel pro Nutzer, Cache, Tageszähler.

ALTER TABLE core.entitlements DROP CONSTRAINT entitlements_module_check;
ALTER TABLE core.entitlements ADD CONSTRAINT entitlements_module_check
  CHECK (module IN ('instagram_api', 'training_plans', 'ai_replies'));

-- Der Nutzer hinterlegt seinen eigenen (kostenlosen) Schlüssel, z. B. Google Gemini oder Groq.
CREATE TABLE instagram.ai_config (
  customer_id    bigint PRIMARY KEY REFERENCES core.customers(id) ON DELETE CASCADE,
  provider       text NOT NULL,                    -- gemini | groq | openrouter | openai
  model          text NOT NULL,
  key_ciphertext text NOT NULL,                    -- AES-256-GCM
  style          text,                             -- eigener Schreibstil für die Vorschläge
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Vorschläge werden pro Kommentar gemerkt (spart Anfragen); bei geändertem Text neu erzeugt.
CREATE TABLE instagram.reply_suggestions (
  account_id   bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  comment_id   text NOT NULL,
  comment_text text NOT NULL,
  suggestions  jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, comment_id)
);

CREATE TABLE instagram.ai_usage (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  day         date NOT NULL,
  requests    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, day)
);
