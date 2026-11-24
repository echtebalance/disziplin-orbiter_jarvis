// KI-Antwortvorschläge für unbeantwortete Kommentare - eigenes Freischalt-Modul (ai_replies),
// zusätzlich muss Instagram über die Meta-API verbunden sein. Jeder Nutzer nutzt seinen eigenen,
// kostenlosen KI-Schlüssel (GroqCloud oder Google Gemini).
import { Composer, InlineKeyboard } from 'grammy';
import { getPool } from '@echte-balance/db';
import { hasModule } from '@echte-balance/core/customers';
import { nowIn } from '@echte-balance/planner/time';
import {
  AiError, buildMessages, cachedSuggestions, createAiClient, deleteAiConfig, detectProvider, getAiConfig, listAiKeys, parseSuggestions,
  saveAiConfig, setActiveProvider, storeSuggestions, takeUsage, updateAiConfig, DEFAULT_STYLE, PROVIDERS, type Provider,
} from '@echte-balance/instagram/ai';
import {
  getApiAccount, setImageText, threadHistory, unansweredComments, type OpenComment,
} from '@echte-balance/instagram/comments';
import { getOrCreateAccount } from '@echte-balance/instagram/snapshots';
import { config } from './config.ts';
import { unlockKb } from './unlock.ts';
import { esc, type BotContext } from './context.ts';
import { ensureSynced, unlocked as instaUnlocked } from './instagram-api.ts';
import { texts } from './texts.ts';

export const aiReplies = new Composer<BotContext>();

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const DAILY_LIMIT = 40; // KI-Anfragen pro Nutzer und Tag (schont die Gratis-Kontingente)
const PER_RUN = 5; // so viele Kommentare pro /antworten

/** Freigeschaltet? Admin immer; sonst Modul ai_replies UND Instagram (Meta-API). */
async function aiUnlocked(customerId: number, telegramUserId: number) {
  if (telegramUserId === config.adminId) return true;
  return (await hasModule(getPool(), customerId, 'ai_replies')) && (await instaUnlocked(customerId, telegramUserId));
}

async function requireAi(ctx: BotContext) {
  if (await aiUnlocked(ctx.customer!.id, ctx.from!.id)) return true;
  await ctx.reply(texts.aiLocked, { ...html, reply_markup: unlockKb('ai_replies') });
  return false;
}

const running = new Set<number>();

/** Zuletzt funktionierender Ersatz (anderes Modell oder anderer Anbieter), solange der aktive überlastet ist */
const tempModel = new Map<number, { provider: Provider; base: string; model: string; until: number }>();
const TEMP_MODEL_MS = 15 * 60_000;

/**
 * KI fragen: zuerst den zuletzt funktionierenden Ersatz, sonst den aktiven Anbieter; ist er überlastet
 * (auch nach seinen eigenen Ersatzmodellen), die anderen gespeicherten Anbieter.
 */
