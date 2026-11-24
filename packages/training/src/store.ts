// Datenbankzugriff fürs Training. Alles ist auf einen Kunden beschränkt; IDs aus Buttons
// werden immer gegen customer_id geprüft.
import type { Queryable } from '@echte-balance/db';
import { norm } from '@echte-balance/planner/time';
import { cycleInfo, type CycleInfo, type SetRow } from './parse.ts';
import type { PlanText, TargetSet } from './plan-text.ts';

export interface Plan {
  id: number;
  name: string;
  train_days: number;
  rest_days: number;
  origin_plan_id: number | null;
}
export interface Exercise {
  id: number;
  plan_id: number;
  day_idx: number;
  pos: number;
  name: string;
  bodyweight: boolean;
  target: TargetSet[] | null; // Vorgabe je Satz (aus Trainingsplan.txt)
}
export interface LoggedSet extends SetRow {
  id: number;
  day: string;
}

/** Laufende Einheit, gespeichert als JSON in training.state.session */
export interface Session {
  day: string;
  planId: number;
  dayIdx: number;
  ex: { name: string; bw: boolean; target?: TargetSet[] | null }[];
  i: number; // aktuelle Übung
  vol: number;
  done: number[]; // abgeschlossene Übungen
  log: Record<number, LoggedSet[]>;
  ts: number; // Start (Unix-Sekunden)
  finished: boolean;
}
export const SESSION_HOURS = 10;

export interface TrainingState {
  active_plan_id: number | null;
  cycle_start: string | null;
  session: Session | null;
  bw_ask: boolean;
  bw_time: string;
  bw_pending: string | null;
}

const num = (r: any, ...keys: string[]) => {
  for (const k of keys) if (r[k] != null) r[k] = Number(r[k]);
  return r;
};

// ---------- Zustand & Vorlage ----------

const TEMPLATES = [
  { name: '3er Split', train: 3, rest: 1, days: ['Tag 1', 'Tag 2', 'Tag 3'] },
  { name: 'Recovery (Ganzkörper)', train: 1, rest: 1, days: ['Ganzkörper'] },
];

/** Beim ersten Aufruf: leere Vorlagen-Pläne anlegen. Übungen trägt jeder selbst ein. */
export async function ensureTraining(db: Queryable, customerId: number): Promise<TrainingState> {
  const created = await db.query(
    'INSERT INTO training.state (customer_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING customer_id',
    [customerId],
  );
  if (created.rowCount) {
    for (const [i, t] of TEMPLATES.entries()) {
      const plan = await createPlan(db, customerId, t.name, t.train, t.rest, i);
      for (const [d, name] of t.days.entries()) await renameDay(db, customerId, plan.id, d, name);
    }
  }
  return getState(db, customerId);
}

export async function getState(db: Queryable, customerId: number): Promise<TrainingState> {
  const { rows } = await db.query(
    `SELECT active_plan_id, cycle_start, session, bw_ask, to_char(bw_time, 'HH24:MI') AS bw_time, bw_pending
     FROM training.state WHERE customer_id = $1`,
    [customerId],
  );
  const r = rows[0];
  if (!r) return { active_plan_id: null, cycle_start: null, session: null, bw_ask: false, bw_time: '07:00', bw_pending: null };
  const s = num(r, 'active_plan_id') as TrainingState;
  if (s.session && Date.now() / 1000 - s.session.ts > SESSION_HOURS * 3600) s.session = null; // abgelaufen
  return s;
}

export async function updateState(db: Queryable, customerId: number, patch: Partial<TrainingState>) {
  const cols = Object.keys(patch) as (keyof TrainingState)[];
  if (!cols.length) return;
  await db.query(
    `UPDATE training.state SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE customer_id = $1`,
    [customerId, ...cols.map((c) => (c === 'session' && patch.session ? JSON.stringify(patch.session) : patch[c]))],
  );
}

export const saveSession = (db: Queryable, customerId: number, s: Session | null) => updateState(db, customerId, { session: s });

// ---------- Pläne ----------

const PLAN_COLS = 'id, name, train_days, rest_days, origin_plan_id';

export async function createPlan(db: Queryable, customerId: number, name: string, train: number, rest: number, pos?: number) {
  const { rows } = await db.query(
    `INSERT INTO training.plans (customer_id, name, train_days, rest_days, pos)
     VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT COALESCE(MAX(pos), 0) + 1 FROM training.plans WHERE customer_id = $1)))
     RETURNING ${PLAN_COLS}`,
    [customerId, name, train, rest, pos ?? null],
  );
  return num(rows[0], 'id', 'origin_plan_id') as Plan;
}

