// Freischaltungen anfragen: /freischaltung zeigt die Extras, Nutzer fragen per Button an,
// der Admin schaltet mit einem Tipp frei. Gesperrte Funktionen zeigen denselben Button.
import { Composer, InlineKeyboard } from 'grammy';
import { getPool } from '@echte-balance/db';
import { activeModules, decideUnlock, getCustomerById, requestUnlock, type Module } from '@echte-balance/core/customers';
import { config } from './config.ts';
import { esc, type BotContext } from './context.ts';
import { setUserCommands } from './commands.ts';

export const unlock = new Composer<BotContext>();

interface Extra {
  module: Module;
  label: string;
  desc: string;
  next: string; // was der Nutzer nach der Freischaltung tun soll
  requires?: Module;
}

export const EXTRAS: Extra[] = [
  {
    module: 'instagram_api',
    label: '📸 Instagram-Tracker',
    desc: 'Über die offizielle Meta-API: wer bei dir aktiv ist, wem du antworten solltest und wen du schon zu lange vergessen hast. Mit täglicher Zusammenfassung zu deiner Uhrzeit.',
    next: 'So geht es weiter: /meta zeigt dir, wie du dein Instagram verbindest. Danach /status und /unbeantwortet.',
  },
  {
    module: 'ai_replies',
    label: '🤖 KI-Antwortvorschläge',
    desc: 'Fünf passende Antworten je Kommentar, abgestimmt auf deinen Beitrag. Braucht den Instagram-Tracker.',
    next: 'So geht es weiter: /ki zeigt dir, wie du einen kostenlosen KI-Schlüssel verbindest. Danach /antworten.',
    requires: 'instagram_api',
  },
];
const extraOf = (m: string) => EXTRAS.find((e) => e.module === m) ?? null;

/** Button "Freischaltung anfragen" für gesperrte Funktionen */
export const unlockKb = (module: Module) => new InlineKeyboard().text('🙋 Freischaltung anfragen', `unl:req:${module}`);

unlock.command(['freischaltung', 'extras'], async (ctx) => {
  const have = new Set(await activeModules(getPool(), ctx.customer!.id));
  const isAdmin = ctx.from!.id === config.adminId;
  const kb = new InlineKeyboard();
  const lines = EXTRAS.map((e) => {
    const on = isAdmin || have.has(e.module);
    if (!on) kb.text(`🙋 ${e.label} anfragen`, `unl:req:${e.module}`).row();
    return `${on ? '✅' : '🔒'} <b>${e.label}</b>\n${esc(e.desc)}`;
  });
  await ctx.reply(
    `🔓 <b>Extras</b>\n\n${lines.join('\n\n')}\n\n` +
      `💪 <b>Fertige Trainings- und Recovery-Pläne</b>\nSchreib einfach, was du suchst: <code>/anfrage Ich hätte gern einen Plan für …</code>` +
      (kb.inline_keyboard.length ? '\n\nTippe an, was du freigeschaltet haben möchtest:' : ''),
    { parse_mode: 'HTML', reply_markup: kb.inline_keyboard.length ? kb : undefined },
  );
});

unlock.callbackQuery(/^unl:req:(instagram_api|ai_replies)$/, async (ctx) => {
  const module = ctx.match[1] as Module;
  const e = extraOf(module)!;
  const cid = ctx.customer!.id;
  await ctx.answerCallbackQuery();
  const result = await requestUnlock(getPool(), cid, module);
  if (result === 'already') return ctx.reply(`✅ ${e.label} ist für dich schon freigeschaltet.\n${e.next}`);
  if (result === 'too_soon') return ctx.reply('⏳ Deine Anfrage liegt schon vor. Du bekommst hier Bescheid.');
  if (result === 'declined') return ctx.reply('Diese Anfrage wurde vor Kurzem abgelehnt. Versuch es in ein paar Tagen nochmal.');
  const from = ctx.from;
  const missing = e.requires && !(await activeModules(getPool(), cid)).includes(e.requires) ? extraOf(e.requires) : null;
  const who = `${esc([from.first_name, from.last_name].filter(Boolean).join(' '))}${from.username ? ` @${esc(from.username)}` : ''} (#${cid})`;
  await ctx.api.sendMessage(
    config.adminId,
    `🔓 <b>Freischaltung angefragt</b>\n${who} möchte: <b>${e.label}</b>` +
      (missing ? `\n<i>Hinweis: braucht auch ${missing.label} - der wird beim Freischalten mit freigeschaltet.</i>` : ''),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('✅ Freischalten', `unl:ok:${cid}:${module}`).text('❌ Ablehnen', `unl:no:${cid}:${module}`),
    },
  );
  await ctx.reply(`🙋 Anfrage für <b>${e.label}</b> ist raus! Du bekommst hier Bescheid, sobald es freigeschaltet ist.`, { parse_mode: 'HTML' });
});

// Admin entscheidet mit einem Tipp
unlock.callbackQuery(/^unl:(ok|no):(\d{1,12}):(instagram_api|ai_replies)$/, async (ctx) => {
  if (ctx.from.id !== config.adminId) return ctx.answerCallbackQuery();
  const approve = ctx.match[1] === 'ok';
  const cid = Number(ctx.match[2]);
  const module = ctx.match[3] as Module;
  const e = extraOf(module)!;
  const target = await getCustomerById(getPool(), cid);
  if (!target || !(await decideUnlock(getPool(), cid, module, approve))) {
    return ctx.answerCallbackQuery({ text: 'Schon entschieden oder Nutzer gelöscht.', show_alert: true });
  }
  // Voraussetzung (KI braucht Instagram) gleich mit freischalten
  let alsoUnlocked: Extra | null = null;
  if (approve && e.requires && !(await activeModules(getPool(), cid)).includes(e.requires)) {
    await requestUnlock(getPool(), cid, e.requires);
    await decideUnlock(getPool(), cid, e.requires, true);
    alsoUnlocked = extraOf(e.requires);
  }
  const name = target.display_name ?? (target.telegram_username ? '@' + target.telegram_username : `#${cid}`);
  await ctx.answerCallbackQuery({ text: approve ? '✅ Freigeschaltet' : '❌ Abgelehnt' });
  await ctx.editMessageReplyMarkup({
    reply_markup: { inline_keyboard: [[{ text: `${approve ? '✅' : '❌'} ${e.label} für ${name}`.slice(0, 60), callback_data: 'unl:done' }]] },
  }).catch(() => {});
  if (approve) await setUserCommands(ctx.api, cid, target.telegram_user_id).catch(() => {});
  await ctx.api
    .sendMessage(
      target.telegram_user_id,
      approve
        ? (alsoUnlocked
            ? `🎉 <b>${e.label}</b> und <b>${alsoUnlocked.label}</b> sind für dich freigeschaltet!\n\n` +
              `So geht es weiter:\n1. ${esc(alsoUnlocked.next.replace(/^So geht es weiter: /, ''))}\n` +
              `2. ${esc(e.next.replace(/^So geht es weiter: /, ''))}`
            : `🎉 <b>${e.label}</b> ist für dich freigeschaltet!\n\n${esc(e.next)}`) +
          `\n\n<i>Die neuen Befehle findest du jetzt auch im Menü.</i>`
        : `Deine Anfrage für ${e.label} wurde gerade nicht freigeschaltet. Bei Fragen: /anfrage`,
      { parse_mode: 'HTML' },
    )
    .catch(() => {});
});
unlock.callbackQuery('unl:done', (ctx) => ctx.answerCallbackQuery());
