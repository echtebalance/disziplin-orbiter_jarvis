// Planer im Kunden-Bot: Tagesliste, Zeiten eintragen, Aufgaben, Statistik, Termine, Urlaub, freie Tage.
// Portiert aus jarvis-satellite/planner.js, jetzt pro Nutzer und mit einstellbaren Erinnerungen.
import { Composer, InlineKeyboard } from 'grammy';
import { getPool } from '@echte-balance/db';
import { getNotification, setNotification, type NotificationSetting } from '@echte-balance/core/notifications';
import {
  addDays, dayLabel, dayNum, dd, fmtDur, fmtRange, freeLabel, hhmm, InputError, norm, nowIn,
  parseDays, parseFreeDays, parseMinutes, parseTermin, parseTime, toMin, weekLabel, weekStart,
  DAY_NAMES, type LocalNow,
} from '@echte-balance/planner/time';
import {
  addEvent, createHabit, deleteEvent, deleteHabit, deleteLogs, deleteWeekFree, ensurePlanner, eventsFrom,
  findHabit, getHabit, getWeekFree, listHabits, logsBetween, onVacation, pausedDays, record, saveWeekFree,
  updateHabit, updateSettings, workPaused, VACATION_OPEN, type Category, type Habit, type PlannerSettings,
} from '@echte-balance/planner/store';
import {
  applies, computeStats, currentPeriod, previousPeriod, type HabitStat, type StatsResult,
} from '@echte-balance/planner/stats';
import { cardioByDay, cardioSummary, exerciseProgress, type CardioSummary } from '@echte-balance/training/store';
import { esc, type BotContext } from './context.ts';
import { findTemplate, HABIT_CATALOG } from '@echte-balance/planner/habit-catalog';
import { cycleLine, trainingCalendar } from './training.ts';

export const planner = new Composer<BotContext>();

export const CHECK_AFTER = 5; // Rückfrage X Minuten nach Ablauf der Maximalzeit
export const ASK_HOUR = 18; // sonntags: "Wann hast du nächste Woche frei?"
const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

// ---------- Erinnerungs-Einstellungen (Standardwerte) ----------

export const NOTIFY_DEFAULTS: Record<'event_reminder' | 'weekly_report' | 'monthly_report', NotificationSetting> = {
  event_reminder: { enabled: true, localTime: '21:00', options: { minutes_before: 15 } },
  weekly_report: { enabled: true, localTime: '20:00', options: {} }, // samstags
  monthly_report: { enabled: true, localTime: '08:00', options: {} }, // am 1. für den Vormonat
};

// ---------- Kontext ----------

interface P {
  cid: number;
  now: LocalNow;
  s: PlannerSettings;
}
async function p(ctx: BotContext): Promise<P> {
  const c = ctx.customer!;
  return { cid: c.id, now: nowIn(c.timezone), s: await ensurePlanner(getPool(), c.id) };
}
const args = (ctx: BotContext) => String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
const CATEGORY_LABEL: Record<Category, string> = { work: '💼 Arbeit', hustle: '🚀 Side-Hustle', habit: '🌱 Habit' };
const CATEGORY_ALIAS: Record<string, Category> = {
  arbeit: 'work', beruf: 'work', work: 'work',
  hustle: 'hustle', sidehustle: 'hustle', side: 'hustle',
  habit: 'habit', gewohnheit: 'habit',
};

// ---------- Tagesliste ----------

async function todayHabits(cid: number, s: PlannerSettings, day: string): Promise<Habit[]> {
  const paused = await workPaused(getPool(), cid, s, day);
  const trainingDay = await trainingCalendar(cid);
  return (await listHabits(getPool(), cid, true)).filter((h) => applies(h, day, trainingDay) && !(h.category === 'work' && paused));
}

export async function progress(cid: number, s: PlannerSettings, now: LocalNow): Promise<string> {
  const hs = (await todayHabits(cid, s, now.day)).filter((h) => h.counts);
  const done = new Set((await logsBetween(getPool(), cid, now.day, now.day)).filter((l) => l.status === 'done').map((l) => l.habit_id));
  return `${hs.filter((h) => done.has(h.id)).length}/${hs.length}`;
}

async function renderToday({ cid, now, s }: P) {
  const hs = await todayHabits(cid, s, now.day);
  const kb = new InlineKeyboard();
  if (!hs.length) return { text: 'Für heute ist nichts geplant. Aufgaben verwalten: /habit', kb };
  const logs = new Map((await logsBetween(getPool(), cid, now.day, now.day)).map((l) => [l.habit_id, l]));
  const free = await workPaused(getPool(), cid, s, now.day);
  let done = 0, total = 0;
  const lines: string[] = [];
  for (const h of hs) {
    const l = logs.get(h.id);
    if (h.counts) {
      total++;
      if (l?.status === 'done') done++;
    }
    const icon = l ? (l.status === 'done' ? '✅' : '❌') : '⬜';
    lines.push(
      `${icon} <b>${esc(h.label)}</b> (${fmtRange(h.min_min, h.max_min)})` +
        (h.start_time ? ` ⏰ ${h.start_time}` : '') +
        (l?.status === 'done' ? ` · ${fmtDur(l.minutes)}` : ''),
    );
    kb.text(`${l ? '✏️' : '✅'} ${h.label}`.slice(0, 40), `pl:o:${h.id}:l`).row();
  }
  const badge = onVacation(s, now.day) ? ' 🏖 Urlaub' : free ? ' 😌 frei (keine Arbeit)' : '';
  return {
    text:
      `📋 <b>Heute ${dd(now.day)}</b>${badge} · ${done}/${total} erledigt\n\n${lines.join('\n')}\n\n` +
      'Tippe auf eine Aufgabe und wähle die Zeit. Andere Zeit: /log name 45',
    kb,
  };
}


/** Zeit-Buttons: eigene (/habit knöpfe) oder Mindest-, Mittel-, Maximalzeit. c = 'l' (Liste) oder 'r' (Erinnerung) */
export function optionsKb(h: Habit, c: 'l' | 'r') {
  const mid = Math.round((h.min_min + h.max_min) / 2 / 5) * 5;
  const values = h.buttons?.length ? h.buttons : [...new Set([h.min_min, mid, h.max_min])];
  const kb = new InlineKeyboard();
  values.forEach((v, i) => {
    kb.text(fmtDur(v), `pl:m:${h.id}:${v}:${c}`);
    if (i % 3 === 2 && i < values.length - 1) kb.row();
  });
  kb.row().text('❌ Nicht geschafft', `pl:s:${h.id}:${c}`);
  if (c === 'l') kb.text('⬅️ Zurück', 'pl:b');
  return kb;
}

