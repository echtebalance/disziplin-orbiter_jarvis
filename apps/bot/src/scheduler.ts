// Prüft jede Minute für alle Planer-Nutzer: Aufgaben-Erinnerungen, Termine, freie Tage, Berichte.
// Jede Nachricht wird über core.notification_log nur einmal verschickt, auch nach einem Neustart.
// Statt exakter Minuten gibt es Zeitfenster: Ist der Bot kurz aus, kommt die Nachricht beim Start nach.
import { InlineKeyboard, type Api } from 'grammy';
import { getPool } from '@echte-balance/db';
import { claimNotification, getNotification } from '@echte-balance/core/notifications';
import { addDays, dayNum, nowIn, toMin, weekLabel, weekStart, fmtRange, type LocalNow } from '@echte-balance/planner/time';
import {
  addVacationDay, eventsFrom, getSettings, getWeekFree, listHabits, logsBetween, markEventSent,
  onVacation, plannerCustomers, updateSettings, workPaused, VACATION_OPEN,
} from '@echte-balance/planner/store';
import { applies, currentPeriod, previousPeriod } from '@echte-balance/planner/stats';
import { bodyWeightAskers, recentBodyWeights, updateState } from '@echte-balance/training/store';
import { fmtKg } from '@echte-balance/training/parse';
import { ASK_HOUR, CHECK_AFTER, NOTIFY_DEFAULTS, freeKb, optionsKb, statsFor } from './planner.ts';
import { startTrainingIfDue, trainingCalendar } from './training.ts';
import { createMetaClient, MetaApiError } from '@echte-balance/instagram/meta-api';
import {
  apiAccounts, apiCallLogger, connectAccount, getApiAccount, markTokenInvalid, neglectedCommenters, pruneApiCalls, readToken, unansweredComments,
} from '@echte-balance/instagram/comments';
import {
  ensureSynced, neglectedText, neglectRules, openCount, unansweredText, unlocked, UNANSWERED_DEFAULT,
} from './instagram-api.ts';
import { config } from './config.ts';
import { texts } from './texts.ts';
import { esc } from './context.ts';

const START_WINDOW = 10; // Minuten: Start-Erinnerung nur kurz nach der Uhrzeit
const LATE_WINDOW = 180; // Minuten: Rückfragen und Berichte holt der Bot bis zu 3 h nach

type Send = (text: string, kb?: InlineKeyboard) => Promise<unknown>;
const inWindow = (now: LocalNow, at: number, len: number) => now.minutes >= at && now.minutes < at + len;

