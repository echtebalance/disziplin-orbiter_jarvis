// Anmeldung per Einladung, Zugangssperre und Konto-Befehle (/hilfe, /datenschutz, /loeschen, /unterstuetzen).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { getPool, withTransaction } from '@echte-balance/db';
import {
  touchCustomer, ensureCustomer, redeemInvite, deleteCustomer, createInvite, requestAccess, getAccessRequest, decideAccess, saveMessage,
} from '@echte-balance/core/customers';
import { config } from './config.ts';
import { texts } from './texts.ts';
import { identity, esc, type BotContext } from './context.ts';
import { setUserCommands } from './commands.ts';
import { messageDoneKb } from './admin.ts';

export const account = new Composer<BotContext>();

const isAdmin = (ctx: BotContext) => ctx.from?.id === config.adminId;

// 1. Wer schreibt? Registrierte Kunden werden geladen (und Name/Username aktualisiert).
account.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot) return;
  if (ctx.chat && ctx.chat.type !== 'private') return; // nur Einzelchats
  ctx.customer = isAdmin(ctx)
    ? await ensureCustomer(getPool(), identity(ctx))
    : ((await touchCustomer(getPool(), identity(ctx))) ?? undefined);
  await next();
});

// 2. /start mit oder ohne Code. Funktioniert auch über den Link t.me/<bot>?start=CODE
/** Buttons unter der Willkommensnachricht: Schnellstart je Bereich, alle Befehle, Spenden */
function welcomeKb() {
  const kb = new InlineKeyboard()
    .text('🏋️ Training', 'wl:training').text('🚀 Planer', 'wl:planner').row()
    .text('📸 Instagram', 'wl:instagram').text('🧠 Statistik', 'wl:stats').row()
    .text('📘 Anleitung', 'wl:guide').text('📖 Alle Befehle', 'wl:help').row();
  if (config.donationUrl) kb.url('💜 Unterstützen', config.donationUrl);
  return kb;
}

account.command('start', async (ctx) => {
  const name = esc(ctx.from!.first_name);
  if (ctx.customer) return ctx.reply(texts.welcome(name), { parse_mode: 'HTML', reply_markup: welcomeKb() });

  const code = ctx.match.trim();
  if (!code) return ctx.reply(texts.noInvite, { parse_mode: 'HTML', reply_markup: requestKb });

  const result = await withTransaction((c) => redeemInvite(c, code, identity(ctx)));
  if (!result.ok) return ctx.reply(texts.inviteErrors[result.reason]);

  ctx.customer = result.customer;
  await setUserCommands(ctx.api, result.customer.id, ctx.from!.id).catch(() => {}); // Menü passend zur Einladung
  await ctx.reply(texts.welcome(name), { parse_mode: 'HTML', reply_markup: welcomeKb() });
  await sendGuide(ctx).catch(() => {}); // Anleitung gleich zum Start mitschicken
  await ctx.api
    .sendMessage(config.adminId, `🆕 Neuer Nutzer: ${esc(name)} ${ctx.from!.username ? '@' + ctx.from!.username : ''}`)
    .catch(() => {});
});

// 3. Zugang anfragen (für Leute ohne Einladung): Button oder /anfrage Text → Admin entscheidet per Button.
const requestKb = new InlineKeyboard().text('🙋 Zugang anfragen', 'acc:req').row().text('📘 Anleitung ansehen', 'wl:guide');