// ---------- Statistik ----------

/** Balken bis 100 %, darüber voll mit 🔥 */
const bar = (pct: number) => {
  const p = Math.max(0, Math.min(100, pct));
  return '▓'.repeat(Math.round(p / 10)) + '░'.repeat(10 - Math.round(p / 10)) + (pct > 100 ? ' 🔥' : '');
};
const pctIcon = (pct: number) => (pct >= 100 ? '✅' : pct >= 50 ? '🟡' : '❌');

function statLine(x: HabitStat, byDay: boolean): string {
  const prefix = x.habit.category === 'hustle' ? '🚀 ' : '';
  if (!x.entered) return `⬜ ${prefix}${esc(x.habit.label)} nicht eingetragen`;
  if (byDay && !x.done) return `❌ ${prefix}${esc(x.habit.label)} nicht geschafft`;
  const pct = x.pct ?? 0;
  const detail =
    x.mode === 'exercises'
      ? `${x.exDone}/${x.exPlanned} Übungen` + (x.done > 1 || !byDay ? ` an ${x.done} ${x.done === 1 ? 'Tag' : 'Tagen'}` : '')
      : `${fmtDur(x.minutes)} von ${fmtDur(x.goalMin)}`;
  return (
    `${pctIcon(pct)} ${prefix}${esc(x.habit.label)} ${bar(pct)} ${pct}% (${detail})` +
    (x.missing ? ` · ${x.missing}× nicht eingetragen` : '') +
    (x.mode !== 'exercises' && x.done && !byDay ? ` · Ø ${fmtDur(Math.round(x.minutes / x.done))}` : '')
  );
}

export function formatStats(title: string, r: StatsResult, cardio?: CardioSummary, extra?: string): string {
  if (!r.planned && !r.missing && !r.timeOnly.length && !cardio?.minutes && !extra) return `📊 <b>${title}</b>\nNoch keine Daten.`;
  let t =
    `📊 <b>${title}</b>\nGesamt: ${r.done}/${r.planned} Tage erledigt · ${r.pct}% ${bar(Math.min(r.pct, 100))}\n` +
    (r.missing ? `${r.missing}× nicht eingetragen\n` : '') +
    `⏱ Gesamtzeit: ${fmtDur(r.totalMinutes)}\n\n${r.rows.map((x) => statLine(x, r.byDay)).join('\n')}`;
  if (extra) t += `\n\n${extra}`;
  if (r.timeOnly.length) {
    t += '\n\n' + r.timeOnly
      .map((x) =>
        x.habit.weekly_goal_min
          ? `💼 ${esc(x.habit.label)} ${bar(x.pct ?? 0)} ${x.pct ?? 0}% (${fmtDur(x.minutes)} von ${fmtDur(x.goalMin)})`
          : `💼 ${esc(x.habit.label)}: ${fmtDur(x.minutes)} an ${x.done} ${x.done === 1 ? 'Tag' : 'Tagen'}` +
            (x.done ? ` · Ø ${fmtDur(Math.round(x.minutes / x.done))}` : ''),
      )
      .join('\n');
  }
  const { work, hustle, habit } = r.minutesByCategory;
  const cardioMin = cardio?.minutes ?? 0;
  const all = work + hustle + habit + cardioMin;
  if (all > 0 && !r.byDay) {
    const row = (name: string, m: number) => `${name} ${fmtDur(m)} · ${Math.round((m / all) * 100)}%`;
    t += `\n\n⚖️ <b>Zeitvergleich</b>\n${row('💼 Arbeit', work)}\n${row('🚀 Side-Hustle', hustle)}\n${row('🌱 Übrige Habits', habit)}` +
      (cardioMin ? `\n${row('🏃 Ausdauer', cardioMin)}` : '');
    if (work && hustle) t += `\nSide-Hustle entspricht ${Math.round((hustle / work) * 100)}% deiner Arbeitszeit.`;
  }
  if (r.vacationDays) t += `\n\n🏖 Urlaubstage: ${r.vacationDays}`;
  if (cardio?.minutes) {
    t += `\n\n🏃 <b>Ausdauer</b>: ${fmtDur(cardio.minutes)} an ${cardio.days} ${cardio.days === 1 ? 'Tag' : 'Tagen'}\n` +
      cardio.byName.map((c) => `   ↳ ${esc(c.name)} ${fmtDur(c.minutes)}${c.n > 1 ? ` (${c.n}×)` : ''}`).join('\n');
  }
  const scored = r.rows.filter((x) => x.pct !== null && x.entered).sort((a, b) => b.pct! - a.pct!);
  if (scored.length >= 2) {
    const best = scored[0]!, worst = scored.at(-1)!;
    t += `\n\n🏆 Beste: ${esc(best.habit.label)} (${best.pct}%) · 🔻 Schwächste: ${esc(worst.habit.label)} (${worst.pct}%)`;
  }
  if (!r.byDay) {
    t += '\n\n<i>Wertung: Zeit im Verhältnis zur Mindestzeit (bzw. zum Wochensoll), Training nach abgeschlossenen Übungen. ' +
      'Einzelne Aufgaben können über 100 % gehen; in der Gesamtquote zählt jede höchstens 100 %. ' +
      'Tage ohne Eintrag zählen als offen, der heutige Tag erst, sobald er eingetragen ist.</i>';
  }
  return t;
}

/** Statistik mit Trainingsfortschritt, Ausdauer und freien Tagen (für Wochensoll) */
export async function statsFor(cid: number, title: string, from: string, to: string, today: string) {
  const s = await ensurePlanner(getPool(), cid);
  const paused = await pausedDays(getPool(), cid, s, weekStart(from), addDays(weekStart(to), 6));
  const r = await computeStats(getPool(), cid, from, to, today, {
    trainingDay: await trainingCalendar(cid),
    pausedDay: (d) => paused.has(d),
    exercisesByDay: await exerciseProgress(getPool(), cid, from, to),
    cardioByDay: await cardioByDay(getPool(), cid, from, to),
  });
  return formatStats(title, r, await cardioSummary(getPool(), cid, from, to), (await cycleLine(cid, today)) ?? undefined);
}