export async function tickCustomer(cid: number, now: LocalNow, send: Send) {
  const db = getPool();
  const once = (kind: string, ref: string) => claimNotification(db, cid, kind, ref);
  let s = await getSettings(db, cid);

  // Urlaub abgelaufen?
  if (s.vacation_until && s.vacation_until !== VACATION_OPEN && now.day > s.vacation_until) {
    await updateSettings(db, cid, { vacation_until: null });
    s = { ...s, vacation_until: null };
    await send('💼 Urlaub vorbei. Ab heute wird die Arbeit wieder aufgezeichnet.');
  }
  if (onVacation(s, now.day)) await addVacationDay(db, cid, now.day);

  // Aufgaben: Start-Erinnerung und Rückfrage "erledigt?"
  const trainingDay = await trainingCalendar(cid);
  const habits = (await listHabits(db, cid, true)).filter((h) => h.remind && h.start_time && applies(h, now.day, trainingDay));
  if (habits.length) {
    const logged = new Set((await logsBetween(db, cid, now.day, now.day)).map((l) => l.habit_id));
    const paused = await workPaused(db, cid, s, now.day);
    for (const h of habits) {
      if (logged.has(h.id) || (h.category === 'work' && paused)) continue;
      const start = toMin(h.start_time!);
      if (inWindow(now, start, START_WINDOW) && (await once('habit_start', `${h.id}:${now.day}`))) {
        // Training mit aktivem Plan: direkt die geführte Einheit starten
        if (h.key === 'training' && (await startTrainingIfDue(cid, now.day, send))) continue;
        await send(
          `⏰ <b>${esc(h.label)}</b> - jetzt dran (${fmtRange(h.min_min, h.max_min)})`,
          new InlineKeyboard().text('✅ Schon erledigt', `pl:o:${h.id}:r`),
        );
      }
      const check = start + h.max_min + CHECK_AFTER;
      if (inWindow(now, check, LATE_WINDOW) && (await once('habit_check', `${h.id}:${now.day}`))) {
        await send(`❓ <b>${esc(h.label)}</b>: erledigt? (geplant ${fmtRange(h.min_min, h.max_min)})\nWie lange hat es gedauert?`, optionsKb(h, 'r'));
      }
    }
  }

  // Sonntags: freie Tage der nächsten Woche erfragen
  if (s.ask_weekly && now.dow === 0 && inWindow(now, ASK_HOUR * 60, LATE_WINDOW)) {
    const next = addDays(weekStart(now.day), 7);
    if (!(await getWeekFree(db, cid, next)) && (await once('free_ask', next))) {
      await send(
        `🗓 <b>Wann hast du nächste Woche frei?</b>\n${weekLabel(next)}\n✅ = frei. Tage antippen, dann „Fertig“. Oder: /frei nächste di sa`,
        await freeKb(cid, s, next),
      );
    }
  }

  // Termine (auch an freien Tagen und im Urlaub)
  const ev = await getNotification(db, cid, 'event_reminder', NOTIFY_DEFAULTS.event_reminder);
  const before = Number(ev.options.minutes_before ?? 0);
  const nowAbs = dayNum(now.day) * 1440 + now.minutes;
  for (const e of await eventsFrom(db, cid, now.day)) {
    const diff = dayNum(e.day) * 1440 + toMin(e.time) - nowAbs;
    if (before && !e.sent_pre && diff > 0 && diff <= before) {
      await markEventSent(db, e.id, 'pre');
      await send(`⏰ In ${diff} Min: <b>${esc(e.title)}</b> (${e.time})`);
    } else if (ev.enabled && !e.sent_day && now.day === addDays(e.day, -1) && now.minutes >= toMin(ev.localTime ?? '21:00')) {
      await markEventSent(db, e.id, 'day');
      await send(`📅 Morgen: <b>${esc(e.title)}</b> um ${e.time}`);
    }
  }

  // Berichte: Woche (samstags), Monat (am 1. für den Vormonat), Jahr (1. Jänner)
  const wk = await getNotification(db, cid, 'weekly_report', NOTIFY_DEFAULTS.weekly_report);
  if (wk.enabled && now.dow === 6 && inWindow(now, toMin(wk.localTime ?? '20:00'), LATE_WINDOW) && (await once('weekly_report', weekStart(now.day)))) {
    const per = currentPeriod('woche', now);
    await send(await statsFor(cid, per.title, per.from, per.to, now.day));
  }
  const mo = await getNotification(db, cid, 'monthly_report', NOTIFY_DEFAULTS.monthly_report);
  const moAt = toMin(mo.localTime ?? '08:00');
  if (mo.enabled && now.day.endsWith('-01') && inWindow(now, moAt, LATE_WINDOW) && (await once('monthly_report', now.day))) {
    const per = previousPeriod('monat', now);
    await send(await statsFor(cid, `Monat ${per.title.slice(9)}`, per.from, per.to, now.day));
    if (now.day.endsWith('-01-01') && (await once('yearly_report', now.day))) {
      const y = previousPeriod('jahr', now);
      await send(await statsFor(cid, `Jahr ${y.title.slice(8)}`, y.from, y.to, now.day));
    }
  }
}

/**
 * Instagram (Meta-API): Token rechtzeitig verlängern und zur gewählten Uhrzeit an
 * unbeantwortete Kommentare erinnern. Abgeglichen wird nur dann (1 Aufruf + geänderte Beiträge).
 */
