// Kunden, Einladungen und Freischaltungen. Unabhängig vom Kanal (Telegram-Bot, später Web).
// Alle Funktionen bekommen die Datenbankverbindung übergeben, damit Aufrufer Transaktionen
// steuern können (und Tests alles zurückrollen können).
import { randomInt } from 'node:crypto';
import type { Queryable } from '@echte-balance/db';

export const MODULES = ['instagram_api', 'training_plans', 'ai_replies'] as const;
export type Module = (typeof MODULES)[number];

export interface Customer {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  display_name: string | null;
  timezone: string;
}

export interface TelegramIdentity {
  id: number;
  username?: string;
  name?: string;
}

const CUSTOMER_COLS = 'id, telegram_user_id, telegram_username, display_name, timezone';

// pg liefert bigint als String; unsere IDs bleiben weit unter 2^53.
function toCustomer(row: any): Customer {
  return { ...row, id: Number(row.id), telegram_user_id: Number(row.telegram_user_id) };
}

// ---------- Kunden ----------

/** Liefert den Kunden zur Telegram-ID und aktualisiert Name/Username. null = nicht registriert. */
export async function touchCustomer(db: Queryable, tg: TelegramIdentity): Promise<Customer | null> {
  const { rows } = await db.query(
    `UPDATE core.customers SET telegram_username = $2, display_name = $3
     WHERE telegram_user_id = $1 AND deleted_at IS NULL
     RETURNING ${CUSTOMER_COLS}`,
    [tg.id, tg.username ?? null, tg.name ?? null],
  );
  return rows[0] ? toCustomer(rows[0]) : null;
}

/** Legt den Kunden an oder liefert den bestehenden (nur für den Admin, ohne Einladung). */
export async function ensureCustomer(db: Queryable, tg: TelegramIdentity): Promise<Customer> {
  const { rows } = await db.query(
    `INSERT INTO core.customers (telegram_user_id, telegram_username, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_user_id) DO UPDATE
       SET telegram_username = EXCLUDED.telegram_username, display_name = EXCLUDED.display_name
     RETURNING ${CUSTOMER_COLS}`,
    [tg.id, tg.username ?? null, tg.name ?? null],
  );
  return toCustomer(rows[0]);
}

/** Sucht per "@username", Kunden-Nummer oder Telegram-ID. */
export async function findCustomer(db: Queryable, ref: string): Promise<Customer | null> {
  const r = ref.trim();
  const byName = r.startsWith('@');
  if (!byName && !/^\d+$/.test(r)) return null;
  const { rows } = await db.query(
    byName
      ? `SELECT ${CUSTOMER_COLS} FROM core.customers WHERE lower(telegram_username) = lower($1) AND deleted_at IS NULL`
      : `SELECT ${CUSTOMER_COLS} FROM core.customers WHERE (id = $1::bigint OR telegram_user_id = $1::bigint) AND deleted_at IS NULL
         ORDER BY (id = $1::bigint) DESC`,
    [byName ? r.slice(1) : r],
  );
  return rows[0] ? toCustomer(rows[0]) : null;
}

export interface CustomerOverview extends Customer {
  created_at: Date;
  modules: string[];
}