// ---------- Freie Tage ----------

export async function freeKb(cid: number, s: PlannerSettings, ws: string) {
  const cur = (await getWeekFree(getPool(), cid, ws)) ?? s.free_days;
  const kb = new InlineKeyboard();
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => kb.text(`${DAY_NAMES[d]}${cur.includes(d) ? ' ✅' : ''}`, `pl:f:${ws}:${d}`));
  return kb.row().text('✔️ Fertig', `pl:fd:${ws}`);
}

const vacText = (s: PlannerSettings, day: string) =>
  !onVacation(s, day) ? 'aus' : s.vacation_until === VACATION_OPEN ? 'an (unbefristet)' : `an bis einschließlich ${dd(s.vacation_until!)}`;

// ---------- Termine ----------

async function renderEvents(cid: number, now: LocalNow) {
  const rows = (await eventsFrom(getPool(), cid, now.day))
    .filter((e) => e.day > now.day || toMin(e.time) > now.minutes)
    .slice(0, 20);
  const kb = new InlineKeyboard();
  if (!rows.length) return { text: '📅 Keine anstehenden Termine.', kb };
  rows.forEach((e, i) => kb.text(`🗑 ${i + 1}. ${e.title}`.slice(0, 40), `pl:e:${e.id}`).row());
  return {
    text: '📅 <b>Anstehende Termine</b>\n\n' + rows.map((e, i) => `${i + 1}. ${dd(e.day)} ${e.time} - ${esc(e.title)}`).join('\n'),
    kb,
  };
}

async function reminderText(cid: number) {
  const ev = await getNotification(getPool(), cid, 'event_reminder', NOTIFY_DEFAULTS.event_reminder);
  const wk = await getNotification(getPool(), cid, 'weekly_report', NOTIFY_DEFAULTS.weekly_report);
  const mo = await getNotification(getPool(), cid, 'monthly_report', NOTIFY_DEFAULTS.monthly_report);
  const before = Number(ev.options.minutes_before ?? 0);
  return (
    `🔔 <b>Erinnerungen</b>\n\n` +
    `📅 Termine am Vortag: ${ev.enabled ? `um ${ev.localTime}` : 'aus'}\n` +
    `⏰ Termine kurz vorher: ${before ? `${before} Minuten` : 'aus'}\n` +
    `📊 Wochenbericht: ${wk.enabled ? `samstags ${wk.localTime}` : 'aus'}\n` +
    `📊 Monatsbericht: ${mo.enabled ? `am 1. um ${mo.localTime}` : 'aus'}\n` +
    `⏰ Aufgaben: pro Aufgabe mit /time\n\n` +
    `<b>Ändern:</b>\n/erinnerung vortag 21:00 · /erinnerung vortag aus\n` +
    `/erinnerung vorher 15 · /erinnerung vorher aus\n` +
    `/erinnerung bericht 20:00 · /erinnerung bericht aus\n/erinnerung monat an · /erinnerung monat aus`
  );
}

// ---------- Befehle ----------

planner.command('hustle', async (ctx) => {
  const { text, kb } = await renderToday(await p(ctx));
  await ctx.reply(text, { ...html, reply_markup: kb });
});

planner.command('log', async (ctx) => {
  const P = await p(ctx);
  const a = args(ctx);
  const h = await findHabit(getPool(), P.cid, a[0]);
  if (!h || !a[1]) return ctx.reply('Nutzung: /log name Zeit (z. B. /log hustle 1:30, /log arbeit 7:30, /log lesen nein)');
  if (['nein', 'n', 'nix', '0'].includes(a[1].toLowerCase())) {
    await record(getPool(), h.id, P.now.day, 'skipped', 0);
    return ctx.reply(`❌ ${h.label}: als nicht geschafft eingetragen · Heute ${await progress(P.cid, P.s, P.now)}`);
  }
  const m = parseMinutes(a[1]);
  if (!m || m > 1440) return ctx.reply('Zeit nicht erkannt. Beispiele: 45, 1:30, 1,5h, 90min');
  const prev = (await logsBetween(getPool(), P.cid, P.now.day, P.now.day)).find((l) => l.habit_id === h.id);
  const base = prev?.status === 'done' ? prev.minutes : 0;
  const total = Math.min(base + m, 1440);
  await record(getPool(), h.id, P.now.day, 'done', total);
  const prog = await progress(P.cid, P.s, P.now);
  await ctx.reply(
    base
      ? `➕ ${h.label}: +${fmtDur(m)} → heute gesamt ${fmtDur(total)} · Heute ${prog}`
      : `✅ ${h.label}: ${fmtDur(m)} eingetragen · Heute ${prog}`,
  );
});

planner.command('reset', async (ctx) => {
  const P = await p(ctx);
  const a = args(ctx);
  if (!a.length) {
    const logs = await logsBetween(getPool(), P.cid, P.now.day, P.now.day);
    if (!logs.length) return ctx.reply('Heute ist noch nichts eingetragen.');
    const habits = new Map((await listHabits(getPool(), P.cid)).map((h) => [h.id, h]));
    const kb = new InlineKeyboard();
    for (const l of logs) {
      const label = habits.get(l.habit_id)?.label ?? '?';
      kb.text(`↩️ ${label}: ${l.status === 'done' ? fmtDur(l.minutes) : 'nicht geschafft'}`.slice(0, 40), `pl:r:${l.habit_id}`).row();
    }
    kb.text('🧹 Alles von heute', 'pl:ra');
    return ctx.reply('Welchen heutigen Eintrag zurücksetzen? Danach neu eintragen mit /log.', { reply_markup: kb });
  }
  const h = await findHabit(getPool(), P.cid, a[0]);
  if (!h) return ctx.reply('Unbekannte Aufgabe. Nutzung: /reset name · /reset (Auswahl)');
  const n = await deleteLogs(getPool(), P.cid, P.now.day, h.id);
  await ctx.reply(n ? `↩️ ${h.label}: heutiger Eintrag gelöscht. Neu: /log ${h.key} 45` : `${h.label}: heute war nichts eingetragen.`);
});

