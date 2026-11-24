// Verbindung zur Meta-API pro Kunde, sparsamer Abgleich der Kommentare und die Auswertungen
// für /status (wer kommentiert bei mir) und unbeantwortete Kommentare.
import type { Queryable } from '@echte-balance/db';
import { decryptSecret, encryptSecret } from '@echte-balance/core/crypto';
import { isEmojiOnly, type IgComment, type IgMe, type MetaClient, type TokenKind } from './meta-api.ts';

export const SYNC_POSTS = 25; // so viele neueste Beiträge werden abgeglichen
export const SNOOZE_DAYS = 3;

export interface ApiAccount {
  id: number;
  igUserId: string;
  username: string;
  status: string;
  tokenKind: TokenKind;
  tokenExpiresAt: Date | null;
  tokenUpdatedAt: Date | null;
  lastSyncAt: Date | null;
}

// ---------- Verbindung ----------

/** Speichert den Token verschlüsselt am (Export-)Konto des Kunden. expiresAt null = läuft nicht ab. */
export async function connectAccount(
  db: Queryable,
  accountId: number,
  me: IgMe,
  token: string,
  key: Buffer,
  kind: TokenKind,
  expiresAt: Date | null,
) {
  await db.query(
    `UPDATE instagram.accounts SET ig_user_id = $2, username = $3, token_ciphertext = $4, token_kind = $5,
       token_expires_at = $6, token_updated_at = now(), status = 'active'
     WHERE id = $1`,
    [accountId, me.userId, me.username, encryptSecret(token, key), kind, expiresAt],
  );
}

/** Entfernt Token und alle über die API geladenen Daten (Beiträge, Kommentare, Snooze). */
export async function disconnectAccount(db: Queryable, accountId: number) {
  await db.query('DELETE FROM instagram.posts WHERE account_id = $1', [accountId]); // Kommentare per CASCADE
  await db.query('DELETE FROM instagram.commenter_snooze WHERE account_id = $1', [accountId]);
  await db.query(
    `UPDATE instagram.accounts SET token_ciphertext = NULL, token_expires_at = NULL, token_updated_at = NULL,
       status = 'export_only', last_sync_at = NULL WHERE id = $1`,
    [accountId],
  );
}

export async function getApiAccount(db: Queryable, accountId: number): Promise<ApiAccount | null> {
  const { rows } = await db.query(
    `SELECT id, ig_user_id, username, status, token_kind, token_expires_at, token_updated_at, last_sync_at
     FROM instagram.accounts WHERE id = $1 AND token_ciphertext IS NOT NULL`,
    [accountId],
  );
  const r = rows[0];
  return r
    ? { id: Number(r.id), igUserId: r.ig_user_id, username: r.username, status: r.status, tokenKind: r.token_kind, tokenExpiresAt: r.token_expires_at,
        tokenUpdatedAt: r.token_updated_at, lastSyncAt: r.last_sync_at }
    : null;
}

export async function readToken(db: Queryable, accountId: number, key: Buffer): Promise<string | null> {
  const { rows } = await db.query('SELECT token_ciphertext FROM instagram.accounts WHERE id = $1', [accountId]);
  return rows[0]?.token_ciphertext ? decryptSecret(rows[0].token_ciphertext, key) : null;
}

export async function markTokenInvalid(db: Queryable, accountId: number) {
  await db.query(`UPDATE instagram.accounts SET status = 'token_invalid' WHERE id = $1`, [accountId]);
}

/** Konten mit gespeichertem Token - für Erinnerungen und Token-Erneuerung */
export async function apiAccounts(db: Queryable) {
  const { rows } = await db.query(
    `SELECT a.id AS account_id, c.id AS customer_id, c.telegram_user_id, c.timezone
     FROM instagram.accounts a JOIN core.customers c ON c.id = a.customer_id
     WHERE a.token_ciphertext IS NOT NULL AND c.deleted_at IS NULL`,
  );
  return rows.map((r) => ({
    accountId: Number(r.account_id), customerId: Number(r.customer_id),
    telegramUserId: Number(r.telegram_user_id), timezone: r.timezone as string,
  }));
}

// ---------- Abgleich ----------

export interface SyncResult {
  postsChecked: number;
  postsLoaded: number;
  newComments: number;
}

/**
 * Holt die neuesten Beiträge (1 Aufruf) und lädt Kommentare nur bei Beiträgen, deren
 * Kommentarzahl sich geändert hat. Antworten zählen in comments_count mit - antwortet der
 * Kontoinhaber, wird der Beitrag also neu geladen und der Kommentar als beantwortet erkannt.
 */