export async function listCustomers(db: Queryable): Promise<CustomerOverview[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.telegram_user_id, c.telegram_username, c.display_name, c.timezone, c.created_at,
       COALESCE(array_agg(DISTINCT e.module) FILTER (WHERE e.id IS NOT NULL), '{}') AS modules
     FROM core.customers c
     LEFT JOIN core.entitlements e ON e.customer_id = c.id AND ${ACTIVE}
     WHERE c.deleted_at IS NULL
     GROUP BY c.id ORDER BY c.id`,
  );
  return rows.map((r) => ({ ...toCustomer(r), created_at: r.created_at, modules: r.modules }));
}

/** DSGVO: löscht den Kunden samt aller Moduldaten (ON DELETE CASCADE). */
export async function deleteCustomer(db: Queryable, customerId: number): Promise<void> {
  await audit(db, null, 'customer', 'account_deleted', { customer_id: customerId });
  await db.query('DELETE FROM core.customers WHERE id = $1', [customerId]);
}

// ---------- Einladungen ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O und 1/I

export function generateInviteCode(length = 10): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export interface Invite {
  code: string;
  note: string | null;
  modules: Module[];
  valid_days: number | null;
  expires_at: Date;
}

export async function createInvite(
  db: Queryable,
  opts: { note?: string; modules?: Module[]; validDays?: number | null; expiresInDays?: number } = {},
): Promise<Invite> {
  const { rows } = await db.query(
    `INSERT INTO core.invites (code, note, modules, valid_days, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
     RETURNING code, note, modules, valid_days, expires_at`,
    [generateInviteCode(), opts.note ?? null, opts.modules ?? [], opts.validDays ?? null, opts.expiresInDays ?? 14],
  );
  return rows[0];
}

export async function listOpenInvites(db: Queryable): Promise<Invite[]> {
  const { rows } = await db.query(
    `SELECT code, note, modules, valid_days, expires_at FROM core.invites
     WHERE redeemed_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
  );
  return rows;
}

export type RedeemResult =
  | { ok: true; customer: Customer }
  | { ok: false; reason: 'invalid' | 'used' | 'expired' | 'already_registered' };

/**
 * Löst einen Einladungscode ein. Muss innerhalb einer Transaktion laufen
 * (FOR UPDATE verhindert, dass zwei Leute denselben Code gleichzeitig einlösen).
 */
export async function redeemInvite(db: Queryable, code: string, tg: TelegramIdentity): Promise<RedeemResult> {
  const { rows } = await db.query(
    `SELECT code, modules, valid_days, expires_at, redeemed_at FROM core.invites WHERE code = $1 FOR UPDATE`,
    [code.trim().toUpperCase()],
  );
  const invite = rows[0];
  if (!invite) return { ok: false, reason: 'invalid' };
  // redeemed_at, nicht redeemed_by: Nach dem Löschen eines Kunden ist redeemed_by NULL,
  // der Code darf trotzdem nicht erneut nutzbar werden.
  if (invite.redeemed_at) return { ok: false, reason: 'used' };
  if (new Date(invite.expires_at) < new Date()) return { ok: false, reason: 'expired' };

  const existing = await db.query('SELECT 1 FROM core.customers WHERE telegram_user_id = $1', [tg.id]);
  if (existing.rowCount) return { ok: false, reason: 'already_registered' };

  const customer = toCustomer(
    (
      await db.query(
        `INSERT INTO core.customers (telegram_user_id, telegram_username, display_name)
         VALUES ($1, $2, $3) RETURNING ${CUSTOMER_COLS}`,
        [tg.id, tg.username ?? null, tg.name ?? null],
      )
    ).rows[0],
  );
  await db.query('UPDATE core.invites SET redeemed_by = $1, redeemed_at = now() WHERE code = $2', [
    customer.id,
    invite.code,
  ]);
  for (const module of invite.modules as Module[]) {
    await grantModule(db, customer.id, module, invite.valid_days, 'pilot');
  }
  await audit(db, customer.id, 'customer', 'invite_redeemed', { code: invite.code });
  return { ok: true, customer };
}

// ---------- Freischaltungen ----------

const ACTIVE = `e.revoked_at IS NULL AND e.valid_from <= now() AND (e.valid_until IS NULL OR e.valid_until > now())`;

export function isModule(value: string): value is Module {
  return (MODULES as readonly string[]).includes(value);
}

/** days = null bedeutet unbefristet. */
export async function grantModule(
  db: Queryable,
  customerId: number,
  module: Module,
  days: number | null,
  source: 'pilot' | 'manual' | 'stripe' = 'manual',
): Promise<Date | null> {
  const { rows } = await db.query(
    `INSERT INTO core.entitlements (customer_id, module, valid_until, source)
     VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END, $4)
     RETURNING valid_until`,
    [customerId, module, days, source],
  );
  await audit(db, customerId, source === 'manual' ? 'admin' : 'system', 'module_granted', { module, days });
  return rows[0].valid_until;
}