planner.command('time', async (ctx) => {
  const P = await p(ctx);
  const a = args(ctx);
  if (!a.length) {
    const hs = await listHabits(getPool(), P.cid);
    return ctx.reply(
      '⏰ <b>Zeiten & Erinnerungen</b>\n\n' +
        hs.map((h) =>
          `${h.active ? '' : '💤 '}<b>${esc(h.label)}</b> (<code>${esc(h.key)}</code>) · ${fmtRange(h.min_min, h.max_min)}\n   ` +
          (h.start_time ? `${h.start_time} · ${dayLabel(h.days)} · ${h.remind ? '🔔 an' : '🔕 aus'}` : `keine Uhrzeit · ${dayLabel(h.days)}`),
        ).join('\n') +
        '\n\nSetzen: /time name 19:00 [mo-sa]\nAus/An: /time name aus\nAlle auf einmal: /time alle aus · /time alle an',
      html,
    );
  }
  const all = (a[0] ?? '').toLowerCase();
  const onOff = (a[1] ?? '').toLowerCase();
  if ((all === 'alle' || all === 'all') && (onOff === 'an' || onOff === 'aus')) {
    const on = onOff === 'an';
    const timed = (await listHabits(getPool(), P.cid)).filter((h) => h.start_time);
    if (!timed.length) return ctx.reply('Noch keine Aufgabe hat eine Uhrzeit. Setzen: /time name 19:00');
    const changed = timed.filter((h) => h.remind !== on);
    for (const h of changed) await updateHabit(getPool(), P.cid, h.id, { remind: on });
    const names = timed.map((h) => h.label).join(', ');
    if (!changed.length) return ctx.reply(`${on ? '🔔' : '🔕'} Alle Erinnerungen sind schon ${on ? 'an' : 'aus'} (${names}).`);
    return ctx.reply(
      `${on ? '🔔' : '🔕'} ${changed.length === 1 ? '1 Erinnerung' : `${changed.length} Erinnerungen`} ${on ? 'eingeschaltet' : 'ausgeschaltet'}: ` +
        changed.map((h) => h.label).join(', ') +
        (on ? '' : '\nWieder einschalten: /time alle an'),
    );
  }
  const h = await findHabit(getPool(), P.cid, a[0]);
  if (!h) return ctx.reply('Unbekannte Aufgabe. Übersicht: /time');
  const arg = (a[1] ?? '').toLowerCase();
  if (!arg) return ctx.reply('Nutzung: /time name 19:00 [tage] · /time name aus · /time name an\nTage: täglich, mo-sa, mo,mi,fr, werktags');
  if (arg === 'aus') {
    await updateHabit(getPool(), P.cid, h.id, { remind: false });
    return ctx.reply(`🔕 Erinnerung für ${h.label} ausgeschaltet.`);
  }
  if (arg === 'an') {
    if (!h.start_time) return ctx.reply(`Für ${h.label} ist noch keine Uhrzeit gesetzt: /time ${h.key} 19:00`);
    await updateHabit(getPool(), P.cid, h.id, { remind: true });
    return ctx.reply(`🔔 Erinnerung für ${h.label} eingeschaltet.`);
  }
  let t = parseTime(arg);
  let days = h.days;
  const rest = (t ? a.slice(2) : a.slice(1)).join('');
  if (rest) {
    const d = parseDays(rest);
    if (!d?.length) return ctx.reply('Tage nicht erkannt. Beispiele: täglich, mo-sa, mo,mi,fr, werktags (freie Tage regelt /frei)');
    days = d;
  } else if (!t) return ctx.reply('Uhrzeit nicht erkannt. Beispiel: /time hustle 19:00 mo-sa');
  t = t ?? h.start_time;
  if (!t) return ctx.reply('Bitte auch eine Uhrzeit angeben.');
  await updateHabit(getPool(), P.cid, h.id, { start_time: t, days, remind: true });
  await ctx.reply(
    `✅ ${h.label}: ${t} · ${dayLabel(days)} · 🔔 an\n` +
      `Rückfrage „erledigt?“ um ${hhmm(toMin(t) + h.max_min + CHECK_AFTER)} (${CHECK_AFTER} min nach Ablauf der Maximalzeit ${fmtDur(h.max_min)}).`,
  );
});

