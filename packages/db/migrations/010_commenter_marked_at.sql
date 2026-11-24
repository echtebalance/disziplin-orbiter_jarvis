-- Wann hast du zuletzt bei diesem Kommentierer zurückkommentiert (✅ in /status)?
-- Grundlage für die Erinnerung an aktive Kommentierer, bei denen du dich lange nicht gemeldet hast.
ALTER TABLE instagram.commenter_snooze ADD COLUMN marked_at timestamptz NOT NULL DEFAULT now();