export async function listPlans(db: Queryable, customerId: number): Promise<Plan[]> {
  const { rows } = await db.query(`SELECT ${PLAN_COLS} FROM training.plans WHERE customer_id = $1 ORDER BY pos, id`, [customerId]);
  return rows.map((r) => num(r, 'id', 'origin_plan_id'));
}

export async function getPlan(db: Queryable, customerId: number, id: number): Promise<Plan | null> {
  const { rows } = await db.query(`SELECT ${PLAN_COLS} FROM training.plans WHERE customer_id = $1 AND id = $2`, [customerId, id]);
  return rows[0] ? num(rows[0], 'id', 'origin_plan_id') : null;
}

/** Sucht per Name oder Teil davon ("split", "3er", "recovery"). */
export async function findPlan(db: Queryable, customerId: number, input: unknown): Promise<Plan | null> {
  const q = norm(input);
  if (!q) return null;
  const all = await listPlans(db, customerId);
  return all.find((p) => norm(p.name) === q) ?? all.find((p) => norm(p.name).includes(q)) ?? null;
}

export async function deletePlan(db: Queryable, customerId: number, id: number) {
  const r = await db.query('DELETE FROM training.plans WHERE customer_id = $1 AND id = $2', [customerId, id]);
  return (r.rowCount ?? 0) > 0;
}

export async function dayName(db: Queryable, planId: number, dayIdx: number): Promise<string> {
  const { rows } = await db.query('SELECT name FROM training.plan_days WHERE plan_id = $1 AND day_idx = $2', [planId, dayIdx]);
  return rows[0]?.name ?? `Tag ${dayIdx + 1}`;
}

/** "Tag 2 - Push", bei Plänen mit nur einem Tag nur der Name */
export async function dayLabel(db: Queryable, plan: Plan, dayIdx: number): Promise<string> {
  const n = await dayName(db, plan.id, dayIdx);
  return plan.train_days === 1 || n === `Tag ${dayIdx + 1}` ? n : `Tag ${dayIdx + 1} - ${n}`;
}

export async function renameDay(db: Queryable, customerId: number, planId: number, dayIdx: number, name: string) {
  await db.query(
    `INSERT INTO training.plan_days (plan_id, day_idx, name)
     SELECT id, $3, $4 FROM training.plans WHERE id = $2 AND customer_id = $1
     ON CONFLICT (plan_id, day_idx) DO UPDATE SET name = EXCLUDED.name`,
    [customerId, planId, dayIdx, name],
  );
}

// ---------- Übungen im Plan ----------

const EX_COLS = 'e.id, e.plan_id, e.day_idx, e.pos, e.name, e.bodyweight, e.target';

export async function exercises(db: Queryable, planId: number, dayIdx: number): Promise<Exercise[]> {
  const { rows } = await db.query(
    `SELECT ${EX_COLS} FROM training.plan_exercises e WHERE e.plan_id = $1 AND e.day_idx = $2 ORDER BY e.pos, e.id`,
    [planId, dayIdx],
  );
  return rows.map((r) => num(r, 'id', 'plan_id'));
}

/** Übung nur, wenn sie zu einem Plan dieses Kunden gehört. */
export async function getExercise(db: Queryable, customerId: number, id: number): Promise<Exercise | null> {
  const { rows } = await db.query(
    `SELECT ${EX_COLS} FROM training.plan_exercises e JOIN training.plans p ON p.id = e.plan_id
     WHERE e.id = $2 AND p.customer_id = $1`,
    [customerId, id],
  );
  return rows[0] ? num(rows[0], 'id', 'plan_id') : null;
}

export async function addExercise(db: Queryable, customerId: number, planId: number, dayIdx: number, name: string) {
  const { rows } = await db.query(
    `INSERT INTO training.plan_exercises (plan_id, day_idx, pos, name)
     SELECT p.id, $3, (SELECT COALESCE(MAX(pos), 0) + 1 FROM training.plan_exercises WHERE plan_id = p.id AND day_idx = $3), $4
     FROM training.plans p WHERE p.id = $2 AND p.customer_id = $1
     RETURNING pos`,
    [customerId, planId, dayIdx, name],
  );
  return rows[0]?.pos as number | undefined;
}