planner.command('habit', async (ctx) => {
  const P = await p(ctx);
  const a = args(ctx);
  const sub = (a[0] ?? '').toLowerCase();
  if (sub === 'vorlagen' || sub === 'vorlage' || sub === 'beispiele') {
    const r = await renderTemplates(P.cid);
    return ctx.reply(r.text, { ...html, reply_markup: r.kb });
  }
  if (!sub || sub === 'liste') {
    const hs = await listHabits(getPool(), P.cid);
    const kb = new InlineKeyboard();
    hs.forEach((h) => kb.text(`🗑 ${h.label}`.slice(0, 40), `pl:xq:${h.id}`).row());
    return ctx.reply(
      '🗂 <b>Aufgaben</b>\n\n' +
        hs.map((h) =>
          `${h.active ? '•' : '💤'} <code>${esc(h.key)}</code> - ${esc(h.label)} (${fmtRange(h.min_min, h.max_min)}) · ${CATEGORY_LABEL[h.category]}` +
          (h.weekly_goal_min ? ` · Soll ${fmtDur(h.weekly_goal_min)}/Woche` : '') +
          (h.counts ? '' : ' · nur Zeiterfassung'),
        ).join('\n') +
        '\n\n✨ Fertige Vorlagen mit einem Tipp: /habit vorlagen\n' +
        '/habit neu yoga 10 30 Yoga am Abend\n/habit dauer name 1h 3h (Mindestzeit = 100 %)\n' +
        '/habit woche arbeit 38,5 (Wochensoll in Stunden) · /habit woche arbeit aus\n' +
        '/habit knöpfe arbeit 4h 6h 8h 10h (eigene Zeit-Buttons) · /habit knöpfe arbeit standard\n' +
        '/habit art name arbeit|hustle|habit\n' +
        '/habit aus name · /habit an name\n/habit löschen name (oder 🗑 antippen)',
      { ...html, reply_markup: kb },
    );
  }
  if (sub === 'neu') {
    const key = norm(a[1]).slice(0, 16);
    const min = parseMinutes(a[2]);
    const max = parseMinutes(a[3]);
    const label = a.slice(4).join(' ').slice(0, 60);
    if (!key || min == null || max == null || !label || max < min || max > 1440) {
      return ctx.reply('Nutzung: /habit neu yoga 10 30 Yoga am Abend\n(Schlüssel, Mindestzeit, Maximalzeit, Name)');
    }
    if ((await listHabits(getPool(), P.cid)).length >= 30) return ctx.reply('Maximal 30 Aufgaben. Lösche zuerst eine alte.');
    if (await findHabit(getPool(), P.cid, key).then((h) => h?.key === key)) return ctx.reply('Diesen Schlüssel gibt es schon.');
    await createHabit(getPool(), P.cid, { key, label, min, max });
    return ctx.reply(`✅ ${label} angelegt. Uhrzeit setzen: /time ${key} 19:00\nZählt zum Side-Hustle? /habit art ${key} hustle`);
  }
  const h = await findHabit(getPool(), P.cid, a[1]);
  if (!h) return ctx.reply('Aufgabe nicht gefunden. Liste: /habit');
  if (sub === 'dauer') {
    const min = parseMinutes(a[2]);
    const max = parseMinutes(a[3] ?? a[2]);
    if (min == null || max == null || max < min || max > 1440) return ctx.reply('Nutzung: /habit dauer hustle 1h 3h');
    await updateHabit(getPool(), P.cid, h.id, { min_min: min, max_min: max });
    return ctx.reply(`✅ ${h.label}: ${fmtRange(min, max)}`);
  }
  if (sub === 'woche') {
    const arg = (a[2] ?? '').toLowerCase();
    if (arg === 'aus') {
      await updateHabit(getPool(), P.cid, h.id, { weekly_goal_min: null });
      return ctx.reply(`✅ ${h.label}: kein Wochensoll mehr, 100 % = Mindestzeit pro Tag (${fmtDur(h.min_min)}).`);
    }
    // Stunden ("38,5", "40") oder Zeitangabe ("38:30", "38h30")
    const hours = /^\d+([.,]\d+)?$/.test(arg) ? parseFloat(arg.replace(',', '.')) * 60 : parseMinutes(arg);
    const min = hours == null ? null : Math.round(hours);
    if (!min || min > 10080) return ctx.reply('Nutzung: /habit woche arbeit 38,5 (Stunden pro Woche) · /habit woche arbeit aus');
    await updateHabit(getPool(), P.cid, h.id, { weekly_goal_min: min });
    return ctx.reply(
      `✅ ${h.label}: Wochensoll ${fmtDur(min)}.\nWird auf die Tage verteilt, an denen die Aufgabe dran ist` +
        (h.category === 'work' ? ' (ohne freie Tage und Urlaub).' : '.'),
    );
  }
  if (sub === 'knoepfe' || sub === 'knöpfe' || sub === 'buttons') {
    const rest = a.slice(2);
    if (['standard', 'aus', 'reset'].includes((rest[0] ?? '').toLowerCase())) {
      await updateHabit(getPool(), P.cid, h.id, { buttons: null });
      return ctx.reply(`✅ ${h.label}: Buttons wieder Mindest-, Mittel- und Maximalzeit.`);
    }
    const values = rest.map(parseMinutes);
    if (!values.length || values.length > 6 || values.some((v) => !v || v > 1440)) {
      return ctx.reply('Nutzung: /habit knöpfe arbeit 4h 6h 8h 10h (1 bis 6 Zeiten) · /habit knöpfe arbeit standard');
    }
    const sorted = [...new Set(values as number[])].sort((x, y) => x - y);
    await updateHabit(getPool(), P.cid, h.id, { buttons: sorted });
    return ctx.reply(`✅ ${h.label}: Buttons ${sorted.map(fmtDur).join(' · ')}\nAusprobieren: /hustle`);
  }
  if (sub === 'art') {
    const cat = CATEGORY_ALIAS[norm(a[2])];
    if (!cat) return ctx.reply('Nutzung: /habit art name arbeit|hustle|habit\nArbeit pausiert an freien Tagen und im Urlaub und zählt nicht in die Quote.');
    await updateHabit(getPool(), P.cid, h.id, { category: cat, counts: cat !== 'work' });
    return ctx.reply(`✅ ${h.label}: ${CATEGORY_LABEL[cat]}`);
  }
  if (sub === 'aus' || sub === 'an') {
    await updateHabit(getPool(), P.cid, h.id, { active: sub === 'an' });
    return ctx.reply(`${sub === 'an' ? '✅ aktiv' : '💤 deaktiviert (keine Liste, keine Erinnerung, keine Statistik)'}: ${h.label}`);
  }
  if (['loeschen', 'löschen', 'del', 'rm'].includes(sub)) {
    return ctx.reply(deleteQuestion(h), { ...html, reply_markup: deleteKb(h) });
  }
  await ctx.reply('Unbekannter Unterbefehl. Siehe /habit');
});

const deleteQuestion = (h: Habit) =>
  `🗑 <b>${esc(h.label)}</b> wirklich löschen?\nDie Aufgabe und alle bisherigen Einträge (Statistik) werden entfernt. ` +
  `Nur pausieren geht mit /habit aus ${esc(h.key)}`;
const deleteKb = (h: Habit) => new InlineKeyboard().text('🗑 Ja, löschen', `pl:xd:${h.id}`).text('Abbrechen', 'pl:xc');

planner.command('stats', async (ctx) => {
  const P = await p(ctx);
  const k = norm(ctx.match);
  if (/^(letzt|vor)/.test(k)) {
    const unit = k.includes('woche') ? 'woche' : k.includes('monat') ? 'monat' : k.includes('jahr') ? 'jahr' : null;
    if (!unit) return ctx.reply('Nutzung: /stats vorwoche · /stats vormonat · /stats vorjahr');
    const per = previousPeriod(unit, P.now);
    return ctx.reply(await statsFor(P.cid, per.title, per.from, per.to, P.now.day), html);
  }
  const kind = k.startsWith('w') ? 'woche' : k.startsWith('m') ? 'monat' : k.startsWith('j') ? 'jahr' : 'heute';
  const per = currentPeriod(kind, P.now);
  await ctx.reply(await statsFor(P.cid, per.title, per.from, per.to, P.now.day), html);
});

