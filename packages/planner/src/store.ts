// Datenbankzugriff des Planers. Jede Funktion ist auf einen Kunden beschränkt (customer_id),
// auch wenn die ID aus einem Button kommt: niemand kann fremde Aufgaben oder Termine ändern.
import type { Queryable } from '@echte-balance/db';
import { ALL_DAYS, addDays, norm, weekStart, dowOf } from './time.ts';

export type Category = 'work' | 'hustle' | 'habit';

export interface Habit {
  id: number;
  key: string;
  label: string;
  category: Category;
  min_min: number;
  max_min: number;
  start_time: string | null; // HH:MM
  days: number[];
  remind: boolean;
  active: boolean;
  counts: boolean;
  pos: number;
  weekly_goal_min: number | null; // Wochensoll, verteilt auf die Tage, an denen die Aufgabe dran ist
  buttons: number[] | null; // eigene Zeit-Buttons in Minuten
}

export interface PlannerSettings {
  free_days: number[];
  ask_weekly: boolean;
  vacation_until: string | null;
}

export const VACATION_OPEN = '9999-12-31';

const HABIT_COLS = `id, key, label, category, min_min, max_min, to_char(start_time, 'HH24:MI') AS start_time,
  days, remind, active, counts, pos, weekly_goal_min, buttons`;
const toHabit = (r: any): Habit => ({ ...r, id: Number(r.id) });

// Vorlage für neue Nutzer - alles änder- und löschbar.
// Arbeit standardmäßig Mo-Fr, damit ein Wochensoll (/habit woche arbeit 38,5) auf 5 Tage verteilt wird.
const DEFAULT_HABITS: Omit<Habit, 'id' | 'start_time' | 'remind' | 'active' | 'pos' | 'weekly_goal_min' | 'buttons'>[] = [
  { key: 'arbeit', label: 'Arbeit (Beruf)', category: 'work', min_min: 360, max_min: 540, counts: false, days: [1, 2, 3, 4, 5] },
  { key: 'sidehustle', label: 'Side-Hustle', category: 'hustle', min_min: 60, max_min: 180, counts: true, days: ALL_DAYS },
  { key: 'training', label: 'Training', category: 'habit', min_min: 60, max_min: 120, counts: true, days: ALL_DAYS },
  { key: 'lesen', label: 'Lesen', category: 'habit', min_min: 15, max_min: 60, counts: true, days: ALL_DAYS },
];

// ---------- Einstellungen ----------