export async function deleteExercise(db: Queryable, customerId: number, id: number) {
  await db.query(
    `DELETE FROM training.plan_exercises e USING training.plans p WHERE e.plan_id = p.id AND p.customer_id = $1 AND e.id = $2`,
    [customerId, id],
  );
}

export async function toggleBodyweight(db: Queryable, customerId: number, id: number): Promise<boolean | null> {
  const { rows } = await db.query(
    `UPDATE training.plan_exercises e SET bodyweight = NOT e.bodyweight FROM training.plans p
     WHERE e.plan_id = p.id AND p.customer_id = $1 AND e.id = $2 RETURNING e.bodyweight`,
    [customerId, id],
  );
  return rows[0]?.bodyweight ?? null;
}

/** Verschiebt eine Übung um eine Position nach oben (-1) oder unten (+1). */
export async function moveExercise(db: Queryable, customerId: number, id: number, dir: -1 | 1): Promise<number | null> {
  const ex = await getExercise(db, customerId, id);
  if (!ex) return null;
  const list = await exercises(db, ex.plan_id, ex.day_idx);
  const i = list.findIndex((e) => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  [list[i], list[j]] = [list[j]!, list[i]!];
  for (const [k, e] of list.entries()) {
    await db.query('UPDATE training.plan_exercises SET pos = $2 WHERE id = $1', [e.id, k + 1]);
  }
  return j;
}

// ---------- Zyklus ----------

export async function todayInfo(db: Queryable, customerId: number, st: TrainingState, day: string) {
  if (!st.active_plan_id || !st.cycle_start) return null;
  const plan = await getPlan(db, customerId, st.active_plan_id);
  if (!plan) return null;
  return { plan, ...cycleInfo(plan, st.cycle_start, day) } as { plan: Plan } & CycleInfo;
}

// ---------- Sätze ----------

export async function insertSets(
  db: Queryable,
  customerId: number,
  s: { day: string; planId: number; dayIdx: number },
  exercise: string,
  rows: SetRow[],
): Promise<LoggedSet[]> {
  const out: LoggedSet[] = [];
  for (const r of rows) {
    const res = await db.query(
      `INSERT INTO training.sets (customer_id, day, plan_id, day_idx, exercise, weight, reps, sets)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [customerId, s.day, s.planId, s.dayIdx, exercise, r.weight, r.reps, r.sets],
    );
    out.push({ ...r, id: Number(res.rows[0].id), day: s.day });
  }
  return out;
}

export async function deleteSet(db: Queryable, customerId: number, id: number) {
  await db.query('DELETE FROM training.sets WHERE customer_id = $1 AND id = $2', [customerId, id]);
}

/** Sätze der letzten Einheit dieser Übung vor `before` (im selben Plan). */
export async function lastSets(db: Queryable, customerId: number, exercise: string, before: string, planId: number) {
  const { rows } = await db.query(
    `SELECT id, day, weight, reps, sets FROM training.sets
     WHERE customer_id = $1 AND plan_id = $4 AND lower(exercise) = lower($2) AND day = (
       SELECT max(day) FROM training.sets
       WHERE customer_id = $1 AND plan_id = $4 AND lower(exercise) = lower($2) AND day < $3)
     ORDER BY id`,
    [customerId, exercise, before, planId],
  );
  return rows.map((r) => num(r, 'id')) as LoggedSet[];
}

export async function history(db: Queryable, customerId: number, query: string, limit = 12) {
  const { rows } = await db.query(
    `SELECT id, day, exercise, weight, reps, sets FROM training.sets
     WHERE customer_id = $1 AND lower(exercise) LIKE '%' || lower($2) || '%' ESCAPE '\\'
     ORDER BY day DESC, id DESC LIMIT $3`,
    [customerId, query.replace(/[%_\\]/g, (ch) => '\\' + ch), limit],
  );
  return rows.map((r) => num(r, 'id')) as (LoggedSet & { exercise: string })[];
}

/** Pro Tag: abgeschlossene Übungen (mind. ein Satz) und Anzahl der Übungen im Plan für diesen Trainingstag */
export async function exerciseProgress(db: Queryable, customerId: number, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT s.day, count(DISTINCT lower(s.exercise))::int AS done,
       (SELECT count(*)::int FROM training.plan_exercises e WHERE e.plan_id = s.plan_id AND e.day_idx = s.day_idx) AS planned
     FROM training.sets s WHERE s.customer_id = $1 AND s.day BETWEEN $2 AND $3
     GROUP BY s.day, s.plan_id, s.day_idx`,
    [customerId, from, to],
  );
  const out = new Map<string, { done: number; planned: number }>();
  for (const r of rows) {
    const cur = out.get(r.day) ?? { done: 0, planned: 0 };
    out.set(r.day, { done: cur.done + r.done, planned: cur.planned + Math.max(r.planned, r.done) });
  }
  return out;
}

export async function cardioByDay(db: Queryable, customerId: number, from: string, to: string) {
  const { rows } = await db.query(
    'SELECT day, SUM(minutes)::int AS m FROM training.cardio WHERE customer_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day',
    [customerId, from, to],
  );
  return new Map<string, number>(rows.map((r) => [r.day, r.m]));
}

// ---------- Körpergewicht ----------

/** Letztes bekanntes Körpergewicht bis zu diesem Tag (0 = unbekannt). */
export async function bodyKg(db: Queryable, customerId: number, day: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT kg FROM training.body_weight WHERE customer_id = $1 AND day <= $2 ORDER BY day DESC LIMIT 1',
    [customerId, day],
  );
  return rows[0]?.kg ?? 0;
}

export async function saveBodyWeight(db: Queryable, customerId: number, day: string, kg: number) {
  await db.query(
    `INSERT INTO training.body_weight (customer_id, day, kg) VALUES ($1, $2, $3)
     ON CONFLICT (customer_id, day) DO UPDATE SET kg = EXCLUDED.kg`,
    [customerId, day, kg],
  );
  await updateState(db, customerId, { bw_pending: null });
}

export async function recentBodyWeights(db: Queryable, customerId: number, limit = 7) {
  const { rows } = await db.query(
    'SELECT day, kg FROM training.body_weight WHERE customer_id = $1 ORDER BY day DESC LIMIT $2',
    [customerId, limit],
  );
  return rows as { day: string; kg: number }[];
}

// ---------- Ausdauer ----------

export async function addCardio(db: Queryable, customerId: number, day: string, name: string, minutes: number) {
  const { rows } = await db.query(
    'INSERT INTO training.cardio (customer_id, day, name, minutes) VALUES ($1, $2, $3, $4) RETURNING id',
    [customerId, day, name, minutes],
  );
  return Number(rows[0].id);
}

export async function deleteCardio(db: Queryable, customerId: number, id?: number) {
  const { rows } = await db.query(
    id
      ? 'DELETE FROM training.cardio WHERE customer_id = $1 AND id = $2 RETURNING name, minutes, day'
      : `DELETE FROM training.cardio WHERE id = (SELECT id FROM training.cardio WHERE customer_id = $1 ORDER BY id DESC LIMIT 1)
         RETURNING name, minutes, day`,
    id ? [customerId, id] : [customerId],
  );
  return (rows[0] ?? null) as { name: string; minutes: number; day: string } | null;
}

export async function getCardio(db: Queryable, customerId: number, id: number) {
  const { rows } = await db.query('SELECT name FROM training.cardio WHERE customer_id = $1 AND id = $2', [customerId, id]);
  return (rows[0]?.name ?? null) as string | null;
}

/** Zuletzt genutzte Ausdauer-Arten (für Buttons) */
export async function recentCardio(db: Queryable, customerId: number) {
  const { rows } = await db.query(
    `SELECT max(name) AS name, max(id) AS id FROM training.cardio WHERE customer_id = $1
     GROUP BY lower(name) ORDER BY max(id) DESC LIMIT 6`,
    [customerId],
  );
  return rows.map((r) => num(r, 'id')) as { name: string; id: number }[];
}

export async function cardioDayTotal(db: Queryable, customerId: number, day: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(minutes), 0)::int AS m FROM training.cardio WHERE customer_id = $1 AND day = $2',
    [customerId, day],
  );
  return rows[0].m;
}

