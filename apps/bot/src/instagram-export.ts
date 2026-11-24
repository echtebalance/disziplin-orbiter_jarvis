// Kostenlose Instagram-Funktionen auf Basis des Datenexports (ohne Meta-API):
// Upload, /import, /igstatus, /nichtfolger, /entfolgen, /igundo, /unfollower, /neuefollower, /igexport
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { getPool, withTransaction } from '@echte-balance/db';
import {
  ExportError,
  extractFromZip,
  kindOfFile,
  mergeLists,
  parseListJson,
} from '@echte-balance/instagram/export-parser';
import {
  cleanupStats,
  followerChanges,
  getOrCreateAccount,
  importSnapshot,
  listPending,
  markCleanup,
  openNonFollowers,
  savePending,
  takePending,
  undoCleanup,
  unfollowCandidates,
  unfollowedToday,
  type ImportResult,
} from '@echte-balance/instagram/snapshots';
import { toCsv, profileUrl } from '@echte-balance/instagram/csv';
import { config } from './config.ts';
import { esc, type BotContext } from './context.ts';
import { texts } from './texts.ts';

export const instagramExport = new Composer<BotContext>();

const DAILY_LIMIT = 20;
const BATCH = 5;
const PAGE_SIZE = 20;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // Download-Grenze der Telegram-Bot-API

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const link = (u: string) => `<a href="${profileUrl(u)}">${esc(u)}</a>`;
const fmtDate = (d: Date | null) => (d ? new Date(d).toLocaleDateString('de-AT') : '-');
const account = (ctx: BotContext) => getOrCreateAccount(getPool(), ctx.customer!.id);

// ---------- Texte ----------

function importSummary(r: ImportResult): string {
  let msg = `✅ <b>Import fertig</b>\n\nFollower: ${r.followers} · Following: ${r.following}`;
  if (r.hasPrevious) {
    msg +=
      `\n\nSeit dem letzten Export:\n` +
      `➕ ${r.newFollowers} neue Follower (/neuefollower)\n` +
      `➖ ${r.lostFollowers} entfolgt (/unfollower)`;
  } else {
    msg += `\n\nDas war dein erster Export. Ab dem nächsten siehst du, wer dir entfolgt ist.`;
  }
  if (r.stillFollowingMarked > 0) {
    msg +=
      `\n\n⚠️ ${r.stillFollowingMarked} als entfolgt abgehakte Accounts stehen noch in deiner Following-Liste. ` +
      `Ist der Export älter als dein Abhaken?`;
  }
  return msg + `\n\nWeiter mit /nichtfolger oder /entfolgen.`;
}

async function statusText(ctx: BotContext): Promise<string> {
  const id = await account(ctx);
  const s = await cleanupStats(getPool(), id);
  if (!s.importedAt) return texts.instaGuide;
  const today = await unfollowedToday(getPool(), id, ctx.customer!.timezone);
  return (
    `📊 <b>Instagram</b> (Export vom ${fmtDate(s.importedAt)})\n\n` +
    `Following: ${s.following} · Follower: ${s.followers}\n` +
    `Folgen dir nicht zurück: ${s.nonFollowers}\n` +
    `Davon offen: ${s.open}` +
    (s.open !== s.candidates ? ` (💬 kommentiert: ${s.open - s.candidates})` : '') +
    `\nEntfolgt (abgehakt): ${s.unfollowed} · Behalten: ${s.kept}\n` +
    `Heute: ${today}/${DAILY_LIMIT} · Rest bei ${DAILY_LIMIT}/Tag: ca. ${Math.ceil(s.candidates / DAILY_LIMIT)} Tage`
  );
}

// ---------- Listen mit Blättern ----------

type ListName = 'nf' | 'lost' | 'new';