planner.command('stunden', async (ctx) => {
  const P = await p(ctx);
  const kind = norm(ctx.match)[0] ?? 'w';
  if (!'hwmjg'.includes(kind)) return ctx.reply('Nutzung: /stunden heute | woche | monat | jahr | gesamt');
  const [y, m] = P.now.day.split('-');
  let from: string, to = P.now.day, title: string;
  if (kind === 'h') [from, title] = [P.now.day, `Heute ${dd(P.now.day)}`];
  else if (kind === 'w') [from, title] = [weekStart(P.now.day), `Woche ${dd(weekStart(P.now.day))} - ${dd(P.now.day)}`];
  else if (kind === 'm') [from, title] = [`${y}-${m}-01`, `Monat ${m}/${y}`];
  else if (kind === 'j') [from, title] = [`${y}-01-01`, `Jahr ${y}`];
  else [from, to, title] = ['2000-01-01', '9999-12-31', 'Gesamt'];
  const logs = (await logsBetween(getPool(), P.cid, from, to)).filter((l) => l.status === 'done');
  const cardio = await cardioSummary(getPool(), P.cid, from, to);
  if (!logs.length && !cardio.minutes) return ctx.reply(`⏱ ${title}: noch keine Zeiten eingetragen.`);
  const habits = new Map((await listHabits(getPool(), P.cid)).map((h) => [h.id, h]));
  const sums = new Map<number, { min: number; days: number }>();
  for (const l of logs) {
    const s = sums.get(l.habit_id) ?? { min: 0, days: 0 };
    s.min += l.minutes;
    s.days++;
    sums.set(l.habit_id, s);
  }
  const rows = [...sums.entries()].map(([id, v]) => ({ h: habits.get(id)!, ...v })).filter((r) => r.h).sort((a, b) => b.min - a.min);
  const lines = rows.map((r) =>
    `${r.h.counts ? '•' : '💼'} <b>${esc(r.h.label)}</b>: ${fmtDur(r.min)} · ${r.days} ${r.days === 1 ? 'Tag' : 'Tage'} · Ø ${fmtDur(Math.round(r.min / r.days))}`);
  cardio.byName.forEach((c) =>
    lines.push(`🏃 <b>${esc(c.name)}</b>: ${fmtDur(c.minutes)} · ${c.days} ${c.days === 1 ? 'Tag' : 'Tage'} · Ø ${fmtDur(Math.round(c.minutes / c.days))}`));
  const sum = rows.filter((r) => r.h.counts).reduce((acc, r) => acc + r.min, 0) + cardio.minutes;
  const hustle = rows.filter((r) => r.h.category === 'hustle').reduce((acc, r) => acc + r.min, 0);
  await ctx.reply(
    `⏱ <b>Stunden ${title}</b>\n\n${lines.join('\n')}\n\n` +
      `Summe ohne Arbeit: <b>${fmtDur(sum)}</b>` + (hustle ? ` · davon 🚀 Side-Hustle <b>${fmtDur(hustle)}</b>` : ''),
    html,
  );
});

planner.command('termin', async (ctx) => {
  const P = await p(ctx);
  let ev;
  try {
    ev = parseTermin(String(ctx.match ?? ''), P.now);
  } catch (err) {
    if (err instanceof InputError) return ctx.reply(`❌ ${err.message}`);
    throw err;
  }
  if (!ev) {
    return ctx.reply('Nutzung: /termin Was Datum Uhrzeit\n/termin Physio 20.10. 14:30\n/termin Zahnarzt morgen 9:00\n/termin Hausarzt Mittwoch 08:15');
  }
  await addEvent(getPool(), P.cid, { ...ev, title: ev.title.slice(0, 100) });
  const st = await getNotification(getPool(), P.cid, 'event_reminder', NOTIFY_DEFAULTS.event_reminder);
  const before = Number(st.options.minutes_before ?? 0);
  const parts = [st.enabled && `am Vortag um ${st.localTime}`, before && `${before} min vorher`].filter(Boolean);
  await ctx.reply(
    `📅 Eingetragen: ${ev.title} · ${dd(ev.day)} ${ev.time}\n` +
      (parts.length ? `Erinnerung ${parts.join(' und ')}.` : 'Erinnerungen sind aus.') + ' Ändern: /erinnerung',
  );
});

planner.command('termine', async (ctx) => {
  const P = await p(ctx);
  const { text, kb } = await renderEvents(P.cid, P.now);
  await ctx.reply(text, { ...html, reply_markup: kb });
});

planner.command('erinnerung', async (ctx) => {
  const P = await p(ctx);
  const [what, value] = args(ctx).map((x) => x.toLowerCase());
  const usage = await reminderText(P.cid);
  if (!what) return ctx.reply(usage, html);
  const kind = what === 'vortag' || what === 'vorher' ? 'event_reminder' : what === 'bericht' ? 'weekly_report' : what === 'monat' ? 'monthly_report' : null;
  if (!kind || !value) return ctx.reply(usage, html);
  const cur = await getNotification(getPool(), P.cid, kind, NOTIFY_DEFAULTS[kind]);
  if (what === 'vorher') {
    const mins = value === 'aus' ? 0 : parseMinutes(value);
    if (mins == null || mins > 1440) return ctx.reply('Nutzung: /erinnerung vorher 15 · /erinnerung vorher aus');
    await setNotification(getPool(), P.cid, kind, { ...cur, options: { ...cur.options, minutes_before: mins } });
  } else if (value === 'aus' || value === 'an') {
    await setNotification(getPool(), P.cid, kind, { ...cur, enabled: value === 'an' });
  } else {
    const t = parseTime(value);
    if (!t) return ctx.reply('Uhrzeit nicht erkannt, z. B. 21:00.');
    await setNotification(getPool(), P.cid, kind, { ...cur, enabled: true, localTime: t });
  }
  await ctx.reply(await reminderText(P.cid), html);
});

planner.command('urlaub', async (ctx) => {
  const P = await p(ctx);
  const arg = (args(ctx)[0] ?? '').toLowerCase();
  const off = async () => {
    await updateSettings(getPool(), P.cid, { vacation_until: null });
    return ctx.reply('💼 Urlaubsmodus aus. Arbeit wird wieder aufgezeichnet.');
  };
  if (arg === 'status') return ctx.reply(`🏖 Urlaubsmodus: ${vacText(P.s, P.now.day)}`);
  if (['aus', 'ende', 'stop'].includes(arg)) return off();
  if (!arg) {
    if (onVacation(P.s, P.now.day)) return off();
    await updateSettings(getPool(), P.cid, { vacation_until: VACATION_OPEN });
    return ctx.reply('🏖 Urlaubsmodus an (unbefristet). Keine Arbeits-Aufzeichnung und -Erinnerung. Beenden: /urlaub');
  }
  if (/^\d+$/.test(arg)) {
    const days = parseInt(arg, 10);
    if (days < 1 || days > 365) return ctx.reply('Bitte 1 bis 365 Tage angeben.');
    const until = addDays(P.now.day, days - 1);
    await updateSettings(getPool(), P.cid, { vacation_until: until });
    return ctx.reply(`🏖 Urlaubsmodus für ${days} Tage, bis einschließlich ${dd(until)}. Danach läuft die Arbeit automatisch wieder.`);
  }
  await ctx.reply('Nutzung: /urlaub (an/aus) · /urlaub 14 (14 Tage) · /urlaub status');
});