export async function syncComments(db: Queryable, acc: ApiAccount, client: MetaClient, force = false): Promise<SyncResult> {
  const media = await client.media(acc.igUserId, SYNC_POSTS);
  const known = new Map<string, number | null>(
    (await db.query('SELECT media_id, comments_count FROM instagram.posts WHERE account_id = $1', [acc.id])).rows.map((r) => [
      r.media_id,
      r.comments_count,
    ]),
  );
  const own = acc.username.toLowerCase();
  let loaded = 0, fresh = 0;
  for (const m of media) {
    const changed = force || known.get(m.id) !== m.commentsCount;
    await db.query(
      `INSERT INTO instagram.posts (account_id, media_id, posted_at, caption, permalink, comments_count, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END)
       ON CONFLICT (account_id, media_id) DO UPDATE SET posted_at = EXCLUDED.posted_at,
         caption = COALESCE(EXCLUDED.caption, instagram.posts.caption), permalink = EXCLUDED.permalink,
         comments_count = EXCLUDED.comments_count, synced_at = COALESCE(EXCLUDED.synced_at, instagram.posts.synced_at)`,
      [acc.id, m.id, m.timestamp, m.caption, m.permalink, m.commentsCount, changed],
    );
    if (!changed || m.commentsCount === 0) continue;
    loaded++;
    for (const c of await client.comments(m.id)) {
      if (!c.username || c.username === own || c.fromId === acc.igUserId) continue; // eigene Kommentare
      for (const item of threadStatus(c, own, acc.igUserId)) {
        const r = await db.query(
          `INSERT INTO instagram.comments
             (account_id, comment_id, media_id, parent_id, username, text, commented_at, emoji_only, answered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)
           ON CONFLICT (account_id, comment_id) DO UPDATE SET text = EXCLUDED.text, parent_id = EXCLUDED.parent_id,
             answered_at = COALESCE(instagram.comments.answered_at, EXCLUDED.answered_at)
           RETURNING (xmax = 0) AS inserted`,
          [acc.id, item.id, m.id, item.parentId, item.username, item.text, item.timestamp, isEmojiOnly(item.text), item.done],
        );
        if (r.rows[0]?.inserted && !item.own) fresh++;
      }
    }
  }
  await db.query('UPDATE instagram.accounts SET last_sync_at = now() WHERE id = $1', [acc.id]);
  return { postsChecked: media.length, postsLoaded: loaded, newComments: fresh };
}

export interface ThreadItem {
  id: string;
  parentId: string | null;
  username: string;
  text: string | null;
  timestamp: string | null;
  own: boolean;
  /** true = nichts mehr zu tun (beantwortet, eigene Nachricht oder Diskussion ohne dich) */
  done: boolean;
}

/**
 * Wertet eine Diskussion aus (Kommentar + Antworten darunter):
 * - Der Kommentar ist offen, solange du nicht darunter geantwortet hast.
 * - Eine Antwort eines anderen ist offen, wenn danach nichts mehr von dir kam UND du an der
 *   Diskussion beteiligt bist (schon vorher geantwortet) oder mit @name erwähnt wirst.
 *   Unterhalten sich zwei andere nur untereinander, ist nichts zu tun.
 * Eigene Antworten werden mitgespeichert (Verlauf für die KI), zählen aber nie als offen.
 */
export function threadStatus(c: IgComment, own: string, ownId: string): ThreadItem[] {
  const isOwn = (u: string | null, id: string | null) => u === own || (!!id && id === ownId);
  const ts = (t: string | null) => (t ? Date.parse(t) : 0);
  const replies = c.replies
    .filter((r) => r.id && r.username)
    .map((r) => ({ ...r, own: isOwn(r.username, r.fromId) }))
    .sort((a, b) => ts(a.timestamp) - ts(b.timestamp));
  const ownTimes = replies.filter((r) => r.own).map((r) => ts(r.timestamp));
  const ownAfter = (t: number) => ownTimes.some((o) => o >= t);
  const ownBefore = (t: number) => ownTimes.some((o) => o < t);
  const mention = new RegExp(`(^|[^a-z0-9._])@${own.replace(/[.]/g, '\\.')}(?![a-z0-9._])`, 'i');

  const out: ThreadItem[] = [
    { id: c.id, parentId: null, username: c.username!, text: c.text, timestamp: c.timestamp, own: false, done: ownTimes.length > 0 },
  ];
  for (const r of replies) {
    const t = ts(r.timestamp);
    const concernsMe = ownBefore(t) || mention.test(r.text ?? '');
    out.push({
      id: r.id!, parentId: c.id, username: r.username!, text: r.text, timestamp: r.timestamp, own: r.own,
      done: r.own || !concernsMe || ownAfter(t),
    });
  }
  return out;
}

