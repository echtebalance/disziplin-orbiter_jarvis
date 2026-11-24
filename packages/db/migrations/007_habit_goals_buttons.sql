-- Wochensoll statt Tagesmindestzeit (z. B. Arbeit 38,5 h/Woche) und eigene Zeit-Buttons.
ALTER TABLE planner.habits
  ADD COLUMN weekly_goal_min integer CHECK (weekly_goal_min BETWEEN 1 AND 10080),
  ADD COLUMN buttons integer[];   -- NULL = Mindest-, Mittel-, Maximalzeit
