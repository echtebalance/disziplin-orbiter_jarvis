// Auswertung für /stats und die automatischen Berichte.
//
// Wertung pro Aufgabe (Anzeige ohne Obergrenze, also auch 200 %):
//   Zeit       eingetragene Minuten ÷ (Mindestzeit × Tage, an denen die Aufgabe dran war).
//              Mehr Zeit an einem Tag gleicht weniger an einem anderen derselben Aufgabe aus.
//   Wochensoll Wochensoll verteilt auf die Tage der Woche, an denen die Aufgabe dran ist
//              (Arbeit: ohne freie Tage und Urlaub).
//   Training   an Tagen mit Sätzen: abgeschlossene Übungen ÷ Übungen im Plan;
//              an Tagen ohne Sätze: Zeit (Trainingszeit oder Ausdauer) ÷ Mindestzeit.
// Gesamtquote: Jede Aufgabe zählt höchstens 100 %, gewichtet nach ihren Tagen. So gleicht
// eine Aufgabe mit 200 % keine andere aus.
import type { Queryable } from '@echte-balance/db';
import { addDays, dayNum, dd, dowOf, numDay, weekStart, type LocalNow } from './time.ts';
import { countVacationDays, firstLogDays, listHabits, logsBetween, type Habit, type LogEntry } from './store.ts';

export type ScoreMode = 'time' | 'weekly' | 'exercises';

export interface HabitStat {
  habit: Habit;
  mode: ScoreMode;
  planned: number; // Tage, an denen die Aufgabe dran war
  done: number; // Tage mit Leistung
  skipped: number;
  entered: number;
  missing: number; // dran, aber nichts eingetragen
  minutes: number;
  goalMin: number; // Soll-Minuten im Zeitraum (bei Zeit/Wochensoll)
  pct: number | null; // ohne Obergrenze
  exDone: number; // Training: abgeschlossene Übungen
  exPlanned: number; // Training: geplante Übungen an Tagen mit Sätzen
}

export interface StatsResult {
  from: string;
  to: string;
  byDay: boolean;
  rows: HabitStat[]; // zählende Aufgaben
  timeOnly: HabitStat[]; // nur Zeiterfassung (z. B. Arbeit), getrennt von der Quote
  planned: number;
  done: number;
  entered: number;
  missing: number;
  totalMinutes: number;
  pct: number;
  minutesByCategory: { work: number; hustle: number; habit: number };
  vacationDays: number;
}

/** Liefert für einen Tag, ob laut Trainingszyklus trainiert wird; null = kein Zyklus aktiv. */
export type TrainingDayFn = (day: string) => boolean | null;

export interface StatsOptions {
  trainingDay?: TrainingDayFn;
  /** Tag ist frei oder Urlaub (Arbeit pausiert) */
  pausedDay?: (day: string) => boolean;
  /** Training: pro Tag abgeschlossene und geplante Übungen */
  exercisesByDay?: Map<string, { done: number; planned: number }>;
  /** Ausdauer-Minuten pro Tag */
  cardioByDay?: Map<string, number>;
}

/**
 * Ist die Aufgabe an diesem Tag dran? Die Aufgabe "training" folgt dem Trainingszyklus,
 * sofern einer aktiv ist; alles andere den eingestellten Wochentagen.
 */
export function applies(h: Habit, day: string, trainingDay?: TrainingDayFn): boolean {
  if (h.key === 'training' && trainingDay) {
    const t = trainingDay(day);
    if (t !== null) return t;
  }
  return h.days.includes(dowOf(day));
}

const isTraining = (h: Habit) => h.key === 'training';

