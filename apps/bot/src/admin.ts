// Admin-Befehle: Einladungen erzeugen, Nutzer ansehen, Funktionen freischalten oder sperren.
import { Composer, InlineKeyboard } from 'grammy';
import { getPool } from '@echte-balance/db';
import {
  createInvite,
  listOpenInvites,
  listCustomers,
  findCustomer,
  grantModule,
  revokeModule,
  openRequests,
  markMessageDone,
  type Module,
} from '@echte-balance/core/customers';
import { config } from './config.ts';
import { esc, type BotContext } from './context.ts';
import { setUserCommands } from './commands.ts';

export const admin = new Composer<BotContext>();
const only = admin.filter((ctx) => ctx.from?.id === config.adminId);

// Kurze Namen für die Eingabe im Chat
const MODULE_ALIASES: Record<string, Module> = {
  insta: 'instagram_api',
  instagram: 'instagram_api',
  instagram_api: 'instagram_api',
  plaene: 'training_plans',
  pläne: 'training_plans',
  training_plans: 'training_plans',
  ki: 'ai_replies',
  ai: 'ai_replies',
  ai_replies: 'ai_replies',
};
const MODULE_LABEL: Record<Module, string> = {
  instagram_api: 'Instagram (Meta-API)',
  training_plans: 'Trainingspläne',
  ai_replies: 'KI-Antwortvorschläge',
};
const fmtDate = (d: Date | null) => (d ? new Date(d).toLocaleDateString('de-AT') : 'unbefristet');

only.command('einladung', async (ctx) => {
  const invite = await createInvite(getPool(), { note: ctx.match.trim() || undefined });
  const link = `https://t.me/${ctx.me.username}?start=${invite.code}`;
  await ctx.reply(
    `🎟 Neue Einladung${invite.note ? ` für <b>${esc(invite.note)}</b>` : ''}\n\n` +
      `Code: <code>${invite.code}</code>\n` +
      `Link: ${link}\n\n` +
      `Einlösbar bis ${fmtDate(invite.expires_at)}, nur einmal.`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
  );
});

only.command('einladungen', async (ctx) => {
  const invites = await listOpenInvites(getPool());
  if (!invites.length) return ctx.reply('Keine offenen Einladungen.');
  const lines = invites.map(
    (i) => `<code>${i.code}</code> · bis ${fmtDate(i.expires_at)}${i.note ? ` · ${esc(i.note)}` : ''}`,
  );
  await ctx.reply(`🎟 Offene Einladungen: ${invites.length}\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});

only.command('nutzer', async (ctx) => {
  const customers = await listCustomers(getPool());
  const lines = customers.map((c) => {
    const who = [c.display_name, c.telegram_username && '@' + c.telegram_username].filter(Boolean).join(' ');
    const mods = c.modules.map((m) => MODULE_LABEL[m as Module] ?? m).join(', ');
    return `<b>#${c.id}</b> ${esc(who)}${mods ? `\n    ✅ ${esc(mods)}` : ''}`;
  });
  await ctx.reply(`👥 Nutzer: ${customers.length}\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
});

async function parseTarget(ctx: BotContext, usage: string) {
  const [ref, mod, daysArg] = String(ctx.match ?? '').trim().split(/\s+/);
  const module = MODULE_ALIASES[(mod ?? '').toLowerCase()];
  if (!ref || !module) {
    await ctx.reply(usage);
    return null;
  }
  const customer = await findCustomer(getPool(), ref.startsWith('#') ? ref.slice(1) : ref);
  if (!customer) {
    await ctx.reply(`Nutzer ${ref} nicht gefunden. /nutzer zeigt alle.`);
    return null;
  }
  return { customer, module, daysArg };
}

only.command('freischalten', async (ctx) => {
  const t = await parseTarget(ctx, 'Nutzung: /freischalten <@name|Nr> <insta|plaene|ki> [Tage]\nOhne Tage = unbefristet.');
  if (!t) return;
  const days = t.daysArg && /^\d+$/.test(t.daysArg) ? Number(t.daysArg) : null;
  const until = await grantModule(getPool(), t.customer.id, t.module, days);
  const name = t.customer.display_name ?? `#${t.customer.id}`;
  await ctx.reply(`✅ ${MODULE_LABEL[t.module]} für ${name} freigeschaltet (${fmtDate(until)}).`);
  await setUserCommands(ctx.api, t.customer.id, t.customer.telegram_user_id).catch(() => {}); // Menü erweitern
  await ctx.api
    .sendMessage(t.customer.telegram_user_id, `🎉 Für dich freigeschaltet: ${MODULE_LABEL[t.module]}\nDie neuen Befehle findest du im Menü und unter /hilfe.`)
    .catch(() => {});
});