planner.command('frei', async (ctx) => {
  const P = await p(ctx);
  let t = String(ctx.match ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  let next = false;
  if (['nächste', 'naechste', 'nächsten', 'naechsten'].includes(t[0] ?? '')) {
    next = true;
    t = t.slice(1);
  }
  const cur = weekStart(P.now.day);
  const ws = next || P.now.dow === 0 ? addDays(cur, 7) : cur;
  const wname = ws === cur ? 'Diese Woche' : 'Nächste Woche';
  const sub = t[0];
  const none = ['keine', 'keiner', 'nix'];

  if (!sub) {
    const wk = await getWeekFree(getPool(), P.cid, ws);
    return ctx.reply(
      `🗓 <b>Freie Tage</b>\nFix: ${freeLabel(P.s.free_days)}\n` +
        `${wname} (${weekLabel(ws)}): ${wk ? freeLabel(wk) + ' (nur diese Woche)' : 'wie fix'}\n` +
        `Wöchentliche Frage: ${P.s.ask_weekly ? `an (sonntags ${ASK_HOUR}:00)` : 'aus'}\nUrlaub: ${vacText(P.s, P.now.day)}\n\n` +
        '✅ = frei. Tage antippen zum Ändern, dann „Fertig“.\n/frei fix Sa So · /frei di sa · /frei fragen an',
      { ...html, reply_markup: await freeKb(P.cid, P.s, ws) },
    );
  }
  if (sub === 'fix') {
    const rest = t.slice(1);
    const days = none.includes(rest[0] ?? '') ? [] : parseFreeDays(rest);
    if (!days || (!days.length && !rest.length)) return ctx.reply('Nutzung: /frei fix Sa So · /frei fix keine');
    await updateSettings(getPool(), P.cid, { free_days: days });
    return ctx.reply(`✅ Feste freie Tage: ${freeLabel(days)}\nGilt jede Woche, außer du stellst für eine Woche etwas anderes ein.`);
  }
  if (sub === 'fragen') {
    const on = ['an', 'ein', 'ja'].includes(t[1] ?? '');
    if (!on && !['aus', 'nein'].includes(t[1] ?? '')) return ctx.reply('Nutzung: /frei fragen an · /frei fragen aus');
    await updateSettings(getPool(), P.cid, { ask_weekly: on });
    return ctx.reply(on
      ? `🔔 Ich frage jeden Sonntag um ${ASK_HOUR}:00, wann du nächste Woche frei hast. Ohne Antwort gelten deine festen freien Tage.`
      : '🔕 Wöchentliche Frage aus.');
  }
  if (sub === 'reset') {
    await deleteWeekFree(getPool(), P.cid, ws);
    return ctx.reply(`↩️ ${wname}: Sonderregel entfernt, es gelten wieder die festen freien Tage (${freeLabel(P.s.free_days)}).`);
  }
  const days = none.includes(sub) ? [] : parseFreeDays(t);
  if (!days) return ctx.reply('Tage nicht erkannt. Beispiele: /frei di · /frei Dienstag · /frei Di, Sa · /frei keine · /frei fix Sa So');
  await saveWeekFree(getPool(), P.cid, ws, days);
  await ctx.reply(`✅ ${wname} (${weekLabel(ws)}) frei: ${freeLabel(days)}\nDas ersetzt für diese Woche deine festen freien Tage.`);
});

// ---------- Buttons ----------

const edit = (ctx: BotContext, text: string, kb?: InlineKeyboard) =>
  ctx.editMessageText(text, { ...html, reply_markup: kb }).catch(() => {});

planner.callbackQuery('pl:noop', (ctx) => ctx.answerCallbackQuery());

planner.callbackQuery('pl:b', async (ctx) => {
  await ctx.answerCallbackQuery();
  const { text, kb } = await renderToday(await p(ctx));
  await edit(ctx, text, kb);
});

planner.callbackQuery(/^pl:o:(\d+):([lr])$/, async (ctx) => {
  const P = await p(ctx);
  const h = await getHabit(getPool(), P.cid, Number(ctx.match[1]));
  await ctx.answerCallbackQuery();
  if (!h) return;
  if (ctx.match[2] === 'l') {
    await edit(ctx, `🕒 <b>${esc(h.label)}</b>: Wie lange hast du es gemacht?\nAndere Zeit: /log ${esc(h.key)} 45`, optionsKb(h, 'l'));
  } else await ctx.editMessageReplyMarkup({ reply_markup: optionsKb(h, 'r') }).catch(() => {});
});

async function finish(ctx: BotContext, P: P, c: string, text: string) {
  if (c === 'l') {
    const r = await renderToday(P);
    await edit(ctx, r.text, r.kb);
  } else await edit(ctx, text);
}

planner.callbackQuery(/^pl:m:(\d+):(\d+):([lr])$/, async (ctx) => {
  const P = await p(ctx);
  const h = await getHabit(getPool(), P.cid, Number(ctx.match[1]));
  if (!h) return ctx.answerCallbackQuery();
  const min = Math.min(Number(ctx.match[2]), 1440);
  await record(getPool(), h.id, P.now.day, 'done', min);
  await ctx.answerCallbackQuery({ text: `✅ ${fmtDur(min)} eingetragen` });
  await finish(ctx, P, ctx.match[3]!, `✅ <b>${esc(h.label)}</b>: ${fmtDur(min)} eingetragen · Heute ${await progress(P.cid, P.s, P.now)}`);
});

planner.callbackQuery(/^pl:s:(\d+):([lr])$/, async (ctx) => {
  const P = await p(ctx);
  const h = await getHabit(getPool(), P.cid, Number(ctx.match[1]));
  if (!h) return ctx.answerCallbackQuery();
  await record(getPool(), h.id, P.now.day, 'skipped', 0);
  await ctx.answerCallbackQuery({ text: 'Als nicht geschafft eingetragen' });
  await finish(ctx, P, ctx.match[2]!, `❌ <b>${esc(h.label)}</b>: nicht geschafft · Heute ${await progress(P.cid, P.s, P.now)}`);
});

planner.callbackQuery(/^pl:r:(\d+)$/, async (ctx) => {
  const P = await p(ctx);
  const h = await getHabit(getPool(), P.cid, Number(ctx.match[1]));
  if (!h) return ctx.answerCallbackQuery();
  await deleteLogs(getPool(), P.cid, P.now.day, h.id);
  await ctx.answerCallbackQuery({ text: '↩️ Zurückgesetzt' });
  await edit(ctx, `↩️ ${esc(h.label)}: heutiger Eintrag gelöscht. Neu eintragen: /log ${esc(h.key)} 45`);
});

planner.callbackQuery('pl:ra', async (ctx) => {
  const P = await p(ctx);
  const n = await deleteLogs(getPool(), P.cid, P.now.day);
  await ctx.answerCallbackQuery({ text: '🧹 Heute zurückgesetzt' });
  await edit(ctx, `🧹 ${n} Einträge von heute gelöscht.`);
});

planner.callbackQuery(/^pl:xq:(\d+)$/, async (ctx) => {
  const P = await p(ctx);
  const h = await getHabit(getPool(), P.cid, Number(ctx.match[1]));
  await ctx.answerCallbackQuery();
  if (h) await edit(ctx, deleteQuestion(h), deleteKb(h));
});

planner.callbackQuery(/^pl:xd:(\d+)$/, async (ctx) => {
  const P = await p(ctx);
  const h = await getHabit(getPool(), P.cid, Number(ctx.match[1]));
  if (!h || !(await deleteHabit(getPool(), P.cid, h.id))) return ctx.answerCallbackQuery({ text: 'Gibt es nicht mehr' });
  await ctx.answerCallbackQuery({ text: '🗑 Gelöscht' });
  await edit(ctx, `🗑 ${esc(h.label)} gelöscht.`);
});

planner.callbackQuery('pl:xc', async (ctx) => {
  await ctx.answerCallbackQuery();
  await edit(ctx, 'Abgebrochen.');
});

planner.callbackQuery(/^pl:e:(\d+)$/, async (ctx) => {
  const P = await p(ctx);
  await deleteEvent(getPool(), P.cid, Number(ctx.match[1]));
  await ctx.answerCallbackQuery({ text: '🗑 Termin gelöscht' });
  const { text, kb } = await renderEvents(P.cid, P.now);
  await edit(ctx, text, kb);
});

planner.callbackQuery(/^pl:f:(\d{4}-\d{2}-\d{2}):([0-6])$/, async (ctx) => {
  const P = await p(ctx);
  const ws = ctx.match[1]!;
  if (Math.abs(dayNum(ws) - dayNum(P.now.day)) > 21) return ctx.answerCallbackQuery({ text: 'Diese Woche ist vorbei.' });
  const d = Number(ctx.match[2]);
  const cur = new Set((await getWeekFree(getPool(), P.cid, ws)) ?? P.s.free_days);
  if (cur.has(d)) cur.delete(d);
  else cur.add(d);
  await saveWeekFree(getPool(), P.cid, ws, [...cur]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: await freeKb(P.cid, P.s, ws) }).catch(() => {});
});