export async function computeStats(
  db: Queryable,
  customerId: number,
  from: string,
  to: string,
  today: string,
  opts: StatsOptions = {},
): Promise<StatsResult> {
  const byDay = from === to;
  const habits = await listHabits(db, customerId, true);
  const logs = await logsBetween(db, customerId, from, to);
  const firstLog = await firstLogDays(db, customerId);
  const globalFirst = [...firstLog.values()].sort()[0] ?? today;
  const logByHabit = new Map<number, Map<string, LogEntry>>();
  for (const l of logs) {
    if (!logByHabit.has(l.habit_id)) logByHabit.set(l.habit_id, new Map());
    logByHabit.get(l.habit_id)!.set(l.day, l);
  }
  const trainingData = (day: string) => !!opts.exercisesByDay?.get(day)?.done || !!opts.cardioByDay?.get(day);
  const firstTrainingDay = [...(opts.exercisesByDay?.keys() ?? []), ...(opts.cardioByDay?.keys() ?? [])].sort()[0];

  const isDue = (h: Habit, day: string) =>
    applies(h, day, opts.trainingDay) && !(h.category === 'work' && opts.pausedDay?.(day));

  /** Tage im Zeitraum (bis heute), an denen die Aufgabe gewertet wird */
  function plannedDays(h: Habit, hl: Map<string, LogEntry>): string[] {
    let first = firstLog.get(h.id) ?? globalFirst;
    if (isTraining(h) && firstTrainingDay && firstTrainingDay < first) first = firstTrainingDay;
    const out: string[] = [];
    for (let d = dayNum(from); d <= dayNum(to); d++) {
      const day = numDay(d);
      if (day > today) break;
      if (!isDue(h, day) || day < first) continue; // vor dem ersten Eintrag nicht werten
      const hasData = hl.has(day) || (isTraining(h) && trainingData(day));
      if (day === today && !byDay && !hasData) continue; // heute erst, wenn eingetragen
      out.push(day);
    }
    return out;
  }

  /** Wochensoll eines Tages: Wochensoll ÷ Anzahl der Tage dieser Woche, an denen die Aufgabe dran ist */
  function weeklyShare(h: Habit, day: string): number {
    const ws = weekStart(day);
    let n = 0;
    for (let k = 0; k < 7; k++) if (isDue(h, addDays(ws, k))) n++;
    return n ? h.weekly_goal_min! / n : 0;
  }

  const rows: HabitStat[] = [];
  const timeOnly: HabitStat[] = [];
  const minutesByCategory = { work: 0, hustle: 0, habit: 0 };
  let P = 0, D = 0, E = 0, M = 0, total = 0, weighted = 0;

  for (const h of habits) {
    const hl = logByHabit.get(h.id) ?? new Map<string, LogEntry>();
    const days = plannedDays(h, hl);
    const daySet = new Set(days);
    // Tage mit Daten, die nicht geplant waren (z. B. Training am Pausentag), zählen auch
    const allDays = new Set([...days, ...hl.keys()]);
    if (isTraining(h)) {
      for (const d of [...(opts.exercisesByDay?.keys() ?? []), ...(opts.cardioByDay?.keys() ?? [])]) {
        if (d >= from && d <= to && d <= today) allDays.add(d);
      }
    }
    const st: HabitStat = {
      habit: h, mode: h.weekly_goal_min ? 'weekly' : 'time', planned: 0, done: 0, skipped: 0, entered: 0,
      missing: 0, minutes: 0, goalMin: 0, pct: null, exDone: 0, exPlanned: 0,
    };
    let score = 0; // Summe der Tageswerte (Training)

    for (const day of [...allDays].sort()) {
      const log = hl.get(day);
      const logMin = log?.status === 'done' ? log.minutes : 0;
      const counted = daySet.has(day);
      if (isTraining(h) && (opts.exercisesByDay || opts.cardioByDay)) {
        const ex = opts.exercisesByDay?.get(day);
        if (ex && ex.done > 0) {
          const planned = Math.max(ex.planned, ex.done);
          st.mode = 'exercises';
          st.exDone += ex.done;
          st.exPlanned += planned;
          score += ex.done / planned;
          st.done++;
          st.entered++;
          st.minutes += logMin;
          continue;
        }
        const time = Math.max(logMin, opts.cardioByDay?.get(day) ?? 0); // nicht doppelt zählen
        if (time > 0) {
          score += h.min_min ? time / h.min_min : 1;
          st.done++;
          st.entered++;
          st.minutes += time;
        } else if (log?.status === 'skipped') {
          st.skipped++;
          st.entered++;
        } else if (!counted) continue;
        continue;
      }
      if (log?.status === 'done') {
        st.done++;
        st.entered++;
        st.minutes += logMin;
      } else if (log?.status === 'skipped') {
        st.skipped++;
        st.entered++;
      }
    }

    st.planned = Math.max(days.length, st.entered);
    st.missing = Math.max(0, st.planned - st.entered);
    if (isTraining(h) && (opts.exercisesByDay || opts.cardioByDay)) {
      st.goalMin = st.planned * h.min_min;
      st.pct = st.planned ? Math.round((score / st.planned) * 100) : null;
    } else if (h.weekly_goal_min) {
      st.goalMin = Math.round([...allDays].reduce((a, d) => a + (daySet.has(d) || hl.has(d) ? weeklyShare(h, d) : 0), 0));
      st.pct = st.goalMin ? Math.round((st.minutes / st.goalMin) * 100) : null;
    } else {
      st.goalMin = st.planned * h.min_min;
      st.pct = st.goalMin ? Math.round((st.minutes / st.goalMin) * 100) : null;
    }
    minutesByCategory[h.category] += st.minutes;

    if (!h.counts) {
      if (st.done || (h.weekly_goal_min && st.planned)) timeOnly.push(st);
      continue;
    }
    if (!st.planned && !st.done) continue;
    rows.push(st);
    P += st.planned;
    D += st.done;
    E += st.entered;
    M += st.missing;
    total += st.minutes;
    weighted += Math.min(st.pct ?? 0, 100) * st.planned;
  }

  return {
    from, to, byDay, rows, timeOnly,
    planned: P, done: D, entered: E, missing: M, totalMinutes: total,
    pct: P ? Math.round(weighted / P) : 0,
    minutesByCategory,
    vacationDays: await countVacationDays(db, customerId, from, to),
  };
}

// ---------- Zeiträume ----------

export interface Period {
  title: string;
  from: string;
  to: string;
}

export function currentPeriod(kind: 'heute' | 'woche' | 'monat' | 'jahr', now: LocalNow): Period {
  const [y, m] = now.day.split('-');
  if (kind === 'woche') {
    const from = weekStart(now.day);
    return { title: `Woche ${dd(from)} - ${dd(now.day)}`, from, to: now.day };
  }
  if (kind === 'monat') return { title: `Monat ${m}/${y}`, from: `${y}-${m}-01`, to: now.day };
  if (kind === 'jahr') return { title: `Jahr ${y}`, from: `${y}-01-01`, to: now.day };
  return { title: `Heute ${dd(now.day)}`, from: now.day, to: now.day };
}

export function previousPeriod(kind: 'woche' | 'monat' | 'jahr', now: LocalNow): Period {
  if (kind === 'woche') {
    const from = addDays(weekStart(now.day), -7);
    const to = addDays(from, 6);
    return { title: `Vorwoche ${dd(from)} - ${dd(to)}`, from, to };
  }
  if (kind === 'monat') {
    const last = addDays(`${now.day.slice(0, 7)}-01`, -1);
    return { title: `Vormonat ${last.slice(5, 7)}/${last.slice(0, 4)}`, from: `${last.slice(0, 7)}-01`, to: last };
  }
  const y = +now.day.slice(0, 4) - 1;
  return { title: `Vorjahr ${y}`, from: `${y}-01-01`, to: `${y}-12-31` };
}
