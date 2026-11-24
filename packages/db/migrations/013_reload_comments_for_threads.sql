-- Einmalig: Beiträge beim nächsten Abgleich vollständig neu laden, damit die Antworten unter
-- Kommentaren (Diskussionen, Migration 012) auch für bereits geladene Beiträge vorliegen.
UPDATE instagram.posts SET comments_count = NULL;