only.command('sperren', async (ctx) => {
  const t = await parseTarget(ctx, 'Nutzung: /sperren <@name|Nr> <insta|plaene|ki>');
  if (!t) return;
  const n = await revokeModule(getPool(), t.customer.id, t.module);
  await setUserCommands(ctx.api, t.customer.id, t.customer.telegram_user_id).catch(() => {}); // Menü verkleinern
  await ctx.reply(n ? `🔒 ${MODULE_LABEL[t.module]} gesperrt.` : 'War nicht freigeschaltet.');
});

// ---------- /anfragen: alle offenen Anfragen auf einen Blick ----------

const SHOW_MAX = 10; // pro Art höchstens so viele Einzelnachrichten
const ago = (d: Date) => {
  const h = Math.floor((Date.now() - new Date(d).getTime()) / 3_600_000);
  return h < 1 ? 'gerade eben' : h < 24 ? `vor ${h} h` : `vor ${Math.floor(h / 24)} T`;
};

only.command('anfragen', async (ctx) => {
  const r = await openRequests(getPool());
  const total = r.access.length + r.unlock.length + r.messages.length;
  if (!total) return ctx.reply('✅ Keine offenen Anfragen.');
  await ctx.reply(
    `📬 <b>Offene Anfragen: ${total}</b>\n` +
      `🙋 Zugang: ${r.access.length} · 🔓 Freischaltung: ${r.unlock.length} · 📩 Nachrichten: ${r.messages.length}` +
      (Math.max(r.access.length, r.unlock.length, r.messages.length) > SHOW_MAX ? `\n<i>Je Art die ${SHOW_MAX} ältesten. Nach dem Bearbeiten wieder /anfragen.</i>` : ''),
    { parse_mode: 'HTML' },
  );
  const opts = (kb: InlineKeyboard) => ({ parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, reply_markup: kb });
  for (const a of r.access.slice(0, SHOW_MAX)) {
    const name = esc(a.name ?? 'ohne Namen') + (a.username ? ` @${esc(a.username)}` : '');
    await ctx.reply(
      `🙋 <b>Zugang</b> · ${name} · ${ago(a.createdAt)}` + (a.message ? `\n\n${esc(a.message.slice(0, 600))}` : ''),
      opts(new InlineKeyboard().text('✅ Freischalten', `acc:ok:${a.telegramUserId}`).text('❌ Ablehnen', `acc:no:${a.telegramUserId}`)),
    );
  }
  for (const u of r.unlock.slice(0, SHOW_MAX)) {
    await ctx.reply(
      `🔓 <b>${esc(MODULE_LABEL[u.module])}</b> · ${esc(u.who)} · ${ago(u.createdAt)}`,
      opts(new InlineKeyboard().text('✅ Freischalten', `unl:ok:${u.customerId}:${u.module}`).text('❌ Ablehnen', `unl:no:${u.customerId}:${u.module}`)),
    );
  }
  for (const m of r.messages.slice(0, SHOW_MAX)) {
    const ref = m.username ? '@' + m.username : '#' + m.customerId;
    await ctx.reply(
      `📩 <b>Nachricht</b> · ${esc(m.who)} · ${ago(m.createdAt)}\n\n${esc(m.text.slice(0, 1200))}\n\n` +
        `<i>Plan geben: /plan geben ${esc(ref)} Planname</i>` + (m.username ? `\n<i>Antworten: t.me/${esc(m.username)}</i>` : ''),
      opts(messageDoneKb(m.id)),
    );
  }
});

/** Button "Erledigt" für eine /anfrage-Nachricht */
export const messageDoneKb = (id: number) => new InlineKeyboard().text('✅ Erledigt', `msg:done:${id}`);

only.callbackQuery(/^msg:done:(\d{1,15})$/, async (ctx) => {
  const ok = await markMessageDone(getPool(), Number(ctx.match[1]));
  await ctx.answerCallbackQuery({ text: ok ? '✅ Erledigt' : 'War schon erledigt.' });
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [[{ text: '✅ Erledigt', callback_data: 'msg:x' }]] } }).catch(() => {});
});
only.callbackQuery('msg:x', (ctx) => ctx.answerCallbackQuery());
