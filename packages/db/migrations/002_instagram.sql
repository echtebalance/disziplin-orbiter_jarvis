-- Instagram-Modul, mandantenfähige Fassung der Tabellen aus jarvis-satellite.
-- Alles hängt an einem Instagram-Konto, das einem Kunden gehört.

CREATE SCHEMA IF NOT EXISTS instagram;

CREATE TABLE instagram.accounts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id      bigint NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  ig_user_id       text,
  username         text,
  token_ciphertext text,                             -- AES-256-GCM, nie im Klartext speichern
  token_expires_at timestamptz,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'token_invalid')),
  last_sync_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, ig_user_id)
);

CREATE TABLE instagram.posts (
  account_id     bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  media_id       text NOT NULL,
  posted_at      timestamptz,
  caption        text,
  permalink      text,
  comments_count integer,                           -- Änderung erkannt => Kommentare neu laden
  synced_at      timestamptz,
  PRIMARY KEY (account_id, media_id)
);

CREATE TABLE instagram.comments (
  account_id   bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  comment_id   text NOT NULL,
  media_id     text NOT NULL,
  username     text NOT NULL,
  text         text,
  commented_at timestamptz,
  emoji_only   boolean NOT NULL DEFAULT false,      -- reine Emoji-Kommentare nicht melden
  answered_at  timestamptz,                         -- Kontoinhaber hat geantwortet
  PRIMARY KEY (account_id, comment_id),
  FOREIGN KEY (account_id, media_id) REFERENCES instagram.posts(account_id, media_id) ON DELETE CASCADE
);
CREATE INDEX comments_username ON instagram.comments (account_id, lower(username));
CREATE INDEX comments_unanswered ON instagram.comments (account_id, commented_at)
  WHERE answered_at IS NULL AND emoji_only = false;

-- /status: abgehakte Kommentierer werden für einige Tage ausgeblendet.
CREATE TABLE instagram.commenter_snooze (
  account_id    bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  username      text NOT NULL,
  snoozed_until timestamptz NOT NULL,
  PRIMARY KEY (account_id, username)
);

-- Jeder Import des Instagram-Datenexports wird als Snapshot behalten (statt überschrieben),
-- damit Unfollower zwischen zwei Exporten erkennbar sind.
CREATE TABLE instagram.snapshots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  follower_count  integer NOT NULL,
  following_count integer NOT NULL
);

CREATE TABLE instagram.snapshot_entries (
  snapshot_id bigint NOT NULL REFERENCES instagram.snapshots(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('follower', 'following')),
  username    text NOT NULL,
  followed_at timestamptz,
  PRIMARY KEY (snapshot_id, kind, username)
);

-- /entfolgen: Entscheidungen bleiben über Importe hinweg erhalten.
CREATE TABLE instagram.cleanup (
  account_id bigint NOT NULL REFERENCES instagram.accounts(id) ON DELETE CASCADE,
  username   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('unfollowed', 'keep')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, username)
);
