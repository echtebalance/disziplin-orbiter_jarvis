// Instagram-Funktionen über die offizielle Meta-API - nur mit Freischaltung (Modul instagram_api).
// Jeder Nutzer verbindet seine eigene Meta-App per Token (/verbinden, Anleitung: /meta).
import { Composer, InlineKeyboard } from 'grammy';
import { getPool } from '@echte-balance/db';
import { hasModule } from '@echte-balance/core/customers';
import { getNotification, setNotification, type NotificationSetting } from '@echte-balance/core/notifications';
import { parseTime } from '@echte-balance/planner/time';
import { createMetaClient, MetaApiError, tokenKind } from '@echte-balance/instagram/meta-api';
import {
  apiCallLogger, apiCallStats, apiCallsPerAccount,
  connectAccount, disconnectAccount, dismissComment, getApiAccount, listSnoozed, markTokenInvalid, neglectedCommenters,
  newCommenters, readToken, snooze, syncComments, topCommenters, unansweredComments, unsnooze, NEGLECT_DEFAULTS, SNOOZE_DAYS,
  type ApiAccount, type NeglectRules, type OpenComment,
} from '@echte-balance/instagram/comments';
import { getOrCreateAccount, openNonFollowers } from '@echte-balance/instagram/snapshots';
import { profileUrl } from '@echte-balance/instagram/csv';
import { config } from './config.ts';
import { unlockKb } from './unlock.ts';
import { esc, type BotContext } from './context.ts';
import { texts } from './texts.ts';

export const instagramApi = new Composer<BotContext>();

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const link = (u: string) => `<a href="${profileUrl(u)}">${esc(u)}</a>`;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const SYNC_MAX_AGE_MIN = 15; // auf Abruf höchstens alle 15 Minuten neu laden

export const UNANSWERED_DEFAULT: NotificationSetting = { enabled: true, localTime: '19:00', options: {} };
/** Aktive Kommentierer, bei denen man sich lange nicht gemeldet hat - kommt mit derselben täglichen Nachricht */
export const NEGLECTED_DEFAULT: NotificationSetting = {
  enabled: true,
  localTime: null,
  options: { min_comments: NEGLECT_DEFAULTS.minComments, window_days: NEGLECT_DEFAULTS.windowDays, after_days: NEGLECT_DEFAULTS.afterDays },
};

export async function neglectRules(customerId: number): Promise<{ enabled: boolean; rules: NeglectRules }> {
  const s = await getNotification(getPool(), customerId, 'ig_neglected', NEGLECTED_DEFAULT);
  return {
    enabled: s.enabled,
    rules: {
      minComments: Number(s.options.min_comments ?? NEGLECT_DEFAULTS.minComments),
      windowDays: Number(s.options.window_days ?? NEGLECT_DEFAULTS.windowDays),
      afterDays: Number(s.options.after_days ?? NEGLECT_DEFAULTS.afterDays),
    },
  };
}

type Neglected = Awaited<ReturnType<typeof neglectedCommenters>>;

export function neglectedText(list: Neglected, rules: NeglectRules, max = 15): string {
  const since = (d: Date | null) => (d ? `zuletzt vor ${Math.round((Date.now() - new Date(d).getTime()) / 86_400_000)} Tagen` : 'noch nie');
  return (
    `⏳ <b>${list.length === 1 ? '1 aktiver Kommentierer wartet' : `${list.length} aktive Kommentierer warten`} auf dich</b>\n` +
    `<i>mind. ${rules.minComments} Kommentare in ${rules.windowDays} Tagen, du hast ${rules.afterDays}+ Tage nicht zurückkommentiert</i>\n\n` +
    list.slice(0, max).map((r, i) => `${i + 1}. ${link(r.username)} - ${r.n}× kommentiert · ${since(r.marked_at)}`).join('\n') +
    (list.length > max ? `\n… und ${list.length - max} weitere` : '')
  );
}

