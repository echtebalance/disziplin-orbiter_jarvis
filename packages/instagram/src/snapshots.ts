// Follower-/Following-Snapshots aus dem Instagram-Export, Vergleich zwischen zwei Exporten
// und die Entfolgen-Liste. Mandantenfähige Fassung von jarvis-satellite/ig-cleanup.js.
import type { Queryable } from '@echte-balance/db';
import { ExportError, type ExportEntry, type ListKind } from './export-parser.ts';

export const KEEP_SNAPSHOTS = 10; // ältere Exporte werden gelöscht (Datensparsamkeit)

// ---------- Konto ----------

/** Das Instagram-Konto eines Kunden; wird beim ersten Upload angelegt. */
export async function getOrCreateAccount(db: Queryable, customerId: number): Promise<number> {
  const found = await db.query('SELECT id FROM instagram.accounts WHERE customer_id = $1 ORDER BY id LIMIT 1', [
    customerId,
  ]);
  if (found.rows[0]) return Number(found.rows[0].id);
  const created = await db.query('INSERT INTO instagram.accounts (customer_id) VALUES ($1) RETURNING id', [customerId]);
  return Number(created.rows[0].id);
}

// ---------- Einzeln hochgeladene Dateien ----------

export async function savePending(
  db: Queryable,
  accountId: number,
  filename: string,
  kind: ListKind,
  entries: ExportEntry[],
): Promise<void> {
  await db.query(
    `INSERT INTO instagram.pending_uploads (account_id, filename, kind, entries) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, filename) DO UPDATE SET kind = EXCLUDED.kind, entries = EXCLUDED.entries, uploaded_at = now()`,
    [accountId, filename, kind, JSON.stringify(entries)],
  );
}

export async function listPending(db: Queryable, accountId: number) {
  const { rows } = await db.query(
    `SELECT filename, kind, jsonb_array_length(entries) AS count FROM instagram.pending_uploads
     WHERE account_id = $1 ORDER BY filename`,
    [accountId],
  );
  return rows as { filename: string; kind: ListKind; count: number }[];
}

/** Liest alle wartenden Dateien und entfernt sie. Innerhalb einer Transaktion aufrufen. */
export async function takePending(db: Queryable, accountId: number) {
  const { rows } = await db.query(
    'DELETE FROM instagram.pending_uploads WHERE account_id = $1 RETURNING kind, entries',
    [accountId],
  );
  return rows.map((r) => ({
    kind: r.kind as ListKind,
    entries: (r.entries as { username: string; followedAt: string | null }[]).map((e) => ({
      username: e.username,
      followedAt: e.followedAt ? new Date(e.followedAt) : null,
    })),
  }));
}

// ---------- Import ----------

export interface ImportResult {
  followers: number;
  following: number;
  hasPrevious: boolean;
  newFollowers: number;
  lostFollowers: number;
  /** Als entfolgt abgehakt, steht aber noch in der Following-Liste (Export älter als das Abhaken?). */
  stillFollowingMarked: number;
}

async function insertEntries(db: Queryable, snapshotId: number, kind: ListKind, entries: ExportEntry[]) {
  if (!entries.length) return;
  await db.query(
    `INSERT INTO instagram.snapshot_entries (snapshot_id, kind, username, followed_at)
     SELECT $1, $2, u, t FROM unnest($3::text[], $4::timestamptz[]) AS x(u, t)
     ON CONFLICT DO NOTHING`,
    [snapshotId, kind, entries.map((e) => e.username), entries.map((e) => e.followedAt)],
  );
}

