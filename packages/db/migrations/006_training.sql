-- Training: eigene Pläne mit Zyklus, Übungen, Sätze, Körpergewicht, Ausdauer.
-- Mandantenfähige Fassung von jarvis-satellite/training.js und cardio.js.

CREATE SCHEMA IF NOT EXISTS training;

-- Ein Plan läuft im Zyklus: train_days Trainingstage, danach rest_days Pause.
-- 3er Split = 3 + 1, Recovery = 1 + 1. origin_plan_id: Kopie eines anderen Plans
-- (z. B. deine Pläne, die du für Freunde freischaltest). Das Original bleibt unverändert.
CREATE TABLE training.plans (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id    bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  name           text NOT NULL,
  train_days     smallint NOT NULL CHECK (train_days BETWEEN 1 AND 7),
  rest_days      smallint NOT NULL CHECK (rest_days BETWEEN 0 AND 7),
  origin_plan_id bigint REFERENCES training.plans(id) ON DELETE SET NULL,
  pos            integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_customer ON training.plans (customer_id);

CREATE TABLE training.plan_days (
  plan_id bigint NOT NULL REFERENCES training.plans(id) ON DELETE CASCADE,
  day_idx smallint NOT NULL,
  name    text NOT NULL,
  PRIMARY KEY (plan_id, day_idx)
);

CREATE TABLE training.plan_exercises (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id    bigint NOT NULL REFERENCES training.plans(id) ON DELETE CASCADE,
  day_idx    smallint NOT NULL,
  pos        integer NOT NULL,
  name       text NOT NULL,
  bodyweight boolean NOT NULL DEFAULT false        -- Körpergewicht zählt ins Volumen
);
CREATE INDEX plan_exercises_plan_day ON training.plan_exercises (plan_id, day_idx, pos);

-- Zustand pro Nutzer: aktiver Plan, Zyklusbeginn, laufende Einheit, Gewichtsabfrage
CREATE TABLE training.state (
  customer_id    bigint PRIMARY KEY REFERENCES core.customers(id) ON DELETE CASCADE,
  active_plan_id bigint REFERENCES training.plans(id) ON DELETE SET NULL,
  cycle_start    date,
  session        jsonb,                             -- laufende Trainingseinheit
  bw_ask         boolean NOT NULL DEFAULT false,    -- tägliche Gewichtsabfrage
  bw_time        time NOT NULL DEFAULT '07:00',
  bw_pending     date                               -- heute gefragt, Antwort offen
);

CREATE TABLE training.sets (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  day         date NOT NULL,
  plan_id     bigint REFERENCES training.plans(id) ON DELETE SET NULL,
  day_idx     smallint,
  exercise    text NOT NULL,
  weight      double precision NOT NULL,            -- Zusatzgewicht; 0 = nur Körpergewicht
  reps        integer NOT NULL,
  sets        integer NOT NULL,
  logged_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sets_customer_exercise ON training.sets (customer_id, lower(exercise), day);

CREATE TABLE training.body_weight (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  day         date NOT NULL,
  kg          double precision NOT NULL CHECK (kg BETWEEN 30 AND 300),
  PRIMARY KEY (customer_id, day)
);

CREATE TABLE training.cardio (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  day         date NOT NULL,
  name        text NOT NULL,
  minutes     integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  logged_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cardio_customer_day ON training.cardio (customer_id, day);
