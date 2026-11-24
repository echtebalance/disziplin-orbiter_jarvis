// Trainingsplan als einfache Textdatei (Trainingsplan.txt): einlesen und ausgeben.
//
// Format (Groß-/Kleinschreibung egal, # leitet Kommentare ein):
//   Plan: Push Pull Beine
//   Zyklus: 3 1                                  3 Trainingstage, danach 1 Tag Pause
//   Tag 1: Push
//   Bankdrücken: 60kg x 10, 70kg x 8, 80kg x 6   Gewicht x Wiederholungen je Satz
//   Schrägbank: 3x10 @ 24kg                      Sätze x Wiederholungen @ Gewicht
//   Kniebeuge: 100x5x5                           Gewicht x Wiederholungen x Sätze (wie beim Eintragen)
//   Dips (KG): 3x12                              (KG) = Körpergewichtsübung
//   Seitheben: 3x12-15 @ 8kg                     Wiederholungsbereich
//   Plank (KG): 3x60s                            Sekunden
//   Face Pulls                                   ohne Vorgabe
//
// Bei "AxB" ohne kg/@: A bis 10 = Sätze x Wiederholungen, sonst Gewicht x Wiederholungen.
// Die Vorschau im Bot zeigt, wie jede Zeile verstanden wurde.

export interface TargetSet {
  weight: number | null; // null = keine Gewichtsvorgabe; 0 = nur Körpergewicht
  reps: string; // "10", "8-12" oder "60s"
}
export interface PlanTextExercise {
  name: string;
  bodyweight: boolean;
  targets: TargetSet[];
}
export interface PlanTextDay {
  name: string;
  exercises: PlanTextExercise[];
}
export interface PlanText {
  name: string;
  trainDays: number;
  restDays: number;
  days: PlanTextDay[];
  warnings: string[];
}

export class PlanTextError extends Error {}

const LIMITS = { lines: 400, days: 7, exercisesPerDay: 25, sets: 15, name: 40, exercise: 60 };
const NUM = String.raw`\d+(?:[.,]\d+)?`;
const REPS = String.raw`\d{1,3}(?:\s*-\s*\d{1,3})?\s*s?`;
const num = (s: string) => parseFloat(s.replace(',', '.'));
const reps = (s: string) => s.replace(/\s+/g, '');
const BW_WORDS = /^(kg|bw|körpergewicht|koerpergewicht)$/i;

/** Satz-Angabe → Liste der Sätze. null = nicht verstanden. */
export function parseTargets(spec: string): { targets: TargetSet[]; bodyweight: boolean } | null {
  const s = spec.trim().replace(/×/g, 'x').replace(/\s+/g, ' ');
  if (!s) return { targets: [], bodyweight: false };
  const items = s.split(/\s*[;|]\s*|,\s+/).filter(Boolean);
  const out: TargetSet[] = [];
  let bodyweight = false;
  for (const raw of items) {
    const it = raw.trim();
    let m: RegExpMatchArray | null;
    // 3x10 @ 24kg · 3x12 @ KG · 3x10
    if ((m = it.match(new RegExp(`^(\\d{1,2})\\s*x\\s*(${REPS})(?:\\s*@\\s*(${NUM}|kg|bw|körpergewicht)\\s*(?:kg)?)?$`, 'i')))) {
      const sets = Number(m[1]);
      const plainSmall = !m[3] && items.length === 1 && sets <= 10;
      if (m[3] || plainSmall) {
        const isBw = !!m[3] && BW_WORDS.test(m[3]);
        bodyweight ||= isBw;
        const weight = m[3] ? (isBw ? 0 : num(m[3])) : null;
        for (let i = 0; i < sets; i++) out.push({ weight, reps: reps(m[2]!) });
        continue;
      }
    }
    // 100x5x5 · 100kg x 5 x 5 (Gewicht x Wdh. x Sätze)
    if ((m = it.match(new RegExp(`^(${NUM})\\s*(?:kg)?\\s*x\\s*(${REPS})\\s*x\\s*(\\d{1,2})$`, 'i')))) {
      for (let i = 0; i < Number(m[3]); i++) out.push({ weight: num(m[1]!), reps: reps(m[2]!) });
      continue;
    }
    // 60kg x 10 · 60 x 10 · KG x 12
    if ((m = it.match(new RegExp(`^(${NUM}|kg|bw)\\s*(?:kg)?\\s*x\\s*(${REPS})$`, 'i')))) {
      const isBw = BW_WORDS.test(m[1]!);
      bodyweight ||= isBw;
      out.push({ weight: isBw ? 0 : num(m[1]!), reps: reps(m[2]!) });
      continue;
    }
    return null;
  }
  if (out.length > LIMITS.sets) return null;
  return { targets: out, bodyweight };
}