/** Speichert einen neuen Snapshot. Innerhalb einer Transaktion aufrufen. */
export async function importSnapshot(
  db: Queryable,
  accountId: number,
  followers: ExportEntry[],
  following: ExportEntry[],
): Promise<ImportResult> {
  if (!followers.length) throw new ExportError('Es fehlt die Follower-Liste (followers_1.json).');
  if (!following.length) throw new ExportError('Es fehlt die Following-Liste (following.json).');

  const snap = await db.query(
    `INSERT INTO instagram.snapshots (account_id, follower_count, following_count) VALUES ($1, $2, $3) RETURNING id`,
    [accountId, followers.length, following.length],
  );
  const snapshotId = Number(snap.rows[0].id);
  await insertEntries(db, snapshotId, 'follower', followers);
  await insertEntries(db, snapshotId, 'following', following);
  // Statistik sofort aktualisieren: Sonst schätzt PostgreSQL den frischen Snapshot auf 1 Zeile
  // und vergleicht 10.000 × 6.000 Namen einzeln (gemessen: 7-14 s statt Millisekunden).
  await db.query('ANALYZE instagram.snapshot_entries');

  // Alte Snapshots über KEEP_SNAPSHOTS hinaus löschen
  await db.query(
    `DELETE FROM instagram.snapshots WHERE account_id = $1 AND id NOT IN (
       SELECT id FROM instagram.snapshots WHERE account_id = $1 ORDER BY id DESC LIMIT $2)`,
    [accountId, KEEP_SNAPSHOTS],
  );

  const diff = await followerDiffCounts(db, accountId);
  const still = await db.query(
    `SELECT count(*)::int AS n FROM instagram.cleanup c
     JOIN instagram.snapshot_entries f ON f.snapshot_id = $2 AND f.kind = 'following' AND f.username = c.username
     WHERE c.account_id = $1 AND c.status = 'unfollowed'`,
    [accountId, snapshotId],
  );
  return {
    followers: followers.length,
    following: following.length,
    hasPrevious: diff !== null,
    newFollowers: diff?.newFollowers ?? 0,
    lostFollowers: diff?.lostFollowers ?? 0,
    stillFollowingMarked: still.rows[0].n,
  };
}

// ---------- Snapshots lesen ----------

export interface SnapshotInfo {
  id: number;
  importedAt: Date;
}

/** Die zwei neuesten Snapshots: [aktuell, vorher]. */
export async function latestSnapshots(db: Queryable, accountId: number): Promise<SnapshotInfo[]> {
  const { rows } = await db.query(
    'SELECT id, imported_at FROM instagram.snapshots WHERE account_id = $1 ORDER BY id DESC LIMIT 2',
    [accountId],
  );
  return rows.map((r) => ({ id: Number(r.id), importedAt: r.imported_at }));
}

const followersOf = (param: string) =>
  `SELECT username FROM instagram.snapshot_entries WHERE snapshot_id = ${param} AND kind = 'follower'`;

async function followerDiffCounts(db: Queryable, accountId: number) {
  const [cur, prev] = await latestSnapshots(db, accountId);
  if (!cur || !prev) return null;
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM (${followersOf('$1')} EXCEPT ${followersOf('$2')}) a) AS new_followers,
       (SELECT count(*)::int FROM (${followersOf('$2')} EXCEPT ${followersOf('$1')}) b) AS lost_followers`,
    [cur.id, prev.id],
  );
  return { newFollowers: rows[0].new_followers as number, lostFollowers: rows[0].lost_followers as number };
}

/** Wer seit dem vorletzten Export entfolgt hat ('lost') bzw. neu folgt ('new'). null = nur ein Export. */
export async function followerChanges(db: Queryable, accountId: number, which: 'lost' | 'new') {
  const [cur, prev] = await latestSnapshots(db, accountId);
  if (!cur || !prev) return null;
  const [a, b] = which === 'lost' ? [prev.id, cur.id] : [cur.id, prev.id];
  const { rows } = await db.query(`${followersOf('$1')} EXCEPT ${followersOf('$2')} ORDER BY username`, [a, b]);
  return { since: prev.importedAt, until: cur.importedAt, usernames: rows.map((r) => r.username as string) };
}

// ---------- Nicht-Follower und Entfolgen-Liste ----------

export interface NonFollower {
  username: string;
  followedAt: Date | null;
  /** Hat unter eigenen Beiträgen kommentiert (nur mit Meta-API-Freischaltung bekannt). */
  commented: boolean;
}

/** Du folgst ihnen, sie dir nicht, und du hast noch nicht entschieden (entfolgt/behalten). */
export async function openNonFollowers(db: Queryable, accountId: number): Promise<NonFollower[]> {
  const [cur] = await latestSnapshots(db, accountId);
  if (!cur) return [];
  const { rows } = await db.query(
    `SELECT f.username, f.followed_at,
       EXISTS (SELECT 1 FROM instagram.comments c WHERE c.account_id = $1 AND lower(c.username) = f.username) AS commented
     FROM instagram.snapshot_entries f
     WHERE f.snapshot_id = $2 AND f.kind = 'following'
       AND NOT EXISTS (SELECT 1 FROM instagram.snapshot_entries r
                       WHERE r.snapshot_id = $2 AND r.kind = 'follower' AND r.username = f.username)
       AND NOT EXISTS (SELECT 1 FROM instagram.cleanup x WHERE x.account_id = $1 AND x.username = f.username)
     ORDER BY f.followed_at ASC NULLS FIRST, f.username`,
    [accountId, cur.id],
  );
  return rows.map((r) => ({ username: r.username, followedAt: r.followed_at, commented: r.commented }));
}

/** Kandidaten zum Entfolgen: offene Nicht-Follower, die nie kommentiert haben. */
export async function unfollowCandidates(db: Queryable, accountId: number): Promise<NonFollower[]> {
  return (await openNonFollowers(db, accountId)).filter((n) => !n.commented);
}

export async function markCleanup(
  db: Queryable,
  accountId: number,
  username: string,
  status: 'unfollowed' | 'keep',
): Promise<void> {
  await db.query(
    `INSERT INTO instagram.cleanup (account_id, username, status) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, username) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [accountId, username, status],
  );
}

