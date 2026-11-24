-- Zugangsanfragen von Leuten ohne Einladung. Der Admin entscheidet per Button.
CREATE TABLE core.access_requests (
  telegram_user_id bigint PRIMARY KEY,
  username         text,
  name             text,
  message          text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);