export interface CardioSummary {
  minutes: number;
  days: number;
  byName: { name: string; minutes: number; days: number; n: number }[];
}

export async function cardioSummary(db: Queryable, customerId: number, from: string, to: string): Promise<CardioSummary> {
  const { rows } = await db.query(
    `SELECT max(name) AS name, SUM(minutes)::int AS minutes, COUNT(DISTINCT day)::int AS days, COUNT(*)::int AS n
     FROM training.cardio WHERE customer_id = $1 AND day BETWEEN $2 AND $3
     GROUP BY lower(name) ORDER BY SUM(minutes) DESC`,
    [customerId, from, to],
  );
  const days = await db.query(
    'SELECT COUNT(DISTINCT day)::int AS n FROM training.cardio WHERE customer_id = $1 AND day BETWEEN $2 AND $3',
    [customerId, from, to],
  );
  return { minutes: rows.reduce((a, r) => a + r.minutes, 0), days: days.rows[0].n, byName: rows };
}

/** Nutzer mit aktiver Gewichtsabfrage - für den minütlichen Takt */
export async function bodyWeightAskers(db: Queryable) {
  const { rows } = await db.query(
    `SELECT c.id, c.telegram_user_id, c.timezone, to_char(s.bw_time, 'HH24:MI') AS bw_time
     FROM training.state s JOIN core.customers c ON c.id = s.customer_id
     WHERE s.bw_ask AND c.deleted_at IS NULL`,
  );
  return rows.map((r) => ({ id: Number(r.id), telegramUserId: Number(r.telegram_user_id), timezone: r.timezone as string, bwTime: r.bw_time as string }));
}