/** Ohne Namen: hebt den zuletzt geschützten Account auf. Liefert den Namen oder null. */
export async function undoCleanup(db: Queryable, accountId: number, username?: string): Promise<string | null> {
  const { rows } = username
    ? await db.query('DELETE FROM instagram.cleanup WHERE account_id = $1 AND username = $2 RETURNING username', [
        accountId,
        username.toLowerCase().replace(/^@/, ''),
      ])
    : await db.query(
        `DELETE FROM instagram.cleanup WHERE account_id = $1 AND username = (
           SELECT username FROM instagram.cleanup WHERE account_id = $1 AND status = 'keep'
           ORDER BY updated_at DESC LIMIT 1) RETURNING username`,
        [accountId],
      );
  return rows[0]?.username ?? null;
}

/** Heute als entfolgt abgehakt, "heute" in der Zeitzone des Kunden. */
export async function unfollowedToday(db: Queryable, accountId: number, timezone: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM instagram.cleanup
     WHERE account_id = $1 AND status = 'unfollowed'
       AND updated_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [accountId, timezone],
  );
  return rows[0].n;
}

export interface CleanupStats {
  following: number;
  followers: number;
  nonFollowers: number;
  open: number;
  candidates: number;
  unfollowed: number;
  kept: number;
  importedAt: Date | null;
}

export async function cleanupStats(db: Queryable, accountId: number): Promise<CleanupStats> {
  const [cur] = await latestSnapshots(db, accountId);
  const counts = await db.query(
    `SELECT
       count(*) FILTER (WHERE status = 'unfollowed')::int AS unfollowed,
       count(*) FILTER (WHERE status = 'keep')::int AS kept
     FROM instagram.cleanup WHERE account_id = $1`,
    [accountId],
  );
  if (!cur) {
    return { following: 0, followers: 0, nonFollowers: 0, open: 0, candidates: 0, importedAt: null, ...counts.rows[0] };
  }
  const snap = await db.query(
    `SELECT follower_count, following_count,
       (SELECT count(*)::int FROM instagram.snapshot_entries f
        WHERE f.snapshot_id = $1 AND f.kind = 'following' AND NOT EXISTS (
          SELECT 1 FROM instagram.snapshot_entries r WHERE r.snapshot_id = $1 AND r.kind = 'follower' AND r.username = f.username)
       ) AS non_followers
     FROM instagram.snapshots WHERE id = $1`,
    [cur.id],
  );
  const open = await openNonFollowers(db, accountId);
  return {
    following: snap.rows[0].following_count,
    followers: snap.rows[0].follower_count,
    nonFollowers: snap.rows[0].non_followers,
    open: open.length,
    candidates: open.filter((n) => !n.commented).length,
    importedAt: cur.importedAt,
    ...counts.rows[0],
  };
}
