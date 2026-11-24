-- Antworten unter Kommentaren (Diskussionen) und Text auf dem Bild (Spruchbild) pro Beitrag.

-- parent_id: NULL = Kommentar, sonst Antwort unter diesem Kommentar
ALTER TABLE instagram.comments ADD COLUMN parent_id text;
CREATE INDEX comments_thread ON instagram.comments (account_id, parent_id);

-- Vom Nutzer eingegebener Text auf dem Bild (für bessere KI-Antwortvorschläge)
ALTER TABLE instagram.posts ADD COLUMN image_text text;