export function parsePlanText(text: string, fallbackName = 'Importierter Plan'): PlanText {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines.length > LIMITS.lines) throw new PlanTextError(`Die Datei ist zu lang (max. ${LIMITS.lines} Zeilen).`);
  let name = '';
  let cycle: [number, number] | null = null;
  let restOnly: number | null = null;
  const days: PlanTextDay[] = [];
  const warnings: string[] = [];
  const current = () => {
    if (!days.length) days.push({ name: 'Tag 1', exercises: [] });
    return days.at(-1)!;
  };

  lines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/\s+#.*$/, '').replace(/^#.*$/, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!line) return;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^plan\s*:\s*(.+)$/i))) {
      name = m[1]!.trim().slice(0, LIMITS.name);
      return;
    }
    if ((m = line.match(/^(?:zyklus|cycle)\s*:\s*(\d)\s*[+/,\s]\s*(\d)/i))) {
      cycle = [Number(m[1]), Number(m[2])];
      return;
    }
    if ((m = line.match(/^pause(?:ntage)?\s*:\s*(\d)/i))) {
      restOnly = Number(m[1]);
      return;
    }
    if ((m = line.match(/^(?:tag|day)\s*(\d{1,2})\b\s*[:.\-]?\s*(.*)$/i))) {
      if (days.length >= LIMITS.days) throw new PlanTextError(`Maximal ${LIMITS.days} Trainingstage.`);
      days.push({ name: (m[2]!.trim() || `Tag ${days.length + 1}`).slice(0, LIMITS.name), exercises: [] });
      return;
    }
    // Übung: "Name: Vorgabe" (oder ohne Vorgabe)
    const sep = line.search(/\s*:\s*|\t|\s\|\s/);
    let exName = sep >= 0 ? line.slice(0, sep) : line;
    const spec = sep >= 0 ? line.slice(sep).replace(/^\s*[:|\t]\s*/, '') : '';
    let bodyweight = false;
    exName = exName.replace(/\s*[([](kg|bw|körpergewicht|koerpergewicht)[)\]]\s*/i, () => {
      bodyweight = true;
      return ' ';
    }).trim();
    if (!exName) return;
    const parsed = parseTargets(spec);
    if (!parsed) {
      warnings.push(`Zeile ${idx + 1}: „${rawLine.trim().slice(0, 60)}“ - Vorgabe nicht verstanden, Übung ohne Vorgabe übernommen`);
    }
    const day = current();
    if (day.exercises.length >= LIMITS.exercisesPerDay) throw new PlanTextError(`Maximal ${LIMITS.exercisesPerDay} Übungen pro Tag (${day.name}).`);
    day.exercises.push({ name: exName.slice(0, LIMITS.exercise), bodyweight: bodyweight || !!parsed?.bodyweight, targets: parsed?.targets ?? [] });
  });

  const used = days.filter((d) => d.exercises.length);
  if (!used.length) throw new PlanTextError('Keine Übungen gefunden. Vorlage: /plan vorlage');
  if (used.length !== days.length) warnings.push('Trainingstage ohne Übungen wurden weggelassen.');
  let trainDays = used.length;
  let restDays: number = restOnly ?? 1;
  if (cycle) {
    const [t, r] = cycle as [number, number];
    restDays = r;
    if (t !== used.length) warnings.push(`„Zyklus: ${t} ${r}“, aber ${used.length} Trainingstage in der Datei - es gilt ${used.length}.`);
  }
  if (restDays > 7) restDays = 7;
  return { name: name || fallbackName.slice(0, LIMITS.name), trainDays, restDays, days: used, warnings };
}

