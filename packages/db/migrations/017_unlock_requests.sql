-- Freischaltungs-Anfragen registrierter Nutzer für einzelne Module (z. B. Instagram-Tracker, KI).
CREATE TABLE core.unlock_requests (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  module      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  PRIMARY KEY (customer_id, module)
);