async function handleAccessRequest(ctx: BotContext, message: string | null) {
  const from = ctx.from!;
  const result = await requestAccess(getPool(), identity(ctx), message ? message.slice(0, 1000) : null);
  if (result === 'declined') return ctx.reply('Deine Anfrage wurde leider abgelehnt. Du kannst es in ein paar Wochen nochmal versuchen.');
  if (result === 'too_soon') return ctx.reply('⏳ Deine Anfrage liegt schon vor. Du bekommst Bescheid, sobald sie bearbeitet ist.');
  if (result === 'updated') {
    await ctx.api.sendMessage(config.adminId, `📝 Nachtrag zur Zugangsanfrage von ${esc(from.first_name)}:\n\n${esc(message!)}`, { parse_mode: 'HTML' }).catch(() => {});
    return ctx.reply('📝 Danke, deine Nachricht ist bei der Anfrage gespeichert.');
  }
  const who = `${esc([from.first_name, from.last_name].filter(Boolean).join(' '))}${from.username ? ` @${esc(from.username)}` : ' (ohne Benutzernamen)'}`;
  await ctx.api.sendMessage(
    config.adminId,
    `🙋 <b>Zugangsanfrage</b> von ${who}` + (message ? `:\n\n${esc(message)}` : '') +
      (from.username ? `\n\n<i>Profil: t.me/${esc(from.username)}</i>` : ''),
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text('✅ Freischalten', `acc:ok:${from.id}`).text('❌ Ablehnen', `acc:no:${from.id}`),
    },
  );
  await ctx.reply(
    '🙋 Deine Anfrage ist angekommen! Du bekommst hier Bescheid, sobald du freigeschaltet bist.' +
      (message ? '' : '\n\nMagst du kurz sagen, wer du bist oder wie du auf echte BΛLΛNCΣ gekommen bist? Schreib einfach /anfrage und deinen Text.'),
  );
}

account.callbackQuery('acc:req', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.customer) return ctx.reply('Du bist schon freigeschaltet. 🙂 /hilfe');
  await handleAccessRequest(ctx, null);
});

account.command('anfrage', async (ctx, next) => {
  if (ctx.customer) return next(); // Registrierte: normale Anfrage (weiter unten)
  await handleAccessRequest(ctx, String(ctx.match ?? '').trim() || null);
});