// ---------- Ausgabe ----------

const fmtW = (w: number) => String(w).replace('.', ',');

/** Kompakte Anzeige: "3x10 @ 24 kg" wenn alle Sätze gleich, sonst "60kg x 10, 70kg x 8" */
export function formatTargets(targets: TargetSet[], bodyweight = false): string {
  if (!targets.length) return '';
  const same = targets.every((t) => t.weight === targets[0]!.weight && t.reps === targets[0]!.reps);
  const w = (x: number | null) => (x === null ? '' : x === 0 && bodyweight ? ' @ KG' : ` @ ${fmtW(x)}kg`);
  if (same) return `${targets.length}x${targets[0]!.reps}${w(targets[0]!.weight)}`;
  return targets
    .map((t) => (t.weight === null ? `?x${t.reps}` : t.weight === 0 && bodyweight ? `KG x ${t.reps}` : `${fmtW(t.weight)}kg x ${t.reps}`))
    .join(', ');
}

export function formatPlanText(plan: { name: string; trainDays: number; restDays: number; days: PlanTextDay[] }): string {
  const out = [
    `# Trainingsplan für BΛLΛNCΣ - anpassen und als Datei an den Bot schicken.`,
    `# Format: Gewicht x Wdh. je Satz (60kg x 10, 70kg x 8) oder Sätze x Wdh. @ Gewicht (3x10 @ 24kg); (KG) = Körpergewicht`,
    '',
    `Plan: ${plan.name}`,
    `Zyklus: ${plan.trainDays} ${plan.restDays}`,
  ];
  plan.days.forEach((d, i) => {
    out.push('', `Tag ${i + 1}: ${d.name}`);
    for (const e of d.exercises) {
      const t = formatTargets(e.targets, e.bodyweight);
      out.push(`${e.name}${e.bodyweight ? ' (KG)' : ''}${t ? `: ${t}` : ''}`);
    }
  });
  return out.join('\n') + '\n';
}

export const PLAN_TEMPLATE = `# Trainingsplan für BΛLΛNCΣ - einfach anpassen und als Datei an den Bot schicken.
# Alles hinter # wird ignoriert.

Plan: Push Pull Beine
Zyklus: 3 1                                     # 3 Trainingstage, danach 1 Tag Pause

Tag 1: Push
Bankdrücken: 60kg x 10, 70kg x 8, 80kg x 6      # Gewicht x Wiederholungen je Satz
Schrägbank Kurzhantel: 3x10 @ 24kg              # 3 Sätze à 10 Wdh. mit 24 kg
Dips (KG): 3x12                                 # (KG) = Körpergewichtsübung
Seitheben: 3x12-15 @ 8kg                        # Wiederholungsbereich

Tag 2: Pull
Klimmzüge (KG): 4x8
Rudern Langhantel: 4x10 @ 60kg
Bizeps Curls: 3x12 @ 14kg
Face Pulls                                      # ohne Vorgabe

Tag 3: Beine
Kniebeugen: 60kg x 10, 80kg x 8, 100kg x 6, 100kg x 6
Beinpresse: 3x12 @ 150kg
Wadenheben: 100x15x4                            # Gewicht x Wdh. x Sätze
Plank (KG): 3x60s                               # Sekunden statt Wiederholungen
`;
