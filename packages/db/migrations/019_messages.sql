-- Nachrichten über /anfrage (z. B. Plan anfragen, Fragen, Feedback), damit /anfragen alle offenen zeigt.
CREATE TABLE core.messages (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  text        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz
);

CREATE INDEX messages_open_idx ON core.messages (created_at) WHERE status = 'open';
