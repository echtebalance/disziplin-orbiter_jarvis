-- Vorgaben pro Übung (aus Trainingsplan.txt): [{"weight": 60, "reps": "10"}, …]; NULL = keine Vorgabe
ALTER TABLE training.plan_exercises ADD COLUMN target jsonb;
