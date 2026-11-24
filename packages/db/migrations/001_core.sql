-- Gemeinsame Basis für alle Produkte: Kunden, Einladungen, Freischaltungen, Benachrichtigungen.
-- Produktmodule (instagram, planner, training) haben jeweils ein eigenes Schema
-- und greifen nur über customer_id auf core zu.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.customers (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_user_id  bigint NOT NULL UNIQUE,
  telegram_username text,
  display_name      text,
  timezone          text NOT NULL DEFAULT 'Europe/Vienna',
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz          -- DSGVO: Konto gelöscht, Daten werden per Job entfernt
);

-- Pilotphase: Zugang nur über Einladungscode, den der Admin erzeugt.
CREATE TABLE core.invites (
  code        text PRIMARY KEY,
  note        text,                                  -- z. B. Name des Interessenten
  modules     text[] NOT NULL,                       -- was der Code freischaltet
  valid_days  integer,                               -- NULL = unbefristet
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                  -- bis wann der Code eingelöst werden kann
  redeemed_by bigint REFERENCES core.customers(id),
  redeemed_at timestamptz
);

-- Freigeschaltete Zusatzfunktionen. Kostenlos für alle (ohne Eintrag hier):
-- Planer/Habits/Termine, Instagram-Export-Import mit Entfolgen-Liste und Training
-- mit selbst eingetragenen Plänen und Übungen.
-- Nur per Freischaltung:
--   instagram_api   Funktionen über die Meta-API (/status, unbeantwortete Kommentare, Benachrichtigung)
--   training_plans  die Trainingspläne von echte_balance (werden als eigene Kopie übernommen)
-- valid_until NULL = unbefristet. source sagt, woher die Freischaltung kommt.
CREATE TABLE core.entitlements (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  module       text NOT NULL CHECK (module IN ('instagram_api', 'training_plans')),
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_until  timestamptz,
  source       text NOT NULL CHECK (source IN ('pilot', 'manual', 'stripe')),
  external_ref text,                                 -- z. B. Stripe-Subscription- oder Payment-ID
  revoked_at   timestamptz,                          -- Rückerstattung, Sperre
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entitlements_customer_module ON core.entitlements (customer_id, module);

-- Eingehende Zahlungs-Webhooks. UNIQUE verhindert doppelte Verarbeitung.
CREATE TABLE core.payment_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

-- Eine Zeile pro Kunde und Benachrichtigungsart, z. B.
--   kind = 'ig_unanswered'   local_time = 19:00
--   kind = 'event_reminder'  local_time = 21:00, options = {"minutes_before": 15}
CREATE TABLE core.notification_settings (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  local_time  time,                                  -- in der Zeitzone des Kunden
  options     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (customer_id, kind)
);

-- Merkt sich, was schon verschickt wurde, damit nichts doppelt kommt.
CREATE TABLE core.notification_log (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  ref         text NOT NULL,                         -- z. B. Datum des Tagesberichts oder Termin-ID
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, kind, ref)
);

CREATE TABLE core.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint REFERENCES core.customers(id) ON DELETE SET NULL,
  actor       text NOT NULL,                         -- 'customer', 'admin', 'system', 'stripe'
  action      text NOT NULL,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