/** Beendet alle aktiven Freischaltungen dieses Moduls. Liefert die Anzahl. */
export async function revokeModule(db: Queryable, customerId: number, module: Module): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE core.entitlements e SET revoked_at = now()
     WHERE e.customer_id = $1 AND e.module = $2 AND ${ACTIVE}`,
    [customerId, module],
  );
  await audit(db, customerId, 'admin', 'module_revoked', { module });
  return rowCount ?? 0;
}

export async function activeModules(db: Queryable, customerId: number): Promise<Module[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT e.module FROM core.entitlements e WHERE e.customer_id = $1 AND ${ACTIVE}`,
    [customerId],
  );
  return rows.map((r) => r.module);
}

export async function hasModule(db: Queryable, customerId: number, module: Module): Promise<boolean> {
  return (await activeModules(db, customerId)).includes(module);
}

// ---------- Protokoll ----------

export async function audit(
  db: Queryable,
  customerId: number | null,
  actor: string,
  action: string,
  detail?: unknown,
): Promise<void> {
  await db.query('INSERT INTO core.audit_log (customer_id, actor, action, detail) VALUES ($1, $2, $3, $4)', [
    customerId,
    actor,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  ]);
}

// ---------- Zugangsanfragen (ohne Einladung) ----------

export type AccessRequestResult = 'created' | 'updated' | 'too_soon' | 'declined';

/**
 * Speichert eine Zugangsanfrage. Höchstens eine neue Anfrage pro Person und Tag;
 * eine Nachricht kann innerhalb des Tages nachgereicht werden. Abgelehnte bleiben 30 Tage gesperrt.
 */
export async function requestAccess(
  db: Queryable,
  tg: TelegramIdentity,
  message: string | null,
): Promise<AccessRequestResult> {
  const { rows } = await db.query(
    `SELECT status, created_at, decided_at, message FROM core.access_requests WHERE telegram_user_id = $1`,
    [tg.id],
  );
  const r = rows[0];
  const ageH = r ? (Date.now() - new Date(r.created_at).getTime()) / 3_600_000 : Infinity;
  if (r?.status === 'declined' && r.decided_at && Date.now() - new Date(r.decided_at).getTime() < 30 * 86_400_000) return 'declined';
  if (r?.status === 'open' && ageH < 24) {
    if (message && !r.message) {
      await db.query('UPDATE core.access_requests SET message = $2 WHERE telegram_user_id = $1', [tg.id, message]);
      return 'updated';
    }
    return 'too_soon';
  }
  await db.query(
    `INSERT INTO core.access_requests (telegram_user_id, username, name, message) VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_user_id) DO UPDATE SET username = EXCLUDED.username, name = EXCLUDED.name,
       message = EXCLUDED.message, status = 'open', created_at = now(), decided_at = NULL`,
    [tg.id, tg.username ?? null, tg.name ?? null, message],
  );
  return 'created';
}

export async function getAccessRequest(db: Queryable, telegramUserId: number) {
  const { rows } = await db.query('SELECT * FROM core.access_requests WHERE telegram_user_id = $1', [telegramUserId]);
  return (rows[0] ?? null) as { telegram_user_id: string; username: string | null; name: string | null; message: string | null; status: string } | null;
}

