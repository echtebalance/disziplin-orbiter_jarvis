// Reine Funktionen fürs Training: Satz-Eingabe, Körpergewicht, Zyklus, Anzeige.
import { dayNum } from '@echte-balance/planner/time';

export interface SetRow {
  weight: number;
  reps: number;
  sets: number;
}

/**
 * "75x8", "75x8, 80x8", "60 8 3" (Gewicht Wdh. Durchgänge), "0 12 3" (nur Körpergewicht).
 * Trenner zwischen Sätzen: Komma+Leerzeichen, ; | oder Zeilenumbruch.
 */
export function parseSets(text: string): { rows: SetRow[] } | { error: string } | null {
  const parts = String(text).split(/\s*[;\n|]\s*|,\s+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 15) return null;
  const rows: SetRow[] = [];
  for (const p of parts) {
    const m = p.match(/^(\d+(?:[.,]\d+)?)\s*(?:kg)?[\s,x×*]+(\d+)(?:[\s,x×*]+(\d+))?$/i);
    if (!m) return null;
    const weight = parseFloat(m[1]!.replace(',', '.'));
    const reps = parseInt(m[2]!, 10);
    const sets = m[3] ? parseInt(m[3], 10) : 1;
    if (weight > 1000 || reps < 1 || reps > 200 || sets < 1 || sets > 30) {
      return { error: 'Die Werte sehen unplausibel aus. Beispiel: 60 8 3' };
    }
    rows.push({ weight, reps, sets });
  }
  return { rows };
}

/** "82,5", "82.5 kg" → 82.5 (30-300 kg) */
export function parseKg(text: unknown): number | null {
  const m = String(text ?? '').trim().match(/^(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg)?$/i);
  if (!m) return null;
  const kg = parseFloat(m[1]!.replace(',', '.'));
  return kg >= 30 && kg <= 300 ? kg : null;
}

export interface CycleInfo {
  idx: number; // Position im Zyklus
  train: boolean;
  dayIdx: number | null; // Trainingstag des Plans (0-basiert) oder null an Pausentagen
}

/** Wo im Zyklus liegt `day`, wenn der Zyklus am `cycleStart` mit Tag 1 begonnen hat? */
export function cycleInfo(plan: { train_days: number; rest_days: number }, cycleStart: string, day: string): CycleInfo {
  const len = plan.train_days + plan.rest_days;
  const idx = (((dayNum(day) - dayNum(cycleStart)) % len) + len) % len;
  const train = idx < plan.train_days;
  return { idx, train, dayIdx: train ? idx : null };
}

export const fmtW = (w: number) => (w === 0 ? 'Körpergewicht' : `${String(w).replace('.', ',')} kg`);
export const fmtSet = (s: SetRow) => `${fmtW(s.weight)} × ${s.reps}${s.sets > 1 ? ` × ${s.sets}` : ''}`;
export const fmtRows = (rows: SetRow[]) => rows.map(fmtSet).join(' · ');
export const fmtKg = (k: number) => String(k).replace('.', ',');
export const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

/** Volumen in kg: (Körpergewicht bei KG-Übungen + Zusatzgewicht) × Wdh. × Durchgänge */
export const volume = (rows: SetRow[], bodyKg = 0) => rows.reduce((a, r) => a + (bodyKg + r.weight) * r.reps * r.sets, 0);