// ---------- Plan als Textdatei: Import und Export ----------

/**
 * Legt einen Plan aus einer Trainingsplan.txt an. Mit replacePlanId wird ein bestehender Plan
 * ersetzt (gleiche Plan-ID → "Wie letztes Mal" und Verlauf bleiben verknüpft).
 * Innerhalb einer Transaktion aufrufen.
 */
export async function importPlan(db: Queryable, customerId: number, p: PlanText, replacePlanId?: number): Promise<Plan> {
  let plan: Plan;
  if (replacePlanId) {
    const existing = await getPlan(db, customerId, replacePlanId);
    if (!existing) throw new Error('Plan nicht gefunden');
    await db.query('UPDATE training.plans SET name = $3, train_days = $4, rest_days = $5 WHERE id = $1 AND customer_id = $2', [
      replacePlanId, customerId, p.name, p.trainDays, p.restDays,
    ]);
    await db.query('DELETE FROM training.plan_exercises WHERE plan_id = $1', [replacePlanId]);
    await db.query('DELETE FROM training.plan_days WHERE plan_id = $1', [replacePlanId]);
    plan = { ...existing, name: p.name, train_days: p.trainDays, rest_days: p.restDays };
  } else {
    plan = await createPlan(db, customerId, p.name, p.trainDays, p.restDays);
  }
  for (const [d, day] of p.days.entries()) {
    await renameDay(db, customerId, plan.id, d, day.name);
    for (const [i, e] of day.exercises.entries()) {
      await db.query(
        'INSERT INTO training.plan_exercises (plan_id, day_idx, pos, name, bodyweight, target) VALUES ($1, $2, $3, $4, $5, $6)',
        [plan.id, d, i + 1, e.name, e.bodyweight, e.targets.length ? JSON.stringify(e.targets) : null],
      );
    }
  }
  return plan;
}

/** Plan in das Textformat zurückverwandeln (für /plan export) */
export async function planAsText(db: Queryable, customerId: number, planId: number): Promise<PlanText | null> {
  const plan = await getPlan(db, customerId, planId);
  if (!plan) return null;
  const days = [];
  for (let d = 0; d < plan.train_days; d++) {
    const ex = await exercises(db, plan.id, d);
    days.push({
      name: await dayName(db, plan.id, d),
      exercises: ex.map((e) => ({ name: e.name, bodyweight: e.bodyweight, targets: e.target ?? [] })),
    });
  }
  return { name: plan.name, trainDays: plan.train_days, restDays: plan.rest_days, days, warnings: [] };
}

/**
 * Plan eines Nutzers (z. B. des Admins) als eigene Kopie an einen anderen Nutzer geben.
 * Das Original bleibt unverändert; die Kopie merkt sich ihre Herkunft (origin_plan_id).
 * Innerhalb einer Transaktion aufrufen.
 */
export async function copyPlan(db: Queryable, fromCustomerId: number, planId: number, toCustomerId: number): Promise<Plan> {
  const source = await planAsText(db, fromCustomerId, planId);
  if (!source) throw new Error('Plan nicht gefunden');
  await ensureTraining(db, toCustomerId);
  const copy = await importPlan(db, toCustomerId, source);
  await db.query('UPDATE training.plans SET origin_plan_id = $2 WHERE id = $1', [copy.id, planId]);
  return { ...copy, origin_plan_id: planId };
}
