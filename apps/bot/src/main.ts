// Kunden-Bot von echte_balance. Start: npm run bot:dev
import { Bot } from 'grammy';
import { closePool, getPool } from '@echte-balance/db';
import { config } from './config.ts';
import { account } from './account.ts';
import { admin } from './admin.ts';
import { unlock } from './unlock.ts';
import { instagramExport } from './instagram-export.ts';
import { instagramApi } from './instagram-api.ts';
import { aiReplies } from './ai-replies.ts';
import { planner } from './planner.ts';
import { training } from './training.ts';
import { startScheduler } from './scheduler.ts';
import { syncAllCommands } from './commands.ts';
import type { BotContext } from './context.ts';

// Zeitlimit pro Telegram-Anfrage: höher als die 30 s des Long Pollings, aber deutlich unter dem
// grammY-Standard von 500 s - sonst hängt der Start bei Telegram-Störungen minutenlang.
const bot = new Bot<BotContext>(config.botToken, { client: { timeoutSeconds: 60 } });

bot.use(account); // Anmeldung + Zugangssperre zuerst
bot.use(admin);
bot.use(unlock);
bot.use(instagramExport);
bot.use(aiReplies); // vor instagramApi: übernimmt /replies für Nutzer mit KI-Freischaltung
bot.use(instagramApi); // vor dem Training: fängt Tokens im Freitext ab, bevor sie als Satz gelesen werden
bot.use(planner);
bot.use(training);

bot.catch((err) => {
  console.error(`Fehler bei Update ${err.ctx.update.update_id}:`, err.error);
  err.ctx.reply('❌ Da ist etwas schiefgelaufen. Bitte versuch es gleich noch einmal.').catch(() => {});
});

await getPool().query('SELECT 1'); // früh scheitern, wenn die Datenbank nicht erreichbar ist

// Bei Telegram anmelden. grammY wiederholt das bei Störungen (z. B. 502 oder Netz noch nicht
// bereit nach dem Hochfahren) selbstständig, bis es klappt - ohne eigene Meldung, daher hier eine.
console.log('Verbinde mit Telegram … (bei Störungen wird automatisch weiter versucht)');
const slow = setTimeout(() => console.warn('Telegram antwortet noch nicht. Ich versuche es weiter.'), 30_000);
await bot.init();
clearTimeout(slow);

// Befehlsmenü in Telegram: Standard für alle, eigenes Menü für Freigeschaltete und den Admin.
// Nicht kritisch: Schlägt es fehl (z. B. kurzer Telegram-Ausfall), läuft der Bot trotzdem.
await syncAllCommands(bot.api).catch((err) => console.warn('Befehlsmenü konnte nicht gesetzt werden:', err.message));

const stopScheduler = startScheduler(bot.api);

async function shutdown() {
  stopScheduler();
  await bot.stop();
  await closePool();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await bot.start({
  drop_pending_updates: true,
  onStart: (me) => console.log(`Bot @${me.username} läuft.`),
});
