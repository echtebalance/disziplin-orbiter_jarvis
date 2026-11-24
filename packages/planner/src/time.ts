// Datum, Uhrzeit und Eingaben des Planers. Alles rechnet mit dem Ortsdatum des Nutzers
// ('YYYY-MM-DD', 'HH:MM'). Reine Funktionen, ohne Datenbank (aus jarvis-satellite/planner.js).

export const DAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const DMAP: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
const FULL_DAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export interface LocalNow {
  day: string; // YYYY-MM-DD
  time: string; // HH:MM
  dow: number; // 0 = Sonntag
  minutes: number; // Minuten seit Mitternacht
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Aktuelles Datum und Uhrzeit in der Zeitzone des Nutzers. */
export function nowIn(timezone: string, at: Date = new Date()): LocalNow {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { day, time, dow: dowOf(day), minutes: toMin(time) };
}

export const dayNum = (d: string) => {
  const [y, m, x] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, x) / 86400000;
};
export const numDay = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
export const dowOf = (d: string) => new Date(dayNum(d) * 86400000).getUTCDay();
export const addDays = (d: string, n: number) => numDay(dayNum(d) + n);
/** Montag der Woche */
export const weekStart = (d: string) => addDays(d, -((dowOf(d) + 6) % 7));
export const isValidDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && numDay(dayNum(d)) === d;

export const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
export const hhmm = (m: number) => {
  m = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// ---------- Anzeige ----------

export const fmtDur = (m: number) =>
  m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'min' : ''}`;
export const fmtRange = (min: number, max: number) => (min === max ? fmtDur(max) : `${fmtDur(min)}-${fmtDur(max)}`);
export const dd = (d: string) => `${DAY_NAMES[dowOf(d)]} ${d.slice(8, 10)}.${d.slice(5, 7)}.`;
export const weekLabel = (ws: string) => `${dd(ws)} - ${dd(addDays(ws, 6))}`;
/** Montag zuerst */
export const sortDays = (a: number[]) => [...new Set(a)].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
export const freeLabel = (a: number[]) => (a.length ? sortDays(a).map((d) => DAY_NAMES[d]).join(', ') : 'keine');
export function dayLabel(days: number[]): string {
  const s = [...days].sort().join(',');
  if (s === '0,1,2,3,4,5,6') return 'täglich';
  if (s === '1,2,3,4,5,6') return 'Mo-Sa';
  if (s === '1,2,3,4,5') return 'Mo-Fr';
  return sortDays(days).map((d) => DAY_NAMES[d]).join(',');
}
/** Für Vergleiche ohne Umlaute, Groß-/Kleinschreibung und Sonderzeichen */
export const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

// ---------- Eingaben ----------

/** "45", "1:30", "1h30", "1,5h", "90min" → Minuten */
export function parseMinutes(input: unknown): number | null {
  const s = String(input ?? '').trim().toLowerCase().replace(',', '.');
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+):(\d{2})$/))) return +m[1]! * 60 + +m[2]!;
  if ((m = s.match(/^(\d+)h(\d{1,2})(?:min|m)?$/))) return +m[1]! * 60 + +m[2]!;
  if ((m = s.match(/^(\d+(?:\.\d+)?)h$/))) return Math.round(parseFloat(m[1]!) * 60);
  if ((m = s.match(/^(\d+)(?:min|m)?$/))) return +m[1]!;
  return null;
}

/** "9", "9:30", "09.30" → "HH:MM" */
export function parseTime(input: unknown): string | null {
  const m = String(input ?? '').match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const h = +m[1]!;
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** "täglich", "werktags", "mo-sa", "mo,mi,fr" → Wochentage */
export function parseDays(input: unknown): number[] | null {
  const s = String(input ?? '').toLowerCase().replace(/\s/g, '');
  if (['täglich', 'taeglich', 'alle', 'tgl'].includes(s)) return [...ALL_DAYS];
  if (s === 'werktags') return [1, 2, 3, 4, 5];
  const set = new Set<number>();
  for (const part of s.split(',')) {
    const m = part.match(/^([a-z]{2})(?:-([a-z]{2}))?$/);
    if (!m || !(m[1]! in DMAP) || (m[2] && !(m[2] in DMAP))) return null;
    let a = DMAP[m[1]!]!;
    const b = m[2] ? DMAP[m[2]]! : a;
    for (let i = 0; i < 7; i++) {
      set.add(a);
      if (a === b) break;
      a = (a + 1) % 7;
    }
  }
  return [...set].sort((x, y) => x - y);
}

/** "di", "Dienstag", "Sa" (mehrere Wörter) → Wochentage */
export function parseFreeDays(tokens: string[]): number[] | null {
  const set = new Set<number>();
  for (const raw of tokens) {
    const t = raw.toLowerCase().replace(/[.,;]/g, '');
    if (!t) continue;
    const i = t.length >= 2 ? FULL_DAYS.findIndex((f) => f.startsWith(t)) : -1;
    if (i < 0) return null;
    set.add(i);
  }
  return sortDays([...set]);
}

export class InputError extends Error {}

/** "/termin Physio 20.10. 14:30", "Zahnarzt morgen 9:00", "Arzt Mittwoch 8:15" */
export function parseTermin(text: string, now: LocalNow): { title: string; day: string; time: string } | null {
  const t = text.trim().split(/\s+/).filter(Boolean);
  if (t.length < 3) return null;
  const time = parseTime(t.pop());
  const tok = t.pop()!.toLowerCase();
  const title = t.join(' ');
  if (!time) throw new InputError('Uhrzeit nicht erkannt (z. B. 14:30).');
  let day: string;
  const wd = tok.match(/^(mo|di|mi|do|fr|sa|so)(ntag|enstag|ttwoch|nnerstag|eitag|mstag|nntag)?$/);
  if (tok === 'heute') day = now.day;
  else if (tok === 'morgen') day = addDays(now.day, 1);
  else if (tok === 'übermorgen' || tok === 'uebermorgen') day = addDays(now.day, 2);
  else if (wd) {
    let diff = (DMAP[wd[1]!]! - now.dow + 7) % 7;
    if (diff === 0 && toMin(time) <= now.minutes) diff = 7;
    day = addDays(now.day, diff);
  } else {
    const m = tok.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/);
    if (!m) throw new InputError(`Datum nicht erkannt: ${tok}`);
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +now.day.slice(0, 4);
    const mk = (Y: number) => `${Y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    day = mk(y);
    if (!isValidDay(day)) throw new InputError('Ungültiges Datum.');
    if (!m[3] && day < now.day) day = mk(y + 1);
  }
  if (day < now.day || (day === now.day && toMin(time) <= now.minutes)) {
    throw new InputError('Der Termin liegt in der Vergangenheit.');
  }
  return { title, day, time };
}