export async function tickInstagram(c: { accountId: number; customerId: number; telegramUserId: number }, now: LocalNow, send: Send) {
  const db = getPool();
  if (!(await unlocked(c.customerId, c.telegramUserId))) return;
  const acc = await getApiAccount(db, c.accountId);
  if (!acc) return;

  // Token: täglich prüfen. Instagram-Tokens ab 10 Tagen vor Ablauf verlängern (frühestens 24 h nach
  // dem letzten Mal); Facebook-Tokens lassen sich nicht verlängern → ab 7 Tagen vorher erinnern.
  if (acc.status === 'active' && acc.tokenExpiresAt && (await claimNotification(db, c.customerId, 'ig_token_check', now.day))) {
    const daysLeft = (new Date(acc.tokenExpiresAt).getTime() - Date.now()) / 86_400_000;
    const age = acc.tokenUpdatedAt ? (Date.now() - new Date(acc.tokenUpdatedAt).getTime()) / 3_600_000 : 999;
    const warn = () =>
      send(`⚠️ Dein Instagram-Token läuft in ${Math.max(0, Math.round(daysLeft))} Tagen ab.\n` +
        'Erzeuge einen neuen (Anleitung: /meta) und schick ihn mir nach /verbinden. Deine Daten bleiben erhalten.');
    if (acc.tokenKind === 'facebook') {
      if (daysLeft < 7) await warn();
    } else if (daysLeft < 10 && age >= 24) {
      try {
        const token = await readToken(db, acc.id, config.tokenKey);
        const r = await createMetaClient(token!, fetch, 'instagram', apiCallLogger(db, acc.id)).refresh();
        await connectAccount(db, acc.id, { userId: acc.igUserId, username: acc.username, accountType: null }, r.token, config.tokenKey,
          'instagram', new Date(Date.now() + r.expiresIn * 1000));
      } catch (err) {
        if (err instanceof MetaApiError && err.tokenInvalid) await markTokenInvalid(db, acc.id);
        if (daysLeft < 7) await warn();
      }
    }
  }

  // Tägliche Nachricht: unbeantwortete Kommentare + vergessene aktive Kommentierer (je abschaltbar)
  const st = await getNotification(db, c.customerId, 'ig_unanswered', UNANSWERED_DEFAULT);
  const ne = await neglectRules(c.customerId);
  if (!st.enabled && !ne.enabled) return;
  if (!inWindow(now, toMin(st.localTime ?? '19:00'), LATE_WINDOW)) return;
  if (!(await claimNotification(db, c.customerId, 'ig_daily', now.day))) return;
  const r = await ensureSynced(c.accountId, 0);
  if (!r.ok) return send(r.message);
  const parts: string[] = [];
  if (st.enabled) {
    const list = await unansweredComments(db, c.accountId);
    const since = Date.now() - 24 * 3_600_000;
    const fresh = list.filter((x) => new Date(x.firstSeenAt).getTime() >= since).length;
    if (list.length) parts.push(unansweredText(list, `📬 <b>${openCount(list.length)}</b>${fresh ? ` (${fresh} neu)` : ''}`, 10) + '\n→ /unbeantwortet');
  }
  if (ne.enabled) {
    const list = await neglectedCommenters(db, c.accountId, ne.rules);
    if (list.length) parts.push(neglectedText(list, ne.rules, 10) + '\n→ /vergessen');
  }
  if (!parts.length) return; // nichts offen → keine Nachricht
  await send(parts.join('\n\n') + '\n\n<i>Einstellen: /benachrichtigung</i>');
}

/** Tägliche Gewichtsabfrage (nur wer sie mit /gewicht an eingeschaltet hat) */
export async function askBodyWeight(cid: number, bwTime: string, now: LocalNow, send: Send) {
  const db = getPool();
  if (!inWindow(now, toMin(bwTime), 120)) return;
  if (!(await claimNotification(db, cid, 'bw_ask', now.day))) return;
  const recent = await recentBodyWeights(db, cid, 1);
  if (recent[0]?.day === now.day) return; // heute schon eingetragen
  await updateState(db, cid, { bw_pending: now.day });
  await send(
    `⚖️ Guten Morgen! Wie viel wiegst du heute?${recent[0] ? ` (zuletzt ${fmtKg(recent[0].kg)} kg)` : ''}\n` +
      'Einfach die Zahl schreiben, z. B. <code>82,5</code>',
  );
}

/** Startet die minütliche Prüfung. Liefert eine Funktion zum Beenden. */
export function startScheduler(api: Api): () => void {
  let running = false;
  let prunedOn = '';
  const tick = async () => {
    if (running) return; // vorheriger Durchlauf läuft noch
    running = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (prunedOn !== today) {
        prunedOn = today;
        await pruneApiCalls(getPool()).catch(() => {}); // API-Protokoll älter als 30 Tage
      }
      const sender = (telegramUserId: number): Send => (text, kb) =>
        api.sendMessage(telegramUserId, text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
      for (const c of await plannerCustomers(getPool())) {
        try {
          await tickCustomer(c.id, nowIn(c.timezone), sender(c.telegramUserId));
        } catch (err) {
          console.error(`Planer-Erinnerungen für Kunde ${c.id} fehlgeschlagen:`, (err as Error).message);
        }
      }
      for (const c of await apiAccounts(getPool())) {
        try {
          await tickInstagram(c, nowIn(c.timezone), sender(c.telegramUserId));
        } catch (err) {
          console.error(`Instagram-Takt für Kunde ${c.customerId} fehlgeschlagen:`, (err as Error).message);
        }
      }
      for (const c of await bodyWeightAskers(getPool())) {
        try {
          await askBodyWeight(c.id, c.bwTime, nowIn(c.timezone), sender(c.telegramUserId));
        } catch (err) {
          console.error(`Gewichtsabfrage für Kunde ${c.id} fehlgeschlagen:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('Planer-Takt fehlgeschlagen:', (err as Error).message);
    } finally {
      running = false;
    }
  };
  // Auf den Minutenanfang ausrichten, dann jede Minute
  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(tick, 60_000);
  }, 60_000 - (Date.now() % 60_000) + 1_000);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