// Admin entscheidet: Freischalten schickt automatisch einen persönlichen Einladungslink
account.callbackQuery(/^acc:(ok|no):(\d{1,15})$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const tgId = Number(ctx.match[2]);
  const approve = ctx.match[1] === 'ok';
  const req = await getAccessRequest(getPool(), tgId);
  if (!req || !(await decideAccess(getPool(), tgId, approve))) {
    return ctx.answerCallbackQuery({ text: 'Schon entschieden.', show_alert: true });
  }
  const name = req.name ?? (req.username ? '@' + req.username : String(tgId));
  await ctx.answerCallbackQuery({ text: approve ? '✅ Freigeschaltet' : '❌ Abgelehnt' });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: approve ? `✅ ${name} freigeschaltet` : `❌ ${name} abgelehnt`, callback_data: 'acc:done' }]] } }).catch(() => {});
  if (!approve) {
    await ctx.api.sendMessage(tgId, 'Danke für dein Interesse an echte BΛLΛNCΣ! Gerade kann ich dich leider nicht freischalten. 💜').catch(() => {});
    return;
  }
  const invite = await createInvite(getPool(), { note: `Anfrage: ${name}`, expiresInDays: 14 });
  const link = `https://t.me/${ctx.me.username}?start=${invite.code}`;
  const sent = await ctx.api
    .sendMessage(tgId, `🎉 <b>Du bist freigeschaltet!</b>\nTippe auf den Button, um loszulegen.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().url('🚀 Jetzt starten', link),
    })
    .then(() => true)
    .catch(() => false);
  if (!sent) await ctx.reply(`⚠️ Konnte ${esc(name)} nicht erreichen. Schick den Link selbst: ${link}`, { parse_mode: 'HTML' });
});
account.callbackQuery('acc:done', (ctx) => ctx.answerCallbackQuery());

// /anleitung - bebilderte Anleitung: als Link (GUIDE_URL) oder als HTML-Datei zum Öffnen im Browser.
// Steht vor der Zugangssperre, damit auch Leute ohne Einladung sie lesen können.
const guideFile = fileURLToPath(new URL('../../../docs/anleitung.html', import.meta.url));
async function sendGuide(ctx: BotContext) {
  const intro = '📖 <b>Anleitung</b>\nWas Habits, Training, Plan, Gewicht, Entfolgen und der Instagram-Tracker dir bringen, mit Beispielen.';
  if (config.guideUrl) {
    return ctx.reply(intro, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('📖 Anleitung öffnen', config.guideUrl) });
  }
  const page = await readFile(guideFile, 'utf8').catch(() => null);
  if (!page) return ctx.reply(texts.help(isAdmin(ctx)), { parse_mode: 'HTML' });
  const html =
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Jarvis Anleitung</title><style>html,body{margin:0}</style></head><body>' + page + '</body></html>';
  await ctx.replyWithDocument(new InputFile(Buffer.from(html, 'utf8'), 'Jarvis-Anleitung.html'), {
    caption: intro + '\n\n<i>Datei antippen und im Browser öffnen.</i>',
    parse_mode: 'HTML',
  });
}
account.command(['anleitung', 'guide'], sendGuide);
account.callbackQuery('wl:guide', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendGuide(ctx);
});

// 4. Ab hier nur noch registrierte Nutzer.
account.use(async (ctx, next) => {
  if (!ctx.customer) {
    if (ctx.callbackQuery) return ctx.answerCallbackQuery();
    return ctx.reply(texts.noInvite, { parse_mode: 'HTML', reply_markup: requestKb });
  }
  await next();
});

account.command(['hilfe', 'help'], (ctx) => ctx.reply(texts.help(isAdmin(ctx)), { parse_mode: 'HTML' }));

account.callbackQuery(/^wl:(training|planner|instagram|stats|help)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const key = ctx.match[1] as keyof typeof texts.quickstart | 'help';
  await ctx.reply(key === 'help' ? texts.help(isAdmin(ctx)) : texts.quickstart[key], { parse_mode: 'HTML' });
});

// /anfrage Text - Nachricht an den Betreiber (z. B. Trainingsplan anfragen), höchstens 5 pro Tag
const requestsToday = new Map<number, { day: string; n: number }>();
account.command('anfrage', async (ctx) => {
  const text = String(ctx.match ?? '').trim();
  if (!text) return ctx.reply(texts.requestHelp, { parse_mode: 'HTML' });
  const day = new Date().toISOString().slice(0, 10);
  const c = requestsToday.get(ctx.from!.id);
  const n = c?.day === day ? c.n : 0;
  if (n >= 5) return ctx.reply('Du hast heute schon 5 Anfragen geschickt. Morgen wieder. 🙂');
  requestsToday.set(ctx.from!.id, { day, n: n + 1 });
  const from = ctx.from!;
  const who = `${esc([from.first_name, from.last_name].filter(Boolean).join(' '))}${from.username ? ` @${esc(from.username)}` : ''} (#${ctx.customer!.id})`;
  const ref = from.username ? '@' + from.username : '#' + ctx.customer!.id;
  // speichern, damit /anfragen sie zeigt, bis sie erledigt ist
  const id = await saveMessage(getPool(), ctx.customer!.id, text.slice(0, 1500));
  await ctx.api.sendMessage(
    config.adminId,
    `📩 <b>Anfrage</b> von ${who}:\n\n${esc(text.slice(0, 1500))}\n\n` +
      `<i>Plan geben: /plan geben ${esc(ref)} Planname</i>` +
      (from.username ? `\n<i>Antworten: t.me/${esc(from.username)}</i>` : '') +
      `\n<i>Alle offenen: /anfragen</i>`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: messageDoneKb(id) },
  );
  await ctx.reply('📩 Danke! Deine Anfrage ist angekommen. Du hörst bald von mir. 💜');
});

account.command('datenschutz',(ctx) => ctx.reply(texts.privacy, { parse_mode: 'HTML' }));

account.command('unterstuetzen', (ctx) => {
  const kb = config.donationUrl ? new InlineKeyboard().url('💜 Jetzt unterstützen', config.donationUrl) : undefined;
  return ctx.reply(texts.donation, { reply_markup: kb });
});

account.command('loeschen', (ctx) =>
  ctx.reply(texts.deleteConfirm, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('🗑 Ja, alles löschen', 'account:delete').text('Abbrechen', 'account:keep'),
  }),
);

account.callbackQuery('account:delete', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (isAdmin(ctx)) return ctx.editMessageText('Das Admin-Konto kann nicht über den Bot gelöscht werden.');
  await deleteCustomer(getPool(), ctx.customer!.id);
  await ctx.editMessageText(texts.deleted);
});

account.callbackQuery('account:keep', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(texts.deleteCancelled);
});
