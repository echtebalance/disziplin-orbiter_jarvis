-- Planer: Aufgaben (Habits) mit Zeiten, Tageseinträge, Termine, freie Tage, Urlaub.
-- Mandantenfähige Fassung von jarvis-satellite/planner.js.

CREATE SCHEMA IF NOT EXISTS planner;

-- Eine Zeile pro Nutzer, sobald er den Planer zum ersten Mal verwendet.
CREATE TABLE planner.settings (
  customer_id    bigint PRIMARY KEY REFERENCES core.customers(id) ON DELETE CASCADE,
  free_days      smallint[] NOT NULL DEFAULT '{}',  -- feste freie Tage, 0 = Sonntag
  ask_weekly     boolean NOT NULL DEFAULT false,    -- sonntags nach den freien Tagen fragen
  vacation_until date,                              -- NULL = kein Urlaub, 9999-12-31 = unbefristet
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- category: work   = Beruf, pausiert an freien Tagen und im Urlaub
--           hustle = Side-Hustle (zählt in der Statistik zusammen)
--           habit  = alles andere
-- counts:   false = nur Zeiterfassung, zählt nicht in die Quote (z. B. Arbeit)
CREATE TABLE planner.habits (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  category    text NOT NULL DEFAULT 'habit' CHECK (category IN ('work', 'hustle', 'habit')),
  min_min     integer NOT NULL CHECK (min_min >= 0),
  max_min     integer NOT NULL CHECK (max_min >= min_min),
  start_time  time,
  days        smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  remind      boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  counts      boolean NOT NULL DEFAULT true,
  pos         integer NOT NULL DEFAULT 0,
  UNIQUE (customer_id, key)
);

CREATE TABLE planner.habit_log (
  habit_id  bigint NOT NULL REFERENCES planner.habits(id) ON DELETE CASCADE,
  day       date NOT NULL,
  status    text NOT NULL CHECK (status IN ('done', 'skipped')),
  minutes   integer NOT NULL DEFAULT 0,
  logged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (habit_id, day)
);

CREATE TABLE planner.events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  title       text NOT NULL,
  day         date NOT NULL,                        -- Ortszeit des Nutzers
  time        time NOT NULL,
  sent_day    boolean NOT NULL DEFAULT false,       -- Erinnerung am Vortag verschickt
  sent_pre    boolean NOT NULL DEFAULT false        -- Erinnerung kurz vorher verschickt
);
CREATE INDEX events_customer_day ON planner.events (customer_id, day);

-- Freie Tage nur für eine bestimmte Woche (ersetzt die festen freien Tage)
CREATE TABLE planner.week_free (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  week_start  date NOT NULL,                        -- Montag
  days        smallint[] NOT NULL,
  PRIMARY KEY (customer_id, week_start)
);

CREATE TABLE planner.vacation_days (
  customer_id bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  day         date NOT NULL,
  PRIMARY KEY (customer_id, day)
);