/** Freigeschaltet? Der Admin hat immer Zugriff. */
export async function unlocked(customerId: number, telegramUserId: number) {
  return telegramUserId === config.adminId || (await hasModule(getPool(), customerId, 'instagram_api'));
}

async function requireUnlocked(ctx: BotContext): Promise<boolean> {
  if (await unlocked(ctx.customer!.id, ctx.from!.id)) return true;
  await ctx.reply(texts.instaApiLocked, { ...html, reply_markup: unlockKb('instagram_api') });
  return false;
}

// ---------- Abgleich mit Schutz vor parallelen Läufen ----------

const running = new Set<number>();

export type SyncOutcome = { ok: true; acc: ApiAccount } | { ok: false; message: string };

/** Gleicht ab, wenn der letzte Abgleich älter als maxAgeMin ist. */
export async function ensureSynced(accountId: number, maxAgeMin = SYNC_MAX_AGE_MIN): Promise<SyncOutcome> {
  const acc = await getApiAccount(getPool(), accountId);
  if (!acc) return { ok: false, message: 'Noch kein Instagram-Konto verbunden. Anleitung: /meta, danach /verbinden' };
  if (acc.status === 'token_invalid') return { ok: false, message: texts.instaTokenInvalid };
  const fresh = acc.lastSyncAt && Date.now() - new Date(acc.lastSyncAt).getTime() < maxAgeMin * 60_000;
  if (fresh || running.has(accountId)) return { ok: true, acc };
  running.add(accountId);
  try {
    const token = await readToken(getPool(), accountId, config.tokenKey);
    await syncComments(getPool(), acc, createMetaClient(token!, fetch, acc.tokenKind, apiCallLogger(getPool(), accountId)));
    return { ok: true, acc };
  } catch (err) {
    if (err instanceof MetaApiError && err.tokenInvalid) {
      await markTokenInvalid(getPool(), accountId);
      return { ok: false, message: texts.instaTokenInvalid };
    }
    if (err instanceof MetaApiError) return { ok: false, message: `Instagram meldet einen Fehler: ${err.message}` };
    throw err;
  } finally {
    running.delete(accountId);
  }
}

const account = (ctx: BotContext) => getOrCreateAccount(getPool(), ctx.customer!.id);

async function synced(ctx: BotContext): Promise<ApiAccount | null> {
  if (!(await requireUnlocked(ctx))) return null;
  const r = await ensureSynced(await account(ctx));
  if (!r.ok) {
    await ctx.reply(r.message, html);
    return null;
  }
  return r.acc;
}

// ---------- Token entgegennehmen ----------

/** Wer gerade /verbinden aufgerufen hat (10 Minuten gültig), optional mit Instagram-Konto-ID */
const awaitingToken = new Map<number, { until: number; igUserId?: string }>();

instagramApi.command('verbinden', async (ctx) => {
  if (!(await requireUnlocked(ctx))) return;
  const arg = String(ctx.match ?? '').trim();
  if (arg && !/^\d{8,25}$/.test(arg)) return ctx.reply('Die Konto-ID besteht nur aus Ziffern, z. B. /verbinden 17841400000000000');
  awaitingToken.set(ctx.customer!.id, { until: Date.now() + 10 * 60_000, igUserId: arg || undefined });
  await ctx.reply(
    texts.instaConnectPrompt + (arg ? `\n\n🆔 Instagram-Konto-ID: <code>${arg}</code>` : ''),
    html,
  );
});

