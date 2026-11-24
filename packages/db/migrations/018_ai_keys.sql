-- Mehrere KI-Schlüssel pro Nutzer: einer je Anbieter (z. B. GroqCloud und Google Gemini).
-- ai_config.provider ist ab jetzt der aktive Anbieter; Schlüssel und Modell liegen in ai_keys.
-- Ist der aktive Anbieter überlastet, weicht der Bot auf einen anderen gespeicherten aus.

CREATE TABLE instagram.ai_keys (
  customer_id    bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  provider       text NOT NULL,                    -- gemini | groq | openrouter | openai
  model          text NOT NULL,
  key_ciphertext text NOT NULL,                    -- AES-256-GCM
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, provider)
);

INSERT INTO instagram.ai_keys (customer_id, provider, model, key_ciphertext, created_at)
SELECT customer_id, provider, model, key_ciphertext, created_at FROM instagram.ai_config;

-- Schlüssel nicht doppelt aufbewahren
ALTER TABLE instagram.ai_config ALTER COLUMN model DROP NOT NULL;
ALTER TABLE instagram.ai_config ALTER COLUMN key_ciphertext DROP NOT NULL;
UPDATE instagram.ai_config SET model = NULL, key_ciphertext = NULL;