export async function askAi(cid: number, messages: ReturnType<typeof buildMessages>) {
  const keys = await listAiKeys(getPool(), cid, config.tokenKey);
  if (!keys.length) throw new AiError('Kein KI-Schlüssel hinterlegt. Einrichten: /ki');
  const active = keys[0]!.provider;
  const t = tempModel.get(cid);
  const temp = t && t.until > Date.now() && keys.some((k) => k.provider === t.provider && k.model === t.base) ? t : null;
  const order = temp ? [...keys].sort((x, y) => Number(y.provider === temp.provider) - Number(x.provider === temp.provider)) : keys;
  let lastErr: unknown;
  for (const k of order) {
    const start = temp && temp.provider === k.provider ? temp.model : k.model;
    const client = createAiClient(k.provider, k.key, start);
    try {
      const raw = await client.chat(messages);
      // Anbieter hat das Modell abgeschaltet und den Nachfolger genannt → dauerhaft merken
      if (client.model && client.model !== start) await updateAiConfig(getPool(), cid, { model: client.model, provider: k.provider });
      const used = client.usedModel ?? k.model;
      if (k.provider !== active || used !== k.model) tempModel.set(cid, { provider: k.provider, base: k.model, model: used, until: Date.now() + TEMP_MODEL_MS });
      else tempModel.delete(cid);
      return { raw, provider: k.provider, fallback: k.provider !== active };
    } catch (err) {
      if (!(err instanceof AiError) || !err.transient) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Vorschläge für einen Kommentar: aus dem Cache oder neu (zählt gegen das Tageslimit). */
async function suggestFor(cid: number, accountId: number, c: OpenComment, day: string, fresh = false) {
  if (!fresh) {
    const cached = await cachedSuggestions(getPool(), accountId, c.commentId, c.text);
    if (cached?.length) return { list: cached, cached: true };
  }
  const cfg = await getAiConfig(getPool(), cid, config.tokenKey);
  if (!cfg) throw new AiError('Kein KI-Schlüssel hinterlegt. Einrichten: /ki');
  if (!(await takeUsage(getPool(), cid, day, DAILY_LIMIT))) throw new AiError(`Tageslimit von ${DAILY_LIMIT} KI-Anfragen erreicht. Morgen geht's weiter.`, 429);
  const own = (await getApiAccount(getPool(), accountId))?.username ?? '';
  const history = await threadHistory(getPool(), accountId, c, own);
  const r = await askAi(cid, buildMessages({ ...c, history }, cfg.style));
  const list = parseSuggestions(r.raw);
  if (!list.length) throw new AiError('Die KI hat keine Vorschläge geliefert.');
  await storeSuggestions(getPool(), accountId, c.commentId, c.text, list);
  return { list, cached: false, via: r.fallback ? PROVIDERS[r.provider].label : undefined };
}

function suggestionMessage(c: OpenComment, list: string[], cached: boolean, via?: string) {
  const post = c.permalink ? `<a href="${esc(c.permalink)}">Beitrag</a>` : 'Beitrag';
  return (
    `${c.parentId ? '↪️ <b>Antwort in Diskussion</b> von' : '💬'} <b>@${esc(c.username)}</b> · ${post}\n„${esc(c.text.slice(0, 500))}“\n` +
    `<i>🖼 Bildtext: ${c.imageText ? `„${esc(c.imageText.slice(0, 60))}${c.imageText.length > 60 ? '…' : ''}“` : 'noch nicht eingegeben'}</i>\n\n` +
    list.map((s, i) => `${i + 1}. <code>${esc(s)}</code>`).join('\n') +
    `\n\n<i>Antippen kopiert den Text${cached ? ' · ♻️ gespeichert' : ''}${via ? ` · über ${via}, der andere Anbieter war überlastet` : ''}</i>`
  );
}

const suggestionKb = (c: OpenComment) =>
  new InlineKeyboard()
    .text(c.imageText ? '🖼 Bildtext ändern' : '🖼 Bildtext eingeben', `ai:img:${c.mediaId}:${c.commentId}`)
    .text('🔄 Neu erzeugen', `ai:re:${c.commentId}`);

/** Einen offenen Kommentar per ID finden (für Buttons) */
async function openComment(accountId: number, commentId: string) {
  return (await unansweredComments(getPool(), accountId, 500)).find((c) => c.commentId === commentId) ?? null;
}

// ---------- Einrichten ----------

aiReplies.command('ki', async (ctx) => {
  if (!(await requireAi(ctx))) return;
  const cid = ctx.customer!.id;
  const [sub, ...rest] = String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
  const cfg = await getAiConfig(getPool(), cid, config.tokenKey);

  if (sub === 'stil') {
    if (!cfg) return ctx.reply('Zuerst einen KI-Schlüssel verbinden: /ki');
    const style = rest.join(' ').trim();
    if (!style) return ctx.reply(`Dein Stil:\n<i>${esc(cfg.style ?? DEFAULT_STYLE)}</i>\n\nÄndern: /ki stil Locker, mit Humor, kurze Sätze …\nZurücksetzen: /ki stil standard`, html);
    await updateAiConfig(getPool(), cid, { style: style.toLowerCase() === 'standard' ? null : style.slice(0, 500) });
    return ctx.reply('✅ Stil gespeichert. Gilt für neue Vorschläge.');
  }
  if (sub === 'modell') {
    if (!cfg) return ctx.reply('Zuerst einen KI-Schlüssel verbinden: /ki');
    const client = createAiClient(cfg.provider, cfg.key, null);
    if (!rest[0]) {
      const ids = await client.models().catch(() => [] as string[]);
      return ctx.reply(`Aktuelles Modell: <code>${esc(cfg.model)}</code>\n\nVerfügbar (Auszug):\n${ids.slice(0, 15).map((i) => `<code>${esc(i.replace(/^models\//, ''))}</code>`).join('\n')}\n\nWechseln: /ki modell NAME`, html);
    }
    await updateAiConfig(getPool(), cid, { model: rest[0] });
    return ctx.reply(`✅ Modell: ${rest[0]}`);
  }
  if (sub === 'trennen') {
    const which = rest[0] ? providerByName(rest[0]) : undefined;
    if (rest[0] && !which) return ctx.reply('Anbieter nicht erkannt. Beispiele: /ki trennen groq · /ki trennen gemini · /ki trennen (alle)');
    const now = await deleteAiConfig(getPool(), cid, which);
    tempModel.delete(cid);
    return ctx.reply(
      (which ? `🔌 ${PROVIDERS[which].label}-Schlüssel gelöscht.` : '🔌 Alle KI-Schlüssel gelöscht.') +
        (now ? ` Aktiv ist jetzt ${PROVIDERS[now].label}.` : '') +
        '\nTipp: Beim Anbieter kannst du den Schlüssel zusätzlich löschen.',
    );
  }
  const target = sub ? providerByName(sub) : undefined;
  if (target) {
    if (!(await setActiveProvider(getPool(), cid, target))) {
      return ctx.reply(`Für ${PROVIDERS[target].label} ist noch kein Schlüssel gespeichert. Schick ihn einfach als Nachricht. Anleitung: /ki`);
    }
    tempModel.delete(cid);
    return ctx.reply(`✅ Aktiv: ${PROVIDERS[target].label}. Ist er überlastet, springt ein anderer gespeicherter Anbieter ein.`);
  }
  if (cfg) return ctx.reply(await kiOverview(cid), { ...html, reply_markup: await kiKb(cid) });
  await ctx.reply(texts.aiGuide, html);
});

/** "groq", "groqcloud", "gemini", "google" … → Anbieter */
function providerByName(name: string): Provider | undefined {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (n.startsWith('groq')) return 'groq';
  if (n === 'gemini' || n === 'google') return 'gemini';
  if (n === 'openrouter') return 'openrouter';
  if (n === 'openai' || n === 'chatgpt') return 'openai';
  return undefined;
}

async function kiOverview(cid: number) {
  const keys = await listAiKeys(getPool(), cid, config.tokenKey);
  return (
    `🤖 <b>KI-Antwortvorschläge</b>\n\n<b>Gespeicherte Schlüssel</b>\n` +
    keys.map((k) => `${k.active ? '✅' : '▫️'} ${PROVIDERS[k.provider].label} · <code>${esc(k.model)}</code>${k.active ? ' (aktiv)' : ''}`).join('\n') +
    (keys.length > 1 ? '\n<i>Ist der aktive überlastet, springt der andere automatisch ein.</i>' : '\n<i>Tipp: Speicher einen zweiten Anbieter als Ersatz, falls einer überlastet ist.</i>') +
    '\n\n/antworten - Vorschläge für deine neuesten unbeantworteten Kommentare\n' +
    '/ki stil … - deinen Schreibstil festlegen\n/ki modell - Modell des aktiven Anbieters ansehen oder wechseln\n' +
    '/ki trennen [anbieter] - einen oder alle Schlüssel löschen\n\n' +
    'Neuen Schlüssel einfach als Nachricht schicken. Er ersetzt nur den Schlüssel desselben Anbieters.'
  );
}

/** Buttons zum Umschalten, wenn mehrere Anbieter gespeichert sind */
async function kiKb(cid: number) {
  const keys = await listAiKeys(getPool(), cid, config.tokenKey);
  const kb = new InlineKeyboard();
  for (const k of keys.filter((k) => !k.active)) kb.text(`↔️ ${PROVIDERS[k.provider].label} aktiv machen`, `ai:use:${k.provider}`).row();
  return kb;
}

aiReplies.callbackQuery(/^ai:use:(gemini|groq|openrouter|openai)$/, async (ctx) => {
  const cid = ctx.customer!.id;
  const p = ctx.match[1] as Provider;
  const ok = await setActiveProvider(getPool(), cid, p);
  tempModel.delete(cid);
  await ctx.answerCallbackQuery(ok ? `${PROVIDERS[p].label} ist jetzt aktiv` : 'Kein Schlüssel gespeichert');
  await ctx.editMessageText(await kiOverview(cid), { ...html, reply_markup: await kiKb(cid) }).catch(() => {});
});

/** Wer gerade einen Bildtext eintippen will: Beitrag und Kommentar, 10 Minuten gültig */
const awaitingImageText = new Map<number, { mediaId: string; commentId: string; until: number }>();

// Freitext: Bildtext (wenn angefragt) oder KI-Schlüssel
aiReplies.on('message:text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const cid = ctx.customer!.id;
  const pending = awaitingImageText.get(cid);
  if (pending && pending.until > Date.now() && !text.startsWith('/')) {
    awaitingImageText.delete(cid);
    const accountId = await getOrCreateAccount(getPool(), cid);
    const value = text === '-' ? null : text.slice(0, 600);
    await setImageText(getPool(), accountId, pending.mediaId, value);
    return ctx.reply(value ? '✅ Bildtext gespeichert. Gilt für alle Kommentare unter diesem Beitrag.' : '🗑 Bildtext entfernt.', {
      reply_markup: new InlineKeyboard().text('🔄 Neue Vorschläge', `ai:re:${pending.commentId}`),
    });
  }
  const provider = detectProvider(text);
  if (!provider) return next();
  await ctx.deleteMessage().catch(() => {});
  if (!(await aiUnlocked(ctx.customer!.id, ctx.from.id))) return ctx.reply(texts.aiLocked, { ...html, reply_markup: unlockKb('ai_replies') });
  const wait = await ctx.reply(`🔐 Schlüssel erhalten und aus dem Chat gelöscht. Ich prüfe ihn bei ${PROVIDERS[provider].label} …`);
  try {
    const model = await createAiClient(provider, text, null).pickModel();
    await saveAiConfig(getPool(), cid, { provider, model, key: text, style: null }, config.tokenKey);
    tempModel.delete(cid);
    const others = (await listAiKeys(getPool(), cid, config.tokenKey)).filter((k) => k.provider !== provider);
    await ctx.api.editMessageText(
      ctx.chat.id, wait.message_id,
      `✅ Verbunden mit <b>${PROVIDERS[provider].label}</b> · Modell <code>${esc(model)}</code> (jetzt aktiv)\n` +
        (PROVIDERS[provider].free ? 'Kostenlos im Rahmen der Tageslimits des Anbieters.\n' : '⚠️ Bei diesem Anbieter fallen Kosten an.\n') +
        (others.length
          ? `\nAuch gespeichert: ${others.map((k) => PROVIDERS[k.provider].label).join(', ')}. Ist ${PROVIDERS[provider].label} überlastet, springt er ein. ` +
            `Umschalten: /ki ${others[0]!.provider}\n`
          : '') +
        '\nJetzt ausprobieren: /antworten\nAlle Schlüssel und Einstellungen: /ki',
      html,
    );
  } catch (err) {
    const msg = err instanceof AiError && err.badKey ? 'Der Schlüssel wurde abgelehnt.' : (err as Error).message;
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ ${esc(msg)}\n\nAnleitung: /ki`, html);
  }
});

// ---------- Vorschläge ----------

aiReplies.command(['antworten', 'replies'], async (ctx, next) => {
  // Ohne KI-Freischaltung: /replies wie bisher als Liste der unbeantworteten Kommentare
  if (!(await aiUnlocked(ctx.customer!.id, ctx.from!.id))) {
    if (ctx.message?.text?.startsWith('/replies')) return next();
    return ctx.reply(texts.aiLocked, { ...html, reply_markup: unlockKb('ai_replies') });
  }
  const cid = ctx.customer!.id;
  if (!(await getAiConfig(getPool(), cid, config.tokenKey))) return ctx.reply(texts.aiGuide, html);
  if (running.has(cid)) return ctx.reply('⏳ Läuft schon, einen Moment …');
  running.add(cid);
  try {
    const accountId = await getOrCreateAccount(getPool(), cid);
    const sync = await ensureSynced(accountId);
    if (!sync.ok) return ctx.reply(sync.message, html);
    const all = await unansweredComments(getPool(), accountId);
    if (!all.length) return ctx.reply('✅ Keine unbeantworteten Kommentare - nichts zu tun.');
    const page = all.slice(0, PER_RUN);
    await ctx.reply(
      all.length === 1
        ? '🤖 1 unbeantworteter Kommentar. Ich erstelle Vorschläge …'
        : `🤖 ${all.length} unbeantwortete Kommentare. Ich erstelle Vorschläge für die ${page.length} neuesten …`,
    );
    const day = nowIn(ctx.customer!.timezone).day;
    for (const c of page) {
      try {
        const { list, cached, via } = await suggestFor(cid, accountId, c, day);
        await ctx.reply(suggestionMessage(c, list, cached, via), { ...html, reply_markup: suggestionKb(c) });
      } catch (err) {
        await ctx.reply(`⚠️ @${esc(c.username)}: ${esc((err as Error).message)}`, html);
        if (err instanceof AiError && (err.rateLimited || err.badKey)) break;
      }
    }
    if (all.length > page.length) {
      await ctx.reply(
        `Noch ${all.length - page.length} weitere offen. Nach dem Antworten auf Instagram einfach nochmal /antworten.\n` +
          'Kommentare, auf die du nicht antworten willst, blendest du in /unbeantwortet mit 🙈 aus.',
      );
    }
  } finally {
    running.delete(cid);
  }
});

// ---------- Buttons an den Vorschlägen ----------

aiReplies.callbackQuery(/^ai:img:(\d{1,25}):([0-9_]{1,30})$/, async (ctx) => {
  if (!(await aiUnlocked(ctx.customer!.id, ctx.from.id))) return ctx.answerCallbackQuery();
  awaitingImageText.set(ctx.customer!.id, { mediaId: ctx.match[1]!, commentId: ctx.match[2]!, until: Date.now() + 10 * 60_000 });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    '🖼 Schick mir jetzt den <b>Text auf dem Bild</b> (Spruch) dieses Beitrags als Nachricht.\n' +
      'Er wird für alle Kommentare unter dem Beitrag verwendet. Löschen: einfach <code>-</code> schicken.',
    html,
  );
});

aiReplies.callbackQuery(/^ai:re:([0-9_]{1,30})$/, async (ctx) => {
  const cid = ctx.customer!.id;
  if (!(await aiUnlocked(cid, ctx.from.id))) return ctx.answerCallbackQuery();
  if (running.has(cid)) return ctx.answerCallbackQuery({ text: '⏳ Läuft schon …' });
  const accountId = await getOrCreateAccount(getPool(), cid);
  const c = await openComment(accountId, ctx.match[1]!);
  if (!c) return ctx.answerCallbackQuery({ text: 'Kommentar ist schon beantwortet oder ausgeblendet.', show_alert: true });
  await ctx.answerCallbackQuery({ text: '🔄 Erzeuge neue Vorschläge …' });
  running.add(cid);
  try {
    const { list, via } = await suggestFor(cid, accountId, c, nowIn(ctx.customer!.timezone).day, true);
    await ctx.reply(suggestionMessage(c, list, false, via), { ...html, reply_markup: suggestionKb(c) });
  } catch (err) {
    await ctx.reply(`⚠️ ${esc((err as Error).message)}`, html);
  } finally {
    running.delete(cid);
  }
});