/** Legt beim ersten Aufruf die Einstellungen und die Aufgaben-Vorlage an. */
export async function ensurePlanner(db: Queryable, customerId: number): Promise<PlannerSettings> {
  const created = await db.query(
    'INSERT INTO planner.settings (customer_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING customer_id',
    [customerId],
  );
  if (created.rowCount) {
    for (const [i, h] of DEFAULT_HABITS.entries()) {
      await db.query(
        `INSERT INTO planner.habits (customer_id, key, label, category, min_min, max_min, counts, pos, days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [customerId, h.key, h.label, h.category, h.min_min, h.max_min, h.counts, i, h.days],
      );
    }
  }
  return getSettings(db, customerId);
}

export async function getSettings(db: Queryable, customerId: number): Promise<PlannerSettings> {
  const { rows } = await db.query(
    'SELECT free_days, ask_weekly, vacation_until FROM planner.settings WHERE customer_id = $1',
    [customerId],
  );
  return rows[0] ?? { free_days: [], ask_weekly: false, vacation_until: null };
}

export async function updateSettings(db: Queryable, customerId: number, patch: Partial<PlannerSettings>) {
  const cols = Object.keys(patch) as (keyof PlannerSettings)[];
  if (!cols.length) return;
  await db.query(
    `UPDATE planner.settings SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE customer_id = $1`,
    [customerId, ...cols.map((c) => patch[c])],
  );
}

// ---------- Freie Tage & Urlaub ----------

export async function getWeekFree(db: Queryable, customerId: number, ws: string): Promise<number[] | null> {
  const { rows } = await db.query('SELECT days FROM planner.week_free WHERE customer_id = $1 AND week_start = $2', [
    customerId,
    ws,
  ]);
  return rows[0]?.days ?? null;
}

export async function saveWeekFree(db: Queryable, customerId: number, ws: string, days: number[]) {
  await db.query(
    `INSERT INTO planner.week_free (customer_id, week_start, days) VALUES ($1, $2, $3)
     ON CONFLICT (customer_id, week_start) DO UPDATE SET days = EXCLUDED.days`,
    [customerId, ws, [...new Set(days)]],
  );
}

export async function deleteWeekFree(db: Queryable, customerId: number, ws: string) {
  await db.query('DELETE FROM planner.week_free WHERE customer_id = $1 AND week_start = $2', [customerId, ws]);
}

/** Freie Tage der Woche, in der `day` liegt (Sonderregel der Woche oder feste freie Tage). */
export async function freeDaysFor(db: Queryable, customerId: number, s: PlannerSettings, day: string) {
  return (await getWeekFree(db, customerId, weekStart(day))) ?? s.free_days;
}

export const onVacation = (s: PlannerSettings, day: string) => s.vacation_until !== null && day <= s.vacation_until;

/** Arbeit pausiert an freien Tagen und im Urlaub. */
export async function workPaused(db: Queryable, customerId: number, s: PlannerSettings, day: string) {
  return onVacation(s, day) || (await freeDaysFor(db, customerId, s, day)).includes(dowOf(day));
}

/** Tage im Zeitraum, an denen die Arbeit pausiert (frei oder Urlaub), für die Statistik */
export async function pausedDays(db: Queryable, customerId: number, s: PlannerSettings, from: string, to: string) {
  const weeks = await db.query(
    'SELECT week_start, days FROM planner.week_free WHERE customer_id = $1 AND week_start BETWEEN $2 AND $3',
    [customerId, weekStart(from), to],
  );
  const weekFree = new Map<string, number[]>(weeks.rows.map((r) => [r.week_start, r.days]));
  const vac = await db.query('SELECT day FROM planner.vacation_days WHERE customer_id = $1 AND day BETWEEN $2 AND $3', [
    customerId, from, to,
  ]);
  const out = new Set<string>(vac.rows.map((r) => r.day as string));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (onVacation(s, d) || (weekFree.get(weekStart(d)) ?? s.free_days).includes(dowOf(d))) out.add(d);
  }
  return out;
}

export async function addVacationDay(db: Queryable, customerId: number, day: string) {
  await db.query('INSERT INTO planner.vacation_days (customer_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    customerId,
    day,
  ]);
}

// ---------- Aufgaben ----------

export async function listHabits(db: Queryable, customerId: number, activeOnly = false): Promise<Habit[]> {
  const { rows } = await db.query(
    `SELECT ${HABIT_COLS} FROM planner.habits WHERE customer_id = $1 ${activeOnly ? 'AND active' : ''} ORDER BY pos, id`,
    [customerId],
  );
  return rows.map(toHabit);
}

export async function getHabit(db: Queryable, customerId: number, id: number): Promise<Habit | null> {
  const { rows } = await db.query(`SELECT ${HABIT_COLS} FROM planner.habits WHERE customer_id = $1 AND id = $2`, [
    customerId,
    id,
  ]);
  return rows[0] ? toHabit(rows[0]) : null;
}

/** Findet per Schlüssel oder Name, auch angefangen ("hus" → Side-Hustle). */
export async function findHabit(db: Queryable, customerId: number, input: unknown): Promise<Habit | null> {
  const q = norm(input);
  if (!q) return null;
  const all = await listHabits(db, customerId);
  return (
    all.find((h) => norm(h.key) === q) ??
    all.find((h) => norm(h.label) === q) ??
    all.find((h) => norm(h.key).startsWith(q) || norm(h.label).startsWith(q)) ??
    null
  );
}

export async function createHabit(
  db: Queryable,
  customerId: number,
  h: { key: string; label: string; min: number; max: number; category?: Category },
): Promise<Habit> {
  const { rows } = await db.query(
    `INSERT INTO planner.habits (customer_id, key, label, min_min, max_min, category, counts, pos, days)
     VALUES ($1, $2, $3, $4, $5, $6, $6 <> 'work',
       (SELECT COALESCE(MAX(pos), 0) + 1 FROM planner.habits WHERE customer_id = $1), $7)
     RETURNING ${HABIT_COLS}`,
    [customerId, h.key, h.label, h.min, h.max, h.category ?? 'habit', ALL_DAYS],
  );
  return toHabit(rows[0]);
}

type HabitPatch = Partial<
  Pick<Habit, 'label' | 'category' | 'min_min' | 'max_min' | 'start_time' | 'days' | 'remind' | 'active' | 'counts' | 'weekly_goal_min' | 'buttons'>
>;

export async function updateHabit(db: Queryable, customerId: number, id: number, patch: HabitPatch) {
  const cols = Object.keys(patch) as (keyof HabitPatch)[];
  if (!cols.length) return;
  await db.query(
    `UPDATE planner.habits SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE customer_id = $1 AND id = $2`,
    [customerId, id, ...cols.map((c) => patch[c])],
  );
}

export async function deleteHabit(db: Queryable, customerId: number, id: number): Promise<boolean> {
  const r = await db.query('DELETE FROM planner.habits WHERE customer_id = $1 AND id = $2', [customerId, id]);
  return (r.rowCount ?? 0) > 0;
}

// ---------- Einträge ----------

export interface LogEntry {
  habit_id: number;
  day: string;
  status: 'done' | 'skipped';
  minutes: number;
}

export async function record(db: Queryable, habitId: number, day: string, status: 'done' | 'skipped', minutes: number) {
  await db.query(
    `INSERT INTO planner.habit_log (habit_id, day, status, minutes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (habit_id, day) DO UPDATE SET status = EXCLUDED.status, minutes = EXCLUDED.minutes, logged_at = now()`,
    [habitId, day, status, minutes],
  );
}

export async function logsBetween(db: Queryable, customerId: number, from: string, to: string): Promise<LogEntry[]> {
  const { rows } = await db.query(
    `SELECT l.habit_id, l.day, l.status, l.minutes FROM planner.habit_log l
     JOIN planner.habits h ON h.id = l.habit_id
     WHERE h.customer_id = $1 AND l.day BETWEEN $2 AND $3`,
    [customerId, from, to],
  );
  return rows.map((r) => ({ ...r, habit_id: Number(r.habit_id) }));
}

/** Erster Eintrag je Aufgabe: Tage davor zählen nicht in die Statistik. */
export async function firstLogDays(db: Queryable, customerId: number): Promise<Map<number, string>> {
  const { rows } = await db.query(
    `SELECT l.habit_id, MIN(l.day) AS d FROM planner.habit_log l
     JOIN planner.habits h ON h.id = l.habit_id WHERE h.customer_id = $1 GROUP BY l.habit_id`,
    [customerId],
  );
  return new Map(rows.map((r) => [Number(r.habit_id), r.d as string]));
}

/** Löscht Einträge eines Tages (einer Aufgabe oder alle). Liefert die Anzahl. */
export async function deleteLogs(db: Queryable, customerId: number, day: string, habitId?: number): Promise<number> {
  const r = await db.query(
    `DELETE FROM planner.habit_log l USING planner.habits h
     WHERE h.id = l.habit_id AND h.customer_id = $1 AND l.day = $2 ${habitId ? 'AND l.habit_id = $3' : ''}`,
    habitId ? [customerId, day, habitId] : [customerId, day],
  );
  return r.rowCount ?? 0;
}

export async function countVacationDays(db: Queryable, customerId: number, from: string, to: string) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM planner.vacation_days WHERE customer_id = $1 AND day BETWEEN $2 AND $3',
    [customerId, from, to],
  );
  return rows[0].n as number;
}

// ---------- Termine ----------

export interface PlannerEvent {
  id: number;
  title: string;
  day: string;
  time: string;
  sent_day: boolean;
  sent_pre: boolean;
}

const EVENT_COLS = `id, title, day, to_char(time, 'HH24:MI') AS time, sent_day, sent_pre`;

export async function addEvent(db: Queryable, customerId: number, e: { title: string; day: string; time: string }) {
  await db.query('INSERT INTO planner.events (customer_id, title, day, time) VALUES ($1, $2, $3, $4)', [
    customerId,
    e.title,
    e.day,
    e.time,
  ]);
}

/** Termine ab heute (vergangene von heute filtert der Aufrufer nach Uhrzeit). */
export async function eventsFrom(db: Queryable, customerId: number, day: string): Promise<PlannerEvent[]> {
  const { rows } = await db.query(
    `SELECT ${EVENT_COLS} FROM planner.events WHERE customer_id = $1 AND day >= $2 ORDER BY day, time`,
    [customerId, day],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function deleteEvent(db: Queryable, customerId: number, id: number) {
  await db.query('DELETE FROM planner.events WHERE customer_id = $1 AND id = $2', [customerId, id]);
}

export async function markEventSent(db: Queryable, id: number, which: 'day' | 'pre') {
  await db.query(
    which === 'pre'
      ? 'UPDATE planner.events SET sent_pre = true, sent_day = true WHERE id = $1'
      : 'UPDATE planner.events SET sent_day = true WHERE id = $1',
    [id],
  );
}

/** Nutzer, die den Planer verwenden - für die minütliche Prüfung der Erinnerungen. */
export async function plannerCustomers(db: Queryable) {
  const { rows } = await db.query(
    `SELECT c.id, c.telegram_user_id, c.timezone FROM core.customers c
     JOIN planner.settings s ON s.customer_id = c.id WHERE c.deleted_at IS NULL`,
  );
  return rows.map((r) => ({ id: Number(r.id), telegramUserId: Number(r.telegram_user_id), timezone: r.timezone as string }));
}