planner.callbackQuery(/^pl:fd:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  const P = await p(ctx);
  const ws = ctx.match[1]!;
  const cur = (await getWeekFree(getPool(), P.cid, ws)) ?? P.s.free_days;
  await saveWeekFree(getPool(), P.cid, ws, cur);
  await ctx.answerCallbackQuery({ text: 'Gespeichert' });
  await edit(ctx, `✅ Frei (${weekLabel(ws)}): ${freeLabel(cur)}`);
});

// ---------- Habit-Vorlagen (/habit vorlagen) ----------

async function renderTemplates(cid: number) {
  const have = new Set((await listHabits(getPool(), cid)).map((h) => h.key));
  const kb = new InlineKeyboard();
  HABIT_CATALOG.forEach((t, i) => {
    kb.text(`${have.has(t.key) ? '✅' : t.emoji} ${t.label}`.slice(0, 32), have.has(t.key) ? 'pl:noop' : `pl:hv:${t.key}`);
    if (i % 2 === 1) kb.row();
  });
  return {
    text:
      '✨ <b>Habit-Vorlagen</b>\nTippe an, was du übernehmen willst. ✅ = hast du schon.\n\n' +
      HABIT_CATALOG.map((t) =>
        `${t.emoji} <b>${esc(t.label)}</b> · ${fmtRange(t.min, t.max)}${t.time ? ` · ⏰ ${t.time}` : ''}${t.category === 'hustle' ? ' · 🚀 Side-Hustle' : ''}`,
      ).join('\n') +
      '\n\n<i>Danach frei anpassbar: Dauer (/habit dauer), Uhrzeit (/time), Löschen (/habit).</i>',
    kb,
  };
}

planner.callbackQuery(/^pl:hv:([a-z0-9]{1,20})$/, async (ctx) => {
  const P = await p(ctx);
  const t = findTemplate(ctx.match[1]!);
  if (!t) return ctx.answerCallbackQuery();
  const hs = await listHabits(getPool(), P.cid);
  if (hs.some((h) => h.key === t.key)) return ctx.answerCallbackQuery({ text: 'Hast du schon ✅' });
  if (hs.length >= 30) return ctx.answerCallbackQuery({ text: 'Maximal 30 Aufgaben', show_alert: true });
  const h = await createHabit(getPool(), P.cid, { key: t.key, label: t.label, min: t.min, max: t.max, category: t.category });
  if (t.time || t.days) await updateHabit(getPool(), P.cid, h.id, { start_time: t.time ?? null, days: t.days ?? h.days, remind: !!t.time });
  await ctx.answerCallbackQuery({ text: `${t.emoji} ${t.label} übernommen` });
  const r = await renderTemplates(P.cid);
  await edit(ctx, r.text + `\n\n✅ <b>${esc(t.label)}</b> ist jetzt in /hustle` + (t.time ? ` (Erinnerung ${t.time}, ändern: /time ${t.key} 10:00 oder /time ${t.key} aus)` : ''), r.kb);
});