/** Entscheidung festhalten; liefert false, wenn die Anfrage schon entschieden war. */
export async function decideAccess(db: Queryable, telegramUserId: number, approve: boolean): Promise<boolean> {
  const r = await db.query(
    `UPDATE core.access_requests SET status = $2, decided_at = now() WHERE telegram_user_id = $1 AND status = 'open'`,
    [telegramUserId, approve ? 'approved' : 'declined'],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---------- Freischaltungs-Anfragen (registrierte Nutzer, je Modul) ----------

export type UnlockRequestResult = 'created' | 'too_soon' | 'already' | 'declined';

/** Höchstens eine Anfrage pro Modul und Tag; nach Ablehnung 7 Tage Pause. */
export async function requestUnlock(db: Queryable, customerId: number, module: Module): Promise<UnlockRequestResult> {
  if (await hasModule(db, customerId, module)) return 'already';
  const { rows } = await db.query('SELECT status, created_at, decided_at FROM core.unlock_requests WHERE customer_id = $1 AND module = $2', [
    customerId,
    module,
  ]);
  const r = rows[0];
  if (r?.status === 'declined' && r.decided_at && Date.now() - new Date(r.decided_at).getTime() < 7 * 86_400_000) return 'declined';
  if (r?.status === 'open' && Date.now() - new Date(r.created_at).getTime() < 86_400_000) return 'too_soon';
  await db.query(
    `INSERT INTO core.unlock_requests (customer_id, module) VALUES ($1, $2)
     ON CONFLICT (customer_id, module) DO UPDATE SET status = 'open', created_at = now(), decided_at = NULL`,
    [customerId, module],
  );
  return 'created';
}

/** Entscheidung festhalten; false = war schon entschieden. Bei Zusage wird unbefristet freigeschaltet. */
export async function decideUnlock(db: Queryable, customerId: number, module: Module, approve: boolean): Promise<boolean> {
  const r = await db.query(
    `UPDATE core.unlock_requests SET status = $3, decided_at = now() WHERE customer_id = $1 AND module = $2 AND status = 'open'`,
    [customerId, module, approve ? 'approved' : 'declined'],
  );
  if (!(r.rowCount ?? 0)) return false;
  if (approve && !(await hasModule(db, customerId, module))) await grantModule(db, customerId, module, null);
  return true;
}

// ---------- Nachrichten über /anfrage ----------

export async function saveMessage(db: Queryable, customerId: number, text: string): Promise<number> {
  const { rows } = await db.query('INSERT INTO core.messages (customer_id, text) VALUES ($1, $2) RETURNING id', [customerId, text]);
  return Number(rows[0].id);
}

/** Als erledigt markieren; false = war schon erledigt oder gibt es nicht. */
export async function markMessageDone(db: Queryable, id: number): Promise<boolean> {
  const r = await db.query(`UPDATE core.messages SET status = 'done', done_at = now() WHERE id = $1 AND status = 'open'`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export interface OpenRequests {
  access: { telegramUserId: number; username: string | null; name: string | null; message: string | null; createdAt: Date }[];
  unlock: { customerId: number; module: Module; who: string; createdAt: Date }[];
  messages: { id: number; customerId: number; who: string; username: string | null; text: string; createdAt: Date }[];
}

/** Alle offenen Anfragen für /anfragen, älteste zuerst */
export async function openRequests(db: Queryable): Promise<OpenRequests> {
  const who = `COALESCE(c.display_name, '@' || c.telegram_username, '#' || c.id)`;
  const [a, u, m] = await Promise.all([
    db.query(`SELECT telegram_user_id, username, name, message, created_at FROM core.access_requests WHERE status = 'open' ORDER BY created_at`),
    db.query(
      `SELECT r.customer_id, r.module, ${who} AS who, r.created_at FROM core.unlock_requests r
       JOIN core.customers c ON c.id = r.customer_id AND c.deleted_at IS NULL WHERE r.status = 'open' ORDER BY r.created_at`,
    ),
    db.query(
      `SELECT m.id, m.customer_id, ${who} AS who, c.telegram_username, m.text, m.created_at FROM core.messages m
       JOIN core.customers c ON c.id = m.customer_id AND c.deleted_at IS NULL WHERE m.status = 'open' ORDER BY m.created_at`,
    ),
  ]);
  return {
    access: a.rows.map((r) => ({ telegramUserId: Number(r.telegram_user_id), username: r.username, name: r.name, message: r.message, createdAt: r.created_at })),
    unlock: u.rows.map((r) => ({ customerId: Number(r.customer_id), module: r.module, who: r.who, createdAt: r.created_at })),
    messages: m.rows.map((r) => ({ id: Number(r.id), customerId: Number(r.customer_id), who: r.who, username: r.telegram_username, text: r.text, createdAt: r.created_at })),
  };
}

export async function getCustomerById(db: Queryable, id: number): Promise<Customer | null> {
  const { rows } = await db.query(`SELECT ${CUSTOMER_COLS} FROM core.customers WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ? toCustomer(rows[0]) : null;
}