instagramApi.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const kind = tokenKind(text);
  if (!kind) return next();
  // Token nie im Chatverlauf stehen lassen
  await ctx.deleteMessage().catch(() => {});
  const cid = ctx.customer!.id;
  if (!(await unlocked(cid, ctx.from.id))) return ctx.reply(texts.instaApiLocked, { ...html, reply_markup: unlockKb('instagram_api') });
  const pending = awaitingToken.get(cid);
  const igUserId = pending && pending.until > Date.now() ? pending.igUserId : undefined;
  awaitingToken.delete(cid);
  const wait = await ctx.reply('🔐 Token erhalten und aus dem Chat gelöscht. Ich prüfe ihn bei Instagram …');
  try {
    const accountId = await account(ctx);
    const logCall = apiCallLogger(getPool(), accountId);
    const probe = createMetaClient(text, fetch, kind, logCall);
    const me = igUserId ? await probe.account(igUserId) : await probe.me();
    // Manche EAA-Tokens (Login über Instagram) gelten am Instagram-Server → dann diesen verwenden
    const effective = me.kind ?? kind;
    const client = createMetaClient(text, fetch, effective, logCall);
    const expiresAt = effective === kind ? await client.expiresAt() : new Date(Date.now() + 60 * 86_400_000);
    await connectAccount(getPool(), accountId, me, text, config.tokenKey, effective, expiresAt);
    const r = await ensureSynced(accountId, 0);
    const validity = expiresAt
      ? `Gültig bis ${expiresAt.toLocaleDateString('de-AT')}` +
        (effective === 'instagram' ? ', ich versuche ihn automatisch zu verlängern.' : '. Ich erinnere dich eine Woche vorher, einen neuen zu erzeugen.')
      : 'Der Token läuft nicht ab.';
    await ctx.api.editMessageText(
      ctx.chat.id,
      wait.message_id,
      `✅ Verbunden mit <b>@${esc(me.username)}</b>.\n${validity}\n` +
        (r.ok ? 'Kommentare der neuesten Beiträge sind geladen.\n\n' : `⚠️ ${esc(r.message)}\n\n`) +
        'Jetzt ausprobieren: /status · /unbeantwortet · /benachrichtigung',
      html,
    );
  } catch (err) {
    const msg = err instanceof MetaApiError ? err.message : 'Unbekannter Fehler';
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Instagram hat den Token abgelehnt: ${esc(msg)}\n\nAnleitung: /meta`, html);
  }
});

instagramApi.command('trennen', async (ctx) => {
  await ctx.reply('Instagram-Verbindung trennen? Der Token und alle geladenen Beiträge und Kommentare werden gelöscht. Deine Export-Daten bleiben.', {
    reply_markup: new InlineKeyboard().text('🔌 Ja, trennen', 'ia:disc').text('Abbrechen', 'ia:keep'),
  });
});

instagramApi.callbackQuery('ia:disc', async (ctx) => {
  await disconnectAccount(getPool(), await account(ctx));
  await ctx.answerCallbackQuery({ text: 'Getrennt' });
  await ctx.editMessageText('🔌 Verbindung getrennt, Token und Kommentardaten gelöscht. Tipp: In der Meta-App kannst du den Token zusätzlich widerrufen.').catch(() => {});
});
instagramApi.callbackQuery('ia:keep', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Abgebrochen.').catch(() => {});
});

instagramApi.command('meta', (ctx) => ctx.reply(texts.metaGuide, html));

// ---------- /status: Wer kommentiert bei mir? ----------

instagramApi.command('status', async (ctx) => {
  const a = String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
  const postLimit = /^\d+$/.test(a[0] ?? '') ? Math.min(Math.max(Number(a[0]), 1), 25) : 10;
  const topN = /^\d+$/.test(a[1] ?? '') ? Math.min(Math.max(Number(a[1]), 1), 30) : 15;
  const acc = await synced(ctx);
  if (!acc) return;
  const { active, snoozedCount } = await topCommenters(getPool(), acc.id, postLimit);
  if (!active.length) {
    return ctx.reply(snoozedCount ? 'Alle aktiven Kommentierer sind gerade ausgeblendet (schon zurückkommentiert). /snoozed' : 'Noch keine Kommentare in den letzten Beiträgen.');
  }
  const shown = active.slice(0, topN);
  const kb = new InlineKeyboard();
  shown.forEach((c, i) => kb.text(`✅ ${i + 1}. ${c.username}`.slice(0, 40), `ia:c:${c.username}`).row());
  const { rules } = await neglectRules(ctx.customer!.id);
  const waiting = (await neglectedCommenters(getPool(), acc.id, rules)).length;
  await ctx.reply(
    `💬 <b>Wer kommentiert bei dir</b> (letzte ${postLimit} Beiträge)\n` +
      (snoozedCount ? `<i>${snoozedCount} ausgeblendet, weil schon zurückkommentiert (/snoozed)</i>\n` : '') +
      `\n${shown.map((c, i) => `${i + 1}. ${link(c.username)} - ${c.count}× kommentiert`).join('\n')}\n\n` +
      `Hinterlass ihnen auch einen Kommentar und tippe dann auf den Namen. Er wird ${SNOOZE_DAYS} Tage ausgeblendet.` +
      (waiting ? `\n\n⏳ ${waiting} aktive ${waiting === 1 ? 'Kommentierer wartet' : 'Kommentierer warten'} seit über ${rules.afterDays} Tagen auf dich: /vergessen` : ''),
    { ...html, reply_markup: kb },
  );
});

instagramApi.callbackQuery(/^ia:c:([a-z0-9._]{1,30})$/, async (ctx) => {
  if (!(await unlocked(ctx.customer!.id, ctx.from.id))) return ctx.answerCallbackQuery();
  const user = ctx.match[1]!;
  await snooze(getPool(), await account(ctx), user);
  await ctx.answerCallbackQuery({ text: `${user} für ${SNOOZE_DAYS} Tage ausgeblendet ✅` });
  const rows = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((b) => ('callback_data' in b && b.callback_data === `ia:c:${user}` ? { text: `✅ ${user} erledigt`, callback_data: 'ia:noop' } : b)),
  );
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows as any } }).catch(() => {});
});
instagramApi.callbackQuery('ia:noop', (ctx) => ctx.answerCallbackQuery());

instagramApi.command('snoozed', async (ctx) => {
  if (!(await requireUnlocked(ctx))) return;
  const rows = await listSnoozed(getPool(), await account(ctx));
  if (!rows.length) return ctx.reply('Gerade ist niemand ausgeblendet.');
  const kb = new InlineKeyboard();
  rows.forEach((r, i) => kb.text(`↩️ ${i + 1}. ${r.username}`.slice(0, 40), `ia:u:${r.username}`).row());
  const hours = (d: Date) => Math.max(0, Math.round((new Date(d).getTime() - Date.now()) / 3_600_000));
  await ctx.reply(
    `Ausgeblendet (${rows.length}):\n${rows.map((r, i) => `${i + 1}. ${link(r.username)} - noch ${hours(r.snoozed_until)} h`).join('\n')}\n\nAntippen holt sie sofort zurück.`,
    { ...html, reply_markup: kb },
  );
});

instagramApi.callbackQuery(/^ia:u:([a-z0-9._]{1,30})$/, async (ctx) => {
  if (!(await unlocked(ctx.customer!.id, ctx.from.id))) return ctx.answerCallbackQuery();
  await unsnooze(getPool(), await account(ctx), ctx.match[1]!);
  await ctx.answerCallbackQuery({ text: `${ctx.match[1]} wieder sichtbar ↩️` });
});

// Aktive Kommentierer, bei denen du dich lange nicht gemeldet hast
instagramApi.command('vergessen', async (ctx) => {
  const acc = await synced(ctx);
  if (!acc) return;
  const { rules } = await neglectRules(ctx.customer!.id);
  const list = await neglectedCommenters(getPool(), acc.id, rules);
  if (!list.length) {
    return ctx.reply(`✅ Niemand vergessen: Bei allen aktiven Kommentierern hast du dich in den letzten ${rules.afterDays} Tagen gemeldet.`);
  }
  const kb = new InlineKeyboard();
  list.slice(0, 15).forEach((r, i) => kb.text(`✅ ${i + 1}. ${r.username}`.slice(0, 40), `ia:c:${r.username}`).row());
  await ctx.reply(
    neglectedText(list, rules) + `\n\nKommentier bei ihnen und tippe dann auf den Namen.\nRegeln ändern: /benachrichtigung aktive 3 30 14`,
    { ...html, reply_markup: kb },
  );
});

instagramApi.command('unsnooze', async (ctx) => {
  if (!(await requireUnlocked(ctx))) return;
  const name = String(ctx.match ?? '').trim();
  if (!name) return ctx.reply('Nutzung: /unsnooze username');
  await ctx.reply((await unsnooze(getPool(), await account(ctx), name)) ? `✅ ${name} wieder sichtbar.` : `${name} war nicht ausgeblendet.`);
});

// ---------- Unbeantwortete Kommentare ----------

const ago = (d: Date | null) => {
  if (!d) return '';
  const h = Math.round((Date.now() - new Date(d).getTime()) / 3_600_000);
  return h < 1 ? 'gerade eben' : h < 48 ? `vor ${h} h` : `vor ${Math.round(h / 24)} Tagen`;
};

export const openCount = (n: number) => (n === 1 ? '1 unbeantworteter Kommentar' : `${n} unbeantwortete Kommentare`);

export function unansweredText(list: OpenComment[], title: string, max = 15): string {
  const lines = list.slice(0, max).map((c) => {
    const post = c.permalink ? `<a href="${esc(c.permalink)}">Beitrag</a>` : 'Beitrag';
    return `${c.parentId ? "↪️" : "💬"} ${link(c.username)} · ${ago(c.commentedAt)} · ${post}\n   „${esc(clip(c.text, 160))}“`;
  });
  return `${title}\n\n${lines.join('\n')}` + (list.length > max ? `\n\n… und ${list.length - max} weitere` : '');
}

instagramApi.command(['unbeantwortet', 'replies'], async (ctx) => {
  const acc = await synced(ctx);
  if (!acc) return;
  const list = await unansweredComments(getPool(), acc.id);
  if (!list.length) return ctx.reply('✅ Keine unbeantworteten Kommentare in deinen neuesten Beiträgen.');
  const kb = new InlineKeyboard();
  list.slice(0, 10).forEach((c, i) => kb.text(`🙈 ${i + 1}. ${c.username} ignorieren`.slice(0, 40), `ia:d:${c.commentId}`).row());
  await ctx.reply(
    unansweredText(list, `📬 <b>${openCount(list.length)}</b> (ohne reine Emojis)`) +
      '\n\nSobald du auf Instagram antwortest, verschwindet der Kommentar beim nächsten Abgleich. Nicht antworten wollen: 🙈',
    { ...html, reply_markup: kb },
  );
});

instagramApi.callbackQuery(/^ia:d:([0-9_]{1,40})$/, async (ctx) => {
  if (!(await unlocked(ctx.customer!.id, ctx.from.id))) return ctx.answerCallbackQuery();
  await dismissComment(getPool(), await account(ctx), ctx.match[1]!);
  await ctx.answerCallbackQuery({ text: '🙈 Wird nicht mehr angezeigt' });
});

// Eine tägliche Nachricht zur gewählten Uhrzeit mit zwei Teilen, einzeln abschaltbar:
//   kommentare  unbeantwortete Kommentare (ig_unanswered, bestimmt auch die Uhrzeit)
//   aktive      aktive Kommentierer, bei denen du dich lange nicht gemeldet hast (ig_neglected)
instagramApi.command('benachrichtigung', async (ctx) => {
  if (!(await requireUnlocked(ctx))) return;
  const cid = ctx.customer!.id;
  const db = getPool();
  const un = await getNotification(db, cid, 'ig_unanswered', UNANSWERED_DEFAULT);
  const ne = await getNotification(db, cid, 'ig_neglected', NEGLECTED_DEFAULT);
  const a = String(ctx.match ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const usage =
    '/benachrichtigung 19:00 - Uhrzeit\n/benachrichtigung aus · an - alles\n' +
    '/benachrichtigung kommentare aus · an\n/benachrichtigung aktive aus · an\n' +
    '/benachrichtigung aktive 3 30 14 - ab 3 Kommentaren in 30 Tagen, nach 14 Tagen erinnern';

  if (a[0] === 'aus' || a[0] === 'an') {
    await setNotification(db, cid, 'ig_unanswered', { ...un, enabled: a[0] === 'an' });
    await setNotification(db, cid, 'ig_neglected', { ...ne, enabled: a[0] === 'an' });
  } else if (a[0] === 'kommentare' && (a[1] === 'aus' || a[1] === 'an')) {
    await setNotification(db, cid, 'ig_unanswered', { ...un, enabled: a[1] === 'an' });
  } else if (a[0] === 'aktive' && (a[1] === 'aus' || a[1] === 'an')) {
    await setNotification(db, cid, 'ig_neglected', { ...ne, enabled: a[1] === 'an' });
  } else if (a[0] === 'aktive' && a.length === 4 && a.slice(1).every((x) => /^\d{1,3}$/.test(x))) {
    const [min, win, after] = a.slice(1).map(Number) as [number, number, number];
    if (min < 1 || win < 1 || win > 365 || after < 1 || after > 365) return ctx.reply(usage);
    await setNotification(db, cid, 'ig_neglected', {
      ...ne, enabled: true, options: { min_comments: min, window_days: win, after_days: after },
    });
  } else if (a.length === 1 && parseTime(a[0])) {
    // Uhrzeit gilt für die ganze Nachricht; schaltet die Kommentar-Erinnerung mit ein
    await setNotification(db, cid, 'ig_unanswered', { ...un, enabled: true, localTime: parseTime(a[0]) });
  } else if (a.length) {
    return ctx.reply(usage);
  }

  const un2 = await getNotification(db, cid, 'ig_unanswered', UNANSWERED_DEFAULT);
  const { enabled: neOn, rules } = await neglectRules(cid);
  await ctx.reply(
    `🔔 <b>Tägliche Instagram-Nachricht</b> um ${un2.localTime}\n` +
      `💬 Unbeantwortete Kommentare: ${un2.enabled ? 'an' : 'aus'}\n` +
      `⏳ Vergessene aktive Kommentierer: ${neOn ? `an (ab ${rules.minComments} Kommentaren in ${rules.windowDays} Tagen, nach ${rules.afterDays} Tagen)` : 'aus'}\n\n` +
      'Die Nachricht kommt nur, wenn etwas offen ist. Reine Emoji-Kommentare werden ignoriert.\n\n' +
      usage,
    html,
  );
});


// ---------- Kombiniert mit dem Export ----------

instagramApi.command('kommentierer', async (ctx) => {
  const acc = await synced(ctx);
  if (!acc) return;
  const rows = (await openNonFollowers(getPool(), acc.id)).filter((r) => r.commented);
  if (!rows.length) return ctx.reply('Keine Nicht-Follower, die kommentiert haben (oder noch kein Export importiert: /insta).');
  await ctx.reply(
    `💬 Folgen dir nicht zurück, haben aber kommentiert: ${rows.length}\n\n` +
      rows.slice(0, 50).map((r, i) => `${i + 1}. ${link(r.username)}`).join('\n') +
      (rows.length > 50 ? `\n… und ${rows.length - 50} weitere` : '') +
      '\n\nDiese werden bei /entfolgen nie vorgeschlagen.',
    html,
  );
});

instagramApi.command('neu', async (ctx) => {
  const arg = String(ctx.match ?? '').trim();
  const days = /^\d+$/.test(arg) ? Math.min(Math.max(Number(arg), 1), 90) : 7;
  const acc = await synced(ctx);
  if (!acc) return;
  const rows = await newCommenters(getPool(), acc.id, days);
  if (!rows.length) return ctx.reply(`Keine neuen Kommentierer in den letzten ${days} Tagen.`);
  await ctx.reply(
    `🆕 Neue Kommentierer (letzte ${days} Tage): ${rows.length}\n👥 = folgt dir · ➕ = du folgst (laut letztem Export)\n\n` +
      rows.map((r, i) =>
        `${i + 1}. ${link(r.username)} · ${new Date(r.first_at).toLocaleDateString('de-AT')} · ${r.n}×${r.follows_me ? ' 👥' : ''}${r.i_follow ? ' ➕' : ''}`,
      ).join('\n'),
    html,
  );
});

// ---------- /apicalls: wie viele Anfragen gehen an Meta? ----------

instagramApi.command('apicalls', async (ctx) => {
  if (!(await requireUnlocked(ctx))) return;
  const isAdmin = ctx.from!.id === config.adminId;
  const accountId = await account(ctx);
  const s = await apiCallStats(getPool(), accountId);
  const acc = await getApiAccount(getPool(), accountId);
  const ago = (d: Date | null) => {
    if (!d) return 'noch nie';
    const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
    return min < 1 ? 'gerade eben' : min < 120 ? `vor ${min} Min.` : `vor ${Math.round(min / 60)} Std.`;
  };
  const usage = s.usagePct === null
    ? 'noch keine Angabe von Meta'
    : `${s.usagePct} % deines Limits${s.usageAt ? ` (Stand ${new Date(s.usageAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })})` : ''}`;
  let text =
    `📊 <b>Meta-API-Anfragen</b> (dein Konto)\n\n` +
    `Letzte Stunde: <b>${s.lastHour}</b>\nLetzte 24 h: <b>${s.last24h}</b>${s.failed24h ? ` (❌ ${s.failed24h} fehlgeschlagen)` : ''}\n` +
    `Letzte 7 Tage: <b>${s.last7d}</b>\n` +
    `Auslastung laut Meta: ${usage}\n` +
    `Letzter Abgleich: ${ago(acc?.lastSyncAt ?? null)}\n` +
    `<i>Abgeglichen wird nur bei Befehlen wie /status (höchstens alle 15 Min.) und für die tägliche Nachricht. ` +
    `/apicalls selbst fragt Meta nicht an.</i>\n` +
    (s.byEndpoint24h.length ? `\n<b>24 h nach Art:</b>\n${s.byEndpoint24h.map((e) => `• ${esc(e.endpoint)}: ${e.n}`).join('\n')}\n` : '') +
    (s.lastError ? `\n⚠️ Letzter Fehler (${esc(s.lastError.endpoint)}, ${new Date(s.lastError.at).toLocaleString('de-AT')}):\n${esc(s.lastError.error)}\n` : '') +
    `\n<i>Meta erlaubt pro Konto ein Vielfaches davon (abhängig von deiner Reichweite). ` +
    `Kritisch wird es erst, wenn die Auslastung gegen 100 % geht.</i>`;
  if (isAdmin) {
    const all = await apiCallStats(getPool(), null);
    const per = await apiCallsPerAccount(getPool());
    text +=
      `\n\n👑 <b>Alle Konten</b>: ${all.last24h} in 24 h · ${all.last7d} in 7 Tagen` +
      (all.usagePct !== null ? ` · höchste Auslastung ${all.usagePct} %` : '') +
      (per.length ? `\n${per.map((p) => `• @${esc(p.username ?? '?')}: ${p.n}${p.pct !== null ? ` (${p.pct} %)` : ''}`).join('\n')}` : '');
  }
  await ctx.reply(text, html);
});
