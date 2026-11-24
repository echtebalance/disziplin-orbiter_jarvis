// Liest den Instagram-Datenexport ("Deine Informationen herunterladen", Format JSON).
// Relevante Dateien: following.json und followers_1.json, followers_2.json, ...
// Die Struktur hat sich in den letzten Jahren mehrmals geändert; der Parser akzeptiert
// alle bekannten Varianten (übernommen aus jarvis-satellite/ig-cleanup.js).
import { unzipSync } from 'fflate';

export type ListKind = 'follower' | 'following';

export interface ExportEntry {
  username: string;
  followedAt: Date | null;
}

export class ExportError extends Error {}

const MAX_JSON_BYTES = 30 * 1024 * 1024; // Schutz vor übergroßen bzw. präparierten Dateien

export function kindOfFile(filename: string): ListKind | null {
  const base = filename.split(/[\\/]/).pop() ?? '';
  if (base === 'following.json') return 'following';
  if (/^followers_\d+\.json$/.test(base)) return 'follower';
  return null;
}

const clean = (s: unknown) => String(s ?? '').toLowerCase().trim().replace(/^@/, '');
const fromHref = (h: unknown) =>
  clean(String(h ?? '').split('?')[0]!.replace(/\/$/, '').split('/').pop());

// Instagram-Benutzernamen: Buchstaben, Ziffern, Punkt, Unterstrich, max. 30 Zeichen
const VALID_USERNAME = /^[a-z0-9._]{1,30}$/;

/** Wandelt den Inhalt einer following.json / followers_N.json in Einträge um. */
export function parseListJson(text: string, kind: ListKind): ExportEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ExportError('Die Datei ist kein gültiges JSON. Hast du beim Export „JSON“ statt „HTML“ gewählt?');
  }
  const key = kind === 'following' ? 'relationships_following' : 'relationships_followers';
  const list: unknown = Array.isArray(data) ? data : (data as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) throw new ExportError('Unbekanntes Dateiformat, keine Liste gefunden.');

  const out: ExportEntry[] = [];
  for (const e of list as any[]) {
    const s = e?.string_list_data?.[0] ?? {};
    const username = clean(e?.title) || clean(s.value) || fromHref(s.href);
    if (!VALID_USERNAME.test(username)) continue;
    const ts = Number(s.timestamp);
    out.push({ username, followedAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null });
  }
  return out;
}

export interface ExportFile {
  name: string;
  kind: ListKind;
  text: string;
}

/** Holt die relevanten Dateien aus einer Export-ZIP. Alles andere wird gar nicht erst entpackt. */
export function extractFromZip(zip: Uint8Array): { files: ExportFile[]; hasHtml: boolean } {
  let hasHtml = false;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        const base = f.name.split('/').pop() ?? '';
        if (/^(following|followers_\d+)\.html$/.test(base)) hasHtml = true;
        return kindOfFile(f.name) !== null && f.originalSize <= MAX_JSON_BYTES;
      },
    });
  } catch {
    throw new ExportError('Die ZIP-Datei lässt sich nicht öffnen. Ist sie vollständig heruntergeladen?');
  }
  const files = Object.entries(entries).map(([name, bytes]) => ({
    name,
    kind: kindOfFile(name)!,
    text: new TextDecoder().decode(bytes),
  }));
  return { files, hasHtml };
}

/** Fasst mehrere Dateien zu einer Follower- und einer Following-Liste zusammen (ohne Doppelte). */
export function mergeLists(parts: { kind: ListKind; entries: ExportEntry[] }[]) {
  const maps = { follower: new Map<string, ExportEntry>(), following: new Map<string, ExportEntry>() };
  for (const p of parts) for (const e of p.entries) if (!maps[p.kind].has(e.username)) maps[p.kind].set(e.username, e);
  return { followers: [...maps.follower.values()], following: [...maps.following.values()] };
}