// ---------- /status: wer kommentiert bei mir ----------

export interface TopCommenter {
  username: string;
  count: number;
  lastAt: Date | null;
}

/** Häufigste Kommentierer der letzten N Beiträge, ohne ausgeblendete (Snooze). */
export async function topCommenters(db: Queryable, accountId: number, postLimit: number) {
  const { rows } = await db.query(
    `WITH recent AS (
       SELECT media_id FROM instagram.posts WHERE account_id = $1 ORDER BY posted_at DESC NULLS LAST LIMIT $2),
     counted AS (
       SELECT lower(c.username) AS username, count(*)::int AS n, max(c.commented_at) AS last_at
       FROM instagram.comments c JOIN recent r ON r.media_id = c.media_id
       WHERE c.account_id = $1 AND c.parent_id IS NULL
       GROUP BY lower(c.username))
     SELECT k.username, k.n, k.last_at,
       EXISTS (SELECT 1 FROM instagram.commenter_snooze s
               WHERE s.account_id = $1 AND s.username = k.username AND s.snoozed_until > now()) AS snoozed
     FROM counted k
     ORDER BY k.n DESC, k.last_at ASC`,
    [accountId, postLimit],
  );
  const all = rows as { username: string; n: number; last_at: Date | null; snoozed: boolean }[];
  return {
    active: all.filter((r) => !r.snoozed).map((r) => ({ username: r.username, count: r.n, lastAt: r.last_at })),
    snoozedCount: all.filter((r) => r.snoozed).length,
  };
}

/** ✅ in /status: zurückkommentiert → einige Tage ausblenden und merken, wann. */
export async function snooze(db: Queryable, accountId: number, username: string, days = SNOOZE_DAYS) {
  await db.query(
    `INSERT INTO instagram.commenter_snooze (account_id, username, snoozed_until, marked_at)
     VALUES ($1, $2, now() + make_interval(days => $3), now())
     ON CONFLICT (account_id, username) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until, marked_at = now()`,
    [accountId, username.toLowerCase(), days],
  );
}