async function renderList(ctx: BotContext, list: ListName, page: number) {
  const id = await account(ctx);
  let title: string;
  let lines: string[];
  if (list === 'nf') {
    const all = await openNonFollowers(getPool(), id);
    title = `👀 Folgen dir nicht zurück (offen): ${all.length}` + (all.some((n) => n.commented) ? '\n💬 = hat kommentiert' : '');
    lines = all.map((n) => `${link(n.username)}${n.commented ? ' 💬' : ''}`);
  } else {
    const ch = await followerChanges(getPool(), id, list);
    if (!ch) return { text: 'Dafür brauche ich mindestens zwei Exporte. Schick mir beim nächsten Mal einen neuen.', kb: undefined };
    title =
      (list === 'lost' ? `➖ Entfolgt` : `➕ Neue Follower`) +
      ` zwischen ${fmtDate(ch.since)} und ${fmtDate(ch.until)}: ${ch.usernames.length}` +
      (list === 'lost' ? `\n<i>Enthält auch gelöschte oder deaktivierte Konten.</i>` : '');
    lines = ch.usernames.map(link);
  }
  const pages = Math.max(1, Math.ceil(lines.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const slice = lines.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((l, i) => `${page * PAGE_SIZE + i + 1}. ${l}`);
  const kb = new InlineKeyboard();
  if (pages > 1) {
    if (page > 0) kb.text('⬅️', `ig:l:${list}:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, 'ig:noop');
    if (page < pages - 1) kb.text('➡️', `ig:l:${list}:${page + 1}`);
  }
  return { text: `${title}\n\n${slice.join('\n') || 'Keine.'}`, kb: pages > 1 ? kb : undefined };
}

async function sendList(ctx: BotContext, list: ListName) {
  const { text, kb } = await renderList(ctx, list, 0);
  await ctx.reply(text, { ...html, reply_markup: kb });
}

// ---------- Entfolgen in 5er-Blöcken ----------

async function sendBatch(ctx: BotContext) {
  const id = await account(ctx);
  const done = await unfollowedToday(getPool(), id, ctx.customer!.timezone);
  const left = DAILY_LIMIT - done;
  if (left <= 0) return ctx.reply(`✅ Für heute genug (${DAILY_LIMIT}/${DAILY_LIMIT}). Morgen geht's weiter.`);
  const all = await unfollowCandidates(getPool(), id);
  if (!all.length) return ctx.reply('🎉 Keine Kandidaten mehr (oder noch kein Export importiert, siehe /insta).');
  const rows = all.slice(0, Math.min(BATCH, left));
  const kb = new InlineKeyboard();
  rows.forEach((r, i) => kb.text(`✅ ${i + 1}. ${r.username}`, `ig:u:${r.username}`).text('🛡', `ig:k:${r.username}`).row());
  await ctx.reply(
    `🧹 <b>Entfolgen</b> (heute ${done}/${DAILY_LIMIT}, noch ${all.length} Kandidaten)\n` +
      `Entfolge in der Instagram-App und hake hier ab. ✅ = entfolgt, 🛡 = behalten.\n\n` +
      rows.map((r, i) => `${i + 1}. ${link(r.username)}`).join('\n'),
    { ...html, reply_markup: kb },
  );
}

// ---------- Upload ----------

async function download(ctx: BotContext): Promise<Uint8Array> {
  const file = await ctx.getFile();
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function runImport(accountId: number) {
  return withTransaction(async (c) => {
    const parts = await takePending(c, accountId);
    const { followers, following } = mergeLists(parts);
    return importSnapshot(c, accountId, followers, following);
  });
}

instagramExport.on('message:document', async (ctx, next) => {
  const doc = ctx.message.document;
  const name = doc.file_name ?? '';
  const isZip = /\.zip$/i.test(name);
  const kind = kindOfFile(name);
  if (!isZip && !kind) return next();
  if ((doc.file_size ?? 0) > MAX_UPLOAD_BYTES) {
    return ctx.reply('Die Datei ist größer als 20 MB. Wähle beim Export nur „Follower und gefolgte Personen“ aus.');
  }
  try {
    const bytes = await download(ctx);
    const id = await account(ctx);
    if (isZip) {
      const { files, hasHtml } = extractFromZip(bytes);
      if (!files.length) {
        return ctx.reply(
          hasHtml
            ? 'Der Export ist im HTML-Format. Bitte fordere ihn erneut im Format <b>JSON</b> an (siehe /insta).'
            : 'In der ZIP-Datei habe ich keine following.json bzw. followers_1.json gefunden (siehe /insta).',
          html,
        );
      }
      // Eine ZIP enthält alles: direkt importieren, vorher hochgeladene Einzeldateien verwerfen.
      const result = await withTransaction(async (c) => {
        await takePending(c, id);
        const { followers, following } = mergeLists(files.map((f) => ({ kind: f.kind, entries: parseListJson(f.text, f.kind) })));
        return importSnapshot(c, id, followers, following);
      });
      return ctx.reply(importSummary(result), html);
    }
    const entries = parseListJson(new TextDecoder().decode(bytes), kind!);
    await savePending(getPool(), id, name, kind!, entries);
    const pending = await listPending(getPool(), id);
    const has = (k: string) => pending.some((p) => p.kind === k);
    await ctx.reply(
      `📥 ${esc(name)} gespeichert (${entries.length} Einträge).\n` +
        (has('follower') && has('following')
          ? `Wenn alle Dateien da sind: /import`
          : `Es fehlt noch: ${has('following') ? 'followers_1.json' : 'following.json'}`),
      html,
    );
  } catch (err) {
    if (err instanceof ExportError) return ctx.reply(`❌ ${err.message}`);
    throw err;
  }
});

// ---------- Befehle ----------

instagramExport.command('insta', async (ctx) => ctx.reply(await statusText(ctx), html));
instagramExport.command('igstatus', async (ctx) => ctx.reply(await statusText(ctx), html));

instagramExport.command('import', async (ctx) => {
  const id = await account(ctx);
  if (!(await listPending(getPool(), id)).length) {
    return ctx.reply('Es liegen keine Dateien bereit. Schick mir zuerst die ZIP oder die JSON-Dateien (siehe /insta).');
  }
  try {
    await ctx.reply(importSummary(await runImport(id)), html);
  } catch (err) {
    if (err instanceof ExportError) return ctx.reply(`❌ ${err.message}`);
    throw err;
  }
});

instagramExport.command('nichtfolger', (ctx) => sendList(ctx, 'nf'));
instagramExport.command('unfollower', (ctx) => sendList(ctx, 'lost'));
instagramExport.command('neuefollower', (ctx) => sendList(ctx, 'new'));
instagramExport.command('entfolgen', (ctx) => sendBatch(ctx));

instagramExport.command('igundo', async (ctx) => {
  const name = ctx.match.trim();
  const undone = await undoCleanup(getPool(), await account(ctx), name || undefined);
  if (!undone) return ctx.reply(name ? `${name} war nicht abgehakt oder geschützt.` : 'Keine geschützten Accounts zum Aufheben.');
  await ctx.reply(`↩️ ${undone} steht wieder in der Liste.`);
});

instagramExport.command('igexport', async (ctx) => {
  const id = await account(ctx);
  const nf = await openNonFollowers(getPool(), id);
  if (!nf.length && !(await cleanupStats(getPool(), id)).importedAt) return ctx.reply(texts.instaGuide, html);
  const date = new Date().toISOString().slice(0, 10);
  await ctx.replyWithDocument(
    new InputFile(
      toCsv(['Benutzername', 'Profil', 'Gefolgt seit', 'Hat kommentiert'], nf.map((n) => [
        n.username, profileUrl(n.username), n.followedAt ? fmtDate(n.followedAt) : '', n.commented ? 'ja' : '',
      ])),
      `nicht-follower_${date}.csv`,
    ),
  );
  const lost = await followerChanges(getPool(), id, 'lost');
  if (lost) {
    await ctx.replyWithDocument(
      new InputFile(toCsv(['Benutzername', 'Profil'], lost.usernames.map((u) => [u, profileUrl(u)])), `unfollower_${date}.csv`),
    );
  }
});

// ---------- Buttons ----------

instagramExport.callbackQuery('ig:noop', (ctx) => ctx.answerCallbackQuery());

instagramExport.callbackQuery(/^ig:l:(nf|lost|new):(\d+)$/, async (ctx) => {
  const { text, kb } = await renderList(ctx, ctx.match[1] as ListName, Number(ctx.match[2]));
  await ctx.editMessageText(text, { ...html, reply_markup: kb }).catch(() => {});
  await ctx.answerCallbackQuery();
});

instagramExport.callbackQuery(/^ig:(u|k):([a-z0-9._]{1,30})$/, async (ctx) => {
  const [, action, user] = ctx.match as unknown as [string, 'u' | 'k', string];
  const id = await account(ctx);
  const tz = ctx.customer!.timezone;
  if (action === 'u' && (await unfollowedToday(getPool(), id, tz)) >= DAILY_LIMIT) {
    return ctx.answerCallbackQuery({ text: `Tageslimit ${DAILY_LIMIT} erreicht.`, show_alert: true });
  }
  await markCleanup(getPool(), id, user, action === 'u' ? 'unfollowed' : 'keep');
  const done = await unfollowedToday(getPool(), id, tz);
  await ctx.answerCallbackQuery({ text: action === 'u' ? `✅ ${done}/${DAILY_LIMIT} heute` : `🛡 ${user} bleibt` });

  const rows = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.some((b) => 'callback_data' in b && (b.callback_data === `ig:u:${user}` || b.callback_data === `ig:k:${user}`))
      ? [{ text: action === 'u' ? `✅ ${user} entfolgt` : `🛡 ${user} behalten`, callback_data: 'ig:noop' }]
      : row,
  );
  const pending = rows.some((row) => row.some((b) => 'callback_data' in b && /^ig:[uk]:/.test(b.callback_data ?? '')));
  if (!pending) {
    const left = DAILY_LIMIT - done;
    rows.push([
      left > 0
        ? { text: `➡️ Nächste ${Math.min(BATCH, left)}`, callback_data: 'ig:next' }
        : { text: `🎯 Tageslimit ${DAILY_LIMIT}/${DAILY_LIMIT} erreicht`, callback_data: 'ig:noop' },
    ]);
  }
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows as any } }).catch(() => {});
});

instagramExport.callbackQuery('ig:next', async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows = (ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? []).filter(
    (row) => !row.some((b) => 'callback_data' in b && b.callback_data === 'ig:next'),
  );
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows as any } }).catch(() => {});
  await sendBatch(ctx);
});