/** Sofort wieder einblenden. Der Zeitpunkt des letzten Zurückkommentierens bleibt erhalten. */
export async function unsnooze(db: Queryable, accountId: number, username: string): Promise<boolean> {
  const r = await db.query(
    'UPDATE instagram.commenter_snooze SET snoozed_until = now() WHERE account_id = $1 AND username = $2 AND snoozed_until > now()',
    [accountId, username.toLowerCase().replace(/^@/, '')],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface NeglectRules {
  minComments: number; // so viele Kommentare …
  windowDays: number; // … in so vielen Tagen = aktiv
  afterDays: number; // so lange nicht zurückkommentiert = vergessen
}
export const NEGLECT_DEFAULTS: NeglectRules = { minComments: 3, windowDays: 30, afterDays: 14 };

/**
 * Aktive Kommentierer, bei denen du lange nicht (oder nie) zurückkommentiert hast.
 * Gerade ausgeblendete (frisch abgehakte) zählen nicht.
 */
export async function neglectedCommenters(db: Queryable, accountId: number, rules: NeglectRules = NEGLECT_DEFAULTS) {
  const { rows } = await db.query(
    `SELECT lower(c.username) AS username, count(*)::int AS n, max(c.commented_at) AS last_comment, s.marked_at
     FROM instagram.comments c
     LEFT JOIN instagram.commenter_snooze s ON s.account_id = c.account_id AND s.username = lower(c.username)
     WHERE c.account_id = $1 AND c.parent_id IS NULL AND c.commented_at >= now() - make_interval(days => $3)
       AND (s.snoozed_until IS NULL OR s.snoozed_until <= now())
       AND (s.marked_at IS NULL OR s.marked_at < now() - make_interval(days => $4))
     GROUP BY lower(c.username), s.marked_at
     HAVING count(*) >= $2
     ORDER BY count(*) DESC, s.marked_at ASC NULLS FIRST`,
    [accountId, rules.minComments, rules.windowDays, rules.afterDays],
  );
  return rows as { username: string; n: number; last_comment: Date; marked_at: Date | null }[];
}

export async function listSnoozed(db: Queryable, accountId: number) {
  const { rows } = await db.query(
    `SELECT username, snoozed_until FROM instagram.commenter_snooze WHERE account_id = $1 AND snoozed_until > now()
     ORDER BY snoozed_until`,
    [accountId],
  );
  return rows as { username: string; snoozed_until: Date }[];
}

// ---------- Unbeantwortete Kommentare ----------

export interface OpenComment {
  commentId: string;
  /** gesetzt = Antwort in einer Diskussion unter diesem Kommentar */
  parentId: string | null;
  mediaId: string;
  username: string;
  text: string;
  commentedAt: Date | null;
  firstSeenAt: Date;
  permalink: string | null;
  caption: string | null;
  imageText: string | null;
}

/** Kommentare und Diskussions-Antworten mit Text (keine reinen Emojis), die noch auf dich warten. */
export async function unansweredComments(db: Queryable, accountId: number, limit = 50): Promise<OpenComment[]> {
  const { rows } = await db.query(
    `SELECT c.comment_id, c.parent_id, c.media_id, c.username, c.text, c.commented_at, c.first_seen_at,
       p.permalink, p.caption, p.image_text
     FROM instagram.comments c JOIN instagram.posts p ON p.account_id = c.account_id AND p.media_id = c.media_id
     WHERE c.account_id = $1 AND c.answered_at IS NULL AND NOT c.emoji_only
     ORDER BY c.commented_at DESC NULLS LAST LIMIT $2`,
    [accountId, limit],
  );
  return rows.map((r) => ({
    commentId: r.comment_id, parentId: r.parent_id, mediaId: r.media_id, username: r.username, text: r.text ?? '',
    commentedAt: r.commented_at, firstSeenAt: r.first_seen_at, permalink: r.permalink, caption: r.caption,
    imageText: r.image_text,
  }));
}

/** Verlauf einer Diskussion bis einschließlich der gegebenen Nachricht (für die KI) */
export async function threadHistory(db: Queryable, accountId: number, c: OpenComment, own: string, max = 8) {
  if (!c.parentId) return [];
  const { rows } = await db.query(
    `SELECT username, text, commented_at FROM instagram.comments
     WHERE account_id = $1 AND (comment_id = $2 OR parent_id = $2) AND commented_at <= $3
     ORDER BY commented_at`,
    [accountId, c.parentId, c.commentedAt],
  );
  return rows
    .filter((r) => r.text)
    .slice(-max)
    .map((r) => ({ username: r.username as string, text: r.text as string, own: String(r.username).toLowerCase() === own }));
}

/** Text auf dem Bild (Spruch) zu einem Beitrag speichern; alte KI-Vorschläge dieses Beitrags verwerfen. */
export async function setImageText(db: Queryable, accountId: number, mediaId: string, text: string | null) {
  await db.query('UPDATE instagram.posts SET image_text = $3 WHERE account_id = $1 AND media_id = $2', [accountId, mediaId, text]);
  await db.query(
    `DELETE FROM instagram.reply_suggestions s USING instagram.comments c
     WHERE s.account_id = $1 AND c.account_id = s.account_id AND c.comment_id = s.comment_id AND c.media_id = $2`,
    [accountId, mediaId],
  );
}

/** Als erledigt markieren, z. B. wenn man nicht antworten will */
export async function dismissComment(db: Queryable, accountId: number, commentId: string) {
  await db.query('UPDATE instagram.comments SET answered_at = now() WHERE account_id = $1 AND comment_id = $2', [accountId, commentId]);
}

/** Erste Kommentare neuer Leute in den letzten Tagen, mit Follow-Status aus dem letzten Export */
export async function newCommenters(db: Queryable, accountId: number, days: number) {
  const { rows } = await db.query(
    `WITH snap AS (SELECT id FROM instagram.snapshots WHERE account_id = $1 ORDER BY id DESC LIMIT 1),
     firsts AS (
       SELECT lower(c.username) AS username, min(c.commented_at) AS first_at, count(*)::int AS n
       FROM instagram.comments c WHERE c.account_id = $1 AND c.parent_id IS NULL
       GROUP BY lower(c.username)
       HAVING min(c.commented_at) >= now() - make_interval(days => $2)
     )
     SELECT f.username, f.first_at, f.n,
       EXISTS (SELECT 1 FROM instagram.snapshot_entries e, snap WHERE e.snapshot_id = snap.id AND e.kind = 'follower' AND e.username = f.username) AS follows_me,
       EXISTS (SELECT 1 FROM instagram.snapshot_entries e, snap WHERE e.snapshot_id = snap.id AND e.kind = 'following' AND e.username = f.username) AS i_follow
     FROM firsts f
     ORDER BY f.first_at DESC LIMIT 40`,
    [accountId, days],
  );
  return rows as { username: string; first_at: Date; n: number; follows_me: boolean; i_follow: boolean }[];
}

// ---------- Protokoll der Meta-API-Anfragen (/apicalls) ----------

/** Liefert einen Hook für createMetaClient, der jede Anfrage protokolliert (ohne auf die DB zu warten). */
export function apiCallLogger(db: Queryable, accountId: number | null) {
  return (info: { endpoint: string; ok: boolean; error: string | null; usagePct: number | null }) => {
    db.query('INSERT INTO instagram.api_calls (account_id, endpoint, ok, error) VALUES ($1, $2, $3, $4)', [
      accountId, info.endpoint, info.ok, info.error,
    ]).catch(() => {});
    if (accountId && info.usagePct !== null) {
      db.query('UPDATE instagram.accounts SET api_usage_pct = $2, api_usage_at = now() WHERE id = $1', [accountId, Math.round(info.usagePct)]).catch(() => {});
    }
  };
}

export interface ApiCallStats {
  lastHour: number;
  last24h: number;
  last7d: number;
  failed24h: number;
  byEndpoint24h: { endpoint: string; n: number }[];
  lastError: { endpoint: string; error: string; at: Date } | null;
  usagePct: number | null;
  usageAt: Date | null;
}

/** Statistik für ein Konto, oder für alle Konten (accountId = null) */
export async function apiCallStats(db: Queryable, accountId: number | null): Promise<ApiCallStats> {
  const where = accountId === null ? 'TRUE' : 'account_id = $1';
  const params = accountId === null ? [] : [accountId];
  const counts = await db.query(
    `SELECT
       count(*) FILTER (WHERE called_at > now() - interval '1 hour')::int AS h1,
       count(*) FILTER (WHERE called_at > now() - interval '24 hours')::int AS h24,
       count(*)::int AS d7,
       count(*) FILTER (WHERE called_at > now() - interval '24 hours' AND NOT ok)::int AS f24
     FROM instagram.api_calls WHERE ${where} AND called_at > now() - interval '7 days'`,
    params,
  );
  const by = await db.query(
    `SELECT endpoint, count(*)::int AS n FROM instagram.api_calls
     WHERE ${where} AND called_at > now() - interval '24 hours' GROUP BY endpoint ORDER BY n DESC`,
    params,
  );
  const err = await db.query(
    `SELECT endpoint, error, called_at FROM instagram.api_calls WHERE ${where} AND NOT ok ORDER BY called_at DESC LIMIT 1`,
    params,
  );
  const usage = accountId === null
    ? await db.query('SELECT max(api_usage_pct) AS p, max(api_usage_at) AS at FROM instagram.accounts WHERE api_usage_at > now() - interval \'24 hours\'')
    : await db.query('SELECT api_usage_pct AS p, api_usage_at AS at FROM instagram.accounts WHERE id = $1', [accountId]);
  const c = counts.rows[0];
  return {
    lastHour: c.h1, last24h: c.h24, last7d: c.d7, failed24h: c.f24,
    byEndpoint24h: by.rows,
    lastError: err.rows[0] ? { endpoint: err.rows[0].endpoint, error: err.rows[0].error, at: err.rows[0].called_at } : null,
    usagePct: usage.rows[0]?.p ?? null,
    usageAt: usage.rows[0]?.at ?? null,
  };
}

/** Anfragen pro Konto in 24 h (für den Admin-Überblick) */
export async function apiCallsPerAccount(db: Queryable) {
  const { rows } = await db.query(
    `SELECT a.id, a.username, count(c.*)::int AS n, a.api_usage_pct AS pct
     FROM instagram.accounts a LEFT JOIN instagram.api_calls c ON c.account_id = a.id AND c.called_at > now() - interval '24 hours'
     WHERE a.token_ciphertext IS NOT NULL GROUP BY a.id ORDER BY n DESC`,
  );
  return rows as { id: number; username: string | null; n: number; pct: number | null }[];
}

/** Protokoll älter als 30 Tage löschen */
export async function pruneApiCalls(db: Queryable) {
  await db.query(`DELETE FROM instagram.api_calls WHERE called_at < now() - interval '30 days'`);
}
