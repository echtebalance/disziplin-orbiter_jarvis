// Training im Kunden-Bot: eigene Pläne mit Zyklus, geführte Einheit (Satz für Satz, Power-Sätze),
// Verlauf, Körpergewicht, Ausdauer. Portiert aus jarvis-satellite/training.js und cardio.js.
import { Composer, InlineKeyboard } from 'grammy';
import { getPool } from '@echte-balance/db';
import { addDays, dd, DAY_NAMES, dowOf, fmtDur, norm, nowIn, parseMinutes, parseTime } from '@echte-balance/planner/time';
import { copyPlan, exerciseProgress, importPlan, planAsText } from '@echte-balance/training/store';
import { findCustomer } from '@echte-balance/core/customers';
import {
  formatPlanText, formatTargets, parsePlanText, PlanTextError, PLAN_TEMPLATE, type PlanText, type TargetSet,
} from '@echte-balance/training/plan-text';
import { withTransaction } from '@echte-balance/db';
import { InputFile } from 'grammy';
import { config } from './config.ts';
import { texts } from './texts.ts';
import { ensurePlanner, findHabit, record } from '@echte-balance/planner/store';
import {
  cycleInfo, ddmm, fmtKg, fmtRows, fmtSet, fmtW, parseKg, parseSets, volume, type SetRow,
} from '@echte-balance/training/parse';
import {
  addCardio, addExercise, bodyKg, cardioDayTotal, createPlan, dayLabel, deleteCardio, deletePlan, deleteExercise,
  deleteSet, ensureTraining, exercises, findPlan, getCardio, getExercise, getPlan, getState, history, insertSets,
  lastSets, listPlans, moveExercise, recentBodyWeights, recentCardio, renameDay, saveBodyWeight, saveSession,
  todayInfo, toggleBodyweight, updateState, type Plan, type Session, type TrainingState,
} from '@echte-balance/training/store';
import { esc, type BotContext } from './context.ts';

export const training = new Composer<BotContext>();

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
export type Send = (text: string, kb?: InlineKeyboard) => Promise<unknown>;
const replier = (ctx: BotContext): Send => (text, kb) => ctx.reply(text, { ...html, reply_markup: kb });
const clearKb = (ctx: BotContext) => ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
const args = (ctx: BotContext) => String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
const DURATIONS = [20, 30, 45, 60, 90];
const uebungen = (n: number) => `${n} ${n === 1 ? 'Übung' : 'Übungen'}`;

async function ctxInfo(ctx: BotContext) {
  const c = ctx.customer!;
  // Planer mit anlegen: Die Trainingsdauer wird dort unter der Aufgabe "training" eingetragen.
  await ensurePlanner(getPool(), c.id);
  const st = await ensureTraining(getPool(), c.id);
  return { cid: c.id, now: nowIn(c.timezone), st };
}

/** Für Planer und Statistik: Ist an diesem Tag laut Zyklus Training? null = kein Zyklus aktiv. */
export async function trainingCalendar(cid: number): Promise<(day: string) => boolean | null> {
  const st = await getState(getPool(), cid);
  const plan = st.active_plan_id ? await getPlan(getPool(), cid, st.active_plan_id) : null;
  if (!plan || !st.cycle_start) return () => null;
  return (day) => cycleInfo(plan, st.cycle_start!, day).train;
}

// ---------- Fortschritt im aktuellen Zyklus ----------

/**
 * Wie gut läuft der aktuelle Zyklus (z. B. 3er Split: 3 Trainingstage + 1 Pause)?
 * Am Pausentag sieht man so, ob man den Zyklus durchgezogen hat. null = kein Plan aktiv.
 */
export async function cycleLine(cid: number, today: string): Promise<string | null> {
  const st = await getState(getPool(), cid);
  const info = await todayInfo(getPool(), cid, st, today);
  if (!info) return null;
  const start = addDays(today, -info.idx);
  const end = addDays(start, info.plan.train_days + info.plan.rest_days - 1);
  const progress = await exerciseProgress(getPool(), cid, start, today);
  let exDone = 0, exPlanned = 0, daysDone = 0, daysDue = 0;
  for (let k = 0; k < info.plan.train_days; k++) {
    const day = addDays(start, k);
    if (day > today) break;
    const planned = (await exercises(getPool(), info.plan.id, k)).length;
    const p = progress.get(day);
    const done = p?.done ?? 0;
    // heute zählt erst mit, wenn schon trainiert wurde
    if (day === today && !done) continue;
    daysDue++;
    if (done) daysDone++;
    exDone += done;
    exPlanned += Math.max(planned, p?.planned ?? 0, done);
  }
  const left = info.plan.train_days - info.idx - (info.train && (progress.get(today)?.done ?? 0) ? 1 : 0);
  const pct = exPlanned ? Math.round((exDone / exPlanned) * 100) : 0;
  const head = `🏋️ <b>Zyklus ${esc(info.plan.name)}</b> (${dd(start)} - ${dd(end)})`;
  if (!daysDue) return `${head}\nNoch kein Trainingstag in diesem Zyklus.`;
  const status = !info.train && daysDone === info.plan.train_days && pct >= 100
    ? '\n😌 Pausentag - Zyklus komplett durchgezogen! 💪'
    : !info.train
      ? `\n😌 Pausentag - ${daysDone}/${info.plan.train_days} Trainingstage geschafft`
      : left > 0 ? `\nNoch ${left} ${left === 1 ? 'Trainingstag' : 'Trainingstage'} in diesem Zyklus` : '';
  return `${head}\n${daysDone}/${daysDue} Trainingstage · ${exDone}/${exPlanned} Übungen · ${pct}%${status}`;
}

// ---------- Geführte Einheit ----------

async function promptText(cid: number, s: Session): Promise<string> {
  const plan = await getPlan(getPool(), cid, s.planId);
  const ex = s.ex[s.i]!;
  const last = await lastSets(getPool(), cid, ex.name, s.day, s.planId);
  const cur = s.log[s.i] ?? [];
  const nr = cur.reduce((a, r) => a + r.sets, 0);
  const kg = ex.bw ? await bodyKg(getPool(), cid, s.day) : 0;
  return (
    `🏋️ <b>${esc(plan ? await dayLabel(getPool(), plan, s.dayIdx) : 'Training')}</b> · Übung ${s.i + 1}/${s.ex.length}\n<b>${esc(ex.name)}</b>\n` +
    (ex.bw ? `🧍 Körpergewichtsübung: nur das <i>Zusatzgewicht</i> eintragen (0 = ohne)\n${kg ? '' : '⚠️ Noch kein Körpergewicht: /gewicht 82,5\n'}` : '') +
    (ex.target?.length ? `📋 Vorgabe: ${esc(formatTargets(ex.target, ex.bw))}\n` : '') +
    (last.length ? `Letztes Mal (${ddmm(last[0]!.day)}): ${fmtRows(last)}\n` : '') +
    (cur.length ? `Heute bisher: ${fmtRows(cur)}\n` : '') +
    `\n➡️ Satz ${nr + 1}: einfach <code>75x8</code> schicken (Gewicht x Wdh.)\n` +
    'Mehrere auf einmal: <code>75x8, 80x8</code> oder <code>60 8 3</code>\n' +
    'Power-Sätze: mit den Pfeilen oder 🔀 zwischen den Übungen wechseln.'
  );
}

/**
 * Vorgabe als eintragbare Sätze; null, wenn nicht eindeutig (kein Gewicht, Sekunden).
 * Wiederholungsbereich "8-12" → untere Grenze.
 */
function targetRows(target: TargetSet[] | null | undefined, bodyweight = false): SetRow[] | null {
  if (!target?.length) return null;
  const rows: SetRow[] = [];
  for (const t of target) {
    const reps = parseInt(t.reps, 10);
    const weight = t.weight ?? (bodyweight ? 0 : null); // KG-Übung ohne Angabe = ohne Zusatzgewicht
    if (weight === null || /s$/.test(t.reps) || !Number.isFinite(reps)) return null;
    const last = rows.at(-1);
    if (last && last.weight === weight && last.reps === reps) last.sets++;
    else rows.push({ weight, reps, sets: 1 });
  }
  return rows;
}

async function promptKb(cid: number, s: Session): Promise<InlineKeyboard> {
  const i = s.i;
  const kb = new InlineKeyboard();
  const logged = (s.log[i] ?? []).length > 0;
  if (!logged && (await lastSets(getPool(), cid, s.ex[i]!.name, s.day, s.planId)).length) kb.text('🔁 Wie letztes Mal', `tr:same:${i}`).row();
  if (!logged && targetRows(s.ex[i]!.target, s.ex[i]!.bw)) kb.text('📋 Wie Vorgabe', `tr:tgt:${i}`).row();
  const n = s.ex.length;
  if (n > 1) {
    const pv = (i + n - 1) % n, nx = (i + 1) % n;
    if (n > 2) kb.text(`⬅️ ${s.ex[pv]!.name}`.slice(0, 24), `tr:go:${pv}`);
    kb.text(`${s.ex[nx]!.name} ➡️`.slice(0, 24), `tr:go:${nx}`).row();
    kb.text('🔀 Auswahl', `tr:sw:${i}`).row();
  }
  if (logged) kb.text('↩️ Letzten Satz löschen', `tr:undo:${i}`).row();
  return kb.text(logged ? '✅ Übung fertig' : '⏭ Überspringen', `tr:skip:${i}`).text('🏁 Beenden', 'tr:end');
}

const sendPrompt = async (cid: number, s: Session, send: Send, intro = '') =>
  send(intro + (await promptText(cid, s)), await promptKb(cid, s));

async function finishPrompt(cid: number, s: Session, send: Send) {
  s.finished = true;
  await saveSession(getPool(), cid, s);
  const h = await findHabit(getPool(), cid, 'training');
  const min = h?.min_min ?? 45, max = h?.max_min ?? 120;
  const mid = Math.round((min + max) / 2 / 5) * 5;
  const kb = new InlineKeyboard();
  [...new Set([min, mid, max])].forEach((v) => kb.text(fmtDur(v), `tr:d:${v}`));
  const n = Object.keys(s.log).length;
  await send(`🎉 <b>Training fertig!</b> ${uebungen(n)} · Volumen ${Math.round(s.vol)} kg\nWie lange hat es gedauert? (oder /log training 75)`, kb);
}

/** Nächste nicht abgeschlossene Übung nach i, sonst null */
const nextOpen = (s: Session, i: number) => {
  for (let k = 1; k < s.ex.length; k++) {
    const j = (i + k) % s.ex.length;
    if (!s.done.includes(j)) return j;
  }
  return null;
};

async function advance(cid: number, s: Session, send: Send) {
  if (!s.done.includes(s.i)) s.done.push(s.i);
  const nxt = nextOpen(s, s.i);
  if (nxt === null) return finishPrompt(cid, s, send);
  s.i = nxt;
  await saveSession(getPool(), cid, s);
  await sendPrompt(cid, s, send);
}

export async function beginSession(cid: number, plan: Plan, dayIdx: number, day: string, send: Send, intro = '') {
  const ex = await exercises(getPool(), plan.id, dayIdx);
  if (!ex.length) {
    await send(
      `${intro}🏋️ <b>${esc(await dayLabel(getPool(), plan, dayIdx))}</b>: im Plan sind noch keine Übungen.\n` +
        `Hinzufügen: /plan add ${dayIdx + 1} Bankdrücken`,
    );
    return;
  }
  const s: Session = {
    day, planId: plan.id, dayIdx, ex: ex.map((e) => ({ name: e.name, bw: e.bodyweight, target: e.target })),
    i: 0, vol: 0, done: [], log: {}, ts: Math.floor(Date.now() / 1000), finished: false,
  };
  await saveSession(getPool(), cid, s);
  await sendPrompt(cid, s, send, intro);
}

/** Vom Planer zur Trainingszeit aufgerufen. true = Einheit gestartet (statt normaler Erinnerung). */
export async function startTrainingIfDue(cid: number, day: string, send: Send): Promise<boolean> {
  const st = await getState(getPool(), cid);
  const info = await todayInfo(getPool(), cid, st, day);
  if (!info?.train || info.dayIdx === null) return false;
  await beginSession(cid, info.plan, info.dayIdx, day, send, '⏰ <b>Training - jetzt dran!</b>\n\n');
  return true;
}

async function saveRows(cid: number, s: Session, rows: SetRow[]) {
  const ex = s.ex[s.i]!;
  const saved = await insertSets(getPool(), cid, s, ex.name, rows);
  (s.log[s.i] ??= []).push(...saved);
  s.vol += volume(rows, ex.bw ? await bodyKg(getPool(), cid, s.day) : 0);
}

// ---------- Anzeige: Plan & Status ----------

async function renderPlan(cid: number, plan: Plan) {
  const kb = new InlineKeyboard();
  let t = `🗂 <b>Trainingsplan: ${esc(plan.name)}</b> (${plan.train_days} Training, ${plan.rest_days} Pause)\n`;
  for (let d = 0; d < plan.train_days; d++) {
    const ex = await exercises(getPool(), plan.id, d);
    const label = await dayLabel(getPool(), plan, d);
    t += `\n<b>${esc(label)}</b> (${ex.length})\n` +
      (ex.length ? ex.map((e, i) => `${i + 1}. ${esc(e.name)}${e.bodyweight ? ' 🧍' : ''}${e.target?.length ? ` · <i>${esc(formatTargets(e.target, e.bodyweight))}</i>` : ''}`).join('\n') : '<i>noch keine Übungen</i>') + '\n';
    kb.text(`📂 ${label}`.slice(0, 30), `tr:pd:${plan.id}:${d}`).row();
  }
  const others = (await listPlans(getPool(), cid)).filter((p) => p.id !== plan.id);
  t += `\nTag öffnen (sortieren, löschen, KG): Button oder /plan tag 1\n` +
    `Hinzufügen: /plan add 1 Bankdrücken · Tag benennen: /plan tag 1 Push\n` +
    (others.length ? `Andere Pläne: ${others.map((p) => `/plan ${esc(norm(p.name).slice(0, 12))}`).join(' · ')}\n` : '') +
    `Neuer Plan: /plan neu Name Trainingstage Pausentage`;
  return { t, kb };
}

async function renderDay(cid: number, plan: Plan, d: number) {
  const ex = await exercises(getPool(), plan.id, d);
  const kb = new InlineKeyboard();
  let t = `🗂 <b>${esc(await dayLabel(getPool(), plan, d))}</b> · ${esc(plan.name)}\n\n` +
    (ex.length ? ex.map((e, i) => `${i + 1}. ${esc(e.name)}${e.bodyweight ? ' 🧍' : ''}${e.target?.length ? ` · <i>${esc(formatTargets(e.target, e.bodyweight))}</i>` : ''}`).join('\n') : '<i>noch keine Übungen</i>');
  ex.forEach((e, i) => {
    const up = i > 0, down = i < ex.length - 1;
    kb.text(up ? `${i + 1} ⬆️` : `${i + 1} ▫️`, up ? `tr:mv:${e.id}:u` : 'tr:nop')
      .text(down ? `${i + 1} ⬇️` : `${i + 1} ▫️`, down ? `tr:mv:${e.id}:d` : 'tr:nop')
      .text(e.bodyweight ? '✅ KG' : '☐ KG', `tr:bd:${e.id}`)
      .text(`🗑 ${i + 1}`, `tr:xd:${e.id}`).row();
  });
  if (plan.train_days > 1) {
    for (let k = 0; k < plan.train_days; k++) kb.text(`${k === d ? '▶️ ' : ''}Tag ${k + 1}`, `tr:pd:${plan.id}:${k}`);
    kb.row();
  }
  kb.text('📋 Übersicht', `tr:pv:${plan.id}`);
  t += `\n\n⬆️/⬇️ verschiebt die Übung, KG = Körpergewichtsübung, 🗑 entfernt sie.\nHinzufügen: /plan add ${d + 1} Bankdrücken`;
  return { t, kb };
}

async function statusText(cid: number, st: TrainingState, day: string) {
  const info = await todayInfo(getPool(), cid, st, day);
  if (!info) {
    const plans = await listPlans(getPool(), cid);
    return (
      '🏋️ Kein Trainingsplan aktiv. Das Training läuft dann nach den Wochentagen aus /time.\n\n' +
      `<b>Deine Pläne:</b>\n${plans.map((p, i) => `${i + 1}. ${esc(p.name)} (${p.train_days}+${p.rest_days})`).join('\n')}\n\n` +
      'Aktivieren: /modus split · /modus recovery · /modus 1'
    );
  }
  const next: string[] = [];
  for (let k = 0; k < 7; k++) {
    const d = addDays(day, k);
    const x = cycleInfo(info.plan, st.cycle_start!, d);
    next.push(`${DAY_NAMES[dowOf(d)]} ${x.train ? (info.plan.train_days > 1 ? `T${x.dayIdx! + 1}` : 'Training') : 'Pause'}`);
  }
  return (
    `🏋️ <b>Plan: ${esc(info.plan.name)}</b>\n` +
    (info.train
      ? `Heute: ${esc(await dayLabel(getPool(), info.plan, info.dayIdx!))} (${uebungen((await exercises(getPool(), info.plan.id, info.dayIdx!)).length)})`
      : 'Heute: Pausentag 😌') +
    `\n\nNächste 7 Tage:\n${next.join(' · ')}` +
    `\n\n${(await cycleLine(cid, day)) ?? ''}`
  );
}

/** Plan aus dem ersten Wort ("split", "recovery", Teil des Namens) oder Nummer; sonst aktiver bzw. erster Plan */
async function pickPlan(cid: number, st: TrainingState, a: string[]): Promise<{ plan: Plan | null; rest: string[] }> {
  const first = a[0] ?? '';
  const byName = first && !/^\d+$/.test(first) && !['add', 'tag', 'neu', 'loeschen', 'löschen', 'import', 'export', 'vorlage', 'geben'].includes(first.toLowerCase())
    ? await findPlan(getPool(), cid, first) : null;
  if (byName) return { plan: byName, rest: a.slice(1) };
  const active = st.active_plan_id ? await getPlan(getPool(), cid, st.active_plan_id) : null;
  return { plan: active ?? (await listPlans(getPool(), cid))[0] ?? null, rest: a };
}

// ---------- Befehle ----------

training.command('modus', async (ctx) => {
  const { cid, now, st } = await ctxInfo(ctx);
  const a = args(ctx);
  if (!a.length) {
    return ctx.reply(
      (await statusText(cid, st, now.day)) +
        '\n\n/modus split [Position] · /modus recovery [Position]\n/modus ausdauer (nur Zeit zählt) · /modus aus',
      html,
    );
  }
  if (a[0]!.toLowerCase() === 'aus') {
    await updateState(getPool(), cid, { active_plan_id: null, cycle_start: null, session: null });
    return ctx.reply('Trainingsplan aus. Das Training läuft wieder nach den Wochentagen aus /time.');
  }
  if (['ausdauer', 'cardio', 'zeit'].includes(a[0]!.toLowerCase())) {
    await updateState(getPool(), cid, { active_plan_id: null, cycle_start: null, session: null });
    const h = await findHabit(getPool(), cid, 'training');
    return ctx.reply(
      '🏃 Ausdauer-Modus: Training zählt jetzt nach <b>Zeit</b>.\n' +
        `100 % = ${h ? fmtDur(h.min_min) : 'Mindestzeit'} pro Trainingstag. Es zählt die eingetragene Trainingszeit oder deine Ausdauer (/add Laufen 45).\n\n` +
        'Trainingstage: /time training 17:30 mo,mi,fr\n100 % ändern: /habit dauer training 1:30 2h\n' +
        'Zurück zum Plan mit Übungen: /modus split',
      html,
    );
  }
  const plans = await listPlans(getPool(), cid);
  const plan = /^\d+$/.test(a[0]!) ? plans[Number(a[0]) - 1] ?? null : await findPlan(getPool(), cid, a[0]);
  if (!plan) return ctx.reply(`Plan nicht gefunden. Deine Pläne:\n${plans.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}\n\n/modus 1 · /modus split`);
  const len = plan.train_days + plan.rest_days;
  const pos = a[1] ? parseInt(a[1], 10) : 1;
  if (!(pos >= 1 && pos <= len)) {
    return ctx.reply(`Position bitte 1 bis ${len}: 1-${plan.train_days} = Trainingstag${plan.rest_days ? `, ${plan.train_days + 1}-${len} = Pause` : ''}.`);
  }
  await updateState(getPool(), cid, { active_plan_id: plan.id, cycle_start: addDays(now.day, -(pos - 1)), session: null });
  const st2 = await getState(getPool(), cid);
  await ctx.reply(`✅ Aktiver Plan: ${esc(plan.name)}\n\n${await statusText(cid, st2, now.day)}\n\nÜbungen anlegen: /plan\nUhrzeit für die Erinnerung: /time training 17:30`, html);
});

training.command('plan', async (ctx) => {
  const { cid, st } = await ctxInfo(ctx);
  const { plan, rest: a } = await pickPlan(cid, st, args(ctx));
  const sub = (a[0] ?? '').toLowerCase();

  // Admin: eigenen Plan als Kopie an einen Nutzer geben - /plan geben @name Planname
  if (sub === 'geben' && ctx.from!.id === config.adminId) {
    const target = a[1] ? await findCustomer(getPool(), a[1].startsWith('#') ? a[1].slice(1) : a[1]) : null;
    const source = a.length > 2 ? await findPlan(getPool(), cid, a.slice(2).join(' ')) : null;
    if (!target || !source) {
      const mine = await listPlans(getPool(), cid);
      return ctx.reply(
        `Nutzung: /plan geben @name Planname\n${!target && a[1] ? `Nutzer ${a[1]} nicht gefunden (/nutzer).\n` : ''}` +
          `Deine Pläne: ${mine.map((p) => p.name).join(', ') || 'keine'}`,
      );
    }
    if (target.id === cid) return ctx.reply('Das bist du selbst.');
    const copy = await withTransaction((c) => copyPlan(c, cid, source.id, target.id));
    const who = target.display_name ?? (target.telegram_username ? '@' + target.telegram_username : `#${target.id}`);
    await ctx.reply(`🎁 „${esc(source.name)}“ als Kopie an ${esc(who)} gegeben. Dein Original bleibt unverändert.`, html);
    await ctx.api
      .sendMessage(
        target.telegram_user_id,
        `🎁 <b>Neuer Trainingsplan für dich: ${esc(copy.name)}</b>\n` +
          `Raffiniert durchdacht von echte BΛLΛNCΣ. Er gehört jetzt dir - passe Übungen, Sätze und Gewichte frei an.\n\n` +
          `Aktivieren: /modus ${esc(norm(copy.name).slice(0, 12))}\nAnsehen: /plan ${esc(norm(copy.name).slice(0, 12))}`,
        html,
      )
      .catch(() => ctx.reply('⚠️ Konnte den Nutzer nicht benachrichtigen (Bot blockiert?). Der Plan ist trotzdem angelegt.'));
    return;
  }
  if (sub === 'vorlage') {
    await ctx.replyWithDocument(new InputFile(Buffer.from(PLAN_TEMPLATE, 'utf8'), 'Trainingsplan.txt'), {
      caption: '📄 Vorlage: anpassen und als Datei zurückschicken. Die Kommentare (#) erklären das Format.',
    });
    return;
  }
  if (sub === 'import') {
    awaitingPlanText.set(cid, Date.now() + 10 * 60_000);
    return ctx.reply(texts.planImportHelp, html);
  }
  if (sub === 'export') {
    if (!plan) return ctx.reply('Noch kein Plan vorhanden.');
    const pt = await planAsText(getPool(), cid, plan.id);
    const fileName = `${plan.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'Trainingsplan'}.txt`;
    await ctx.replyWithDocument(new InputFile(Buffer.from(formatPlanText(pt!), 'utf8'), fileName), {
      caption: `📤 ${plan.name} als Textdatei. Zum Teilen, Sichern oder Bearbeiten und wieder Einspielen.`,
    });
    return;
  }

  if (sub === 'neu') {
    const nums = a.slice(1).filter((x) => /^\d+$/.test(x)).map(Number);
    const name = a.slice(1).filter((x) => !/^\d+$/.test(x)).join(' ').slice(0, 40);
    const [train, rest] = [nums[0] ?? 0, nums[1] ?? 0];
    if (!name || train < 1 || train > 7 || rest > 7) return ctx.reply('Nutzung: /plan neu Name Trainingstage Pausentage\nz. B. /plan neu Push Pull Beine 3 1 oder /plan neu Oberkörper Unterkörper 2 1');
    if ((await listPlans(getPool(), cid)).length >= 10) return ctx.reply('Maximal 10 Pläne. Lösche zuerst einen alten: /plan löschen Name');
    const p = await createPlan(getPool(), cid, name, train, rest);
    const r = await renderPlan(cid, p);
    return ctx.reply(`✅ Plan angelegt. Aktivieren: /modus ${esc(norm(name).slice(0, 12))}\n\n${r.t}`, { ...html, reply_markup: r.kb });
  }
  if (!plan) return ctx.reply('Noch kein Plan vorhanden. Neu: /plan neu Name 3 1');
  if (sub === 'loeschen' || sub === 'löschen') {
    return ctx.reply(`🗑 Plan <b>${esc(plan.name)}</b> mit allen Übungen löschen? Deine eingetragenen Sätze bleiben im Verlauf.`, {
      ...html, reply_markup: new InlineKeyboard().text('🗑 Ja, löschen', `tr:pdel:${plan.id}`).text('Abbrechen', 'tr:cancel'),
    });
  }
  if (!sub) {
    const { t, kb } = await renderPlan(cid, plan);
    return ctx.reply(t, { ...html, reply_markup: kb });
  }
  const dayArg = /^\d+$/.test(sub) && a.length === 1 ? sub : sub === 'tag' && a.length === 2 && /^\d+$/.test(a[1]!) ? a[1]! : null;
  if (dayArg) {
    const d = parseInt(dayArg, 10);
    if (d < 1 || d > plan.train_days) return ctx.reply(`Tag bitte 1 bis ${plan.train_days}.`);
    const r = await renderDay(cid, plan, d - 1);
    return ctx.reply(r.t, { ...html, reply_markup: r.kb });
  }
  if (sub === 'add') {
    let rest = a.slice(1);
    let tag = 1;
    if (/^\d+$/.test(rest[0] ?? '')) {
      tag = parseInt(rest[0]!, 10);
      rest = rest.slice(1);
    }
    const name = rest.join(' ').trim().slice(0, 60);
    if (!name || tag < 1 || tag > plan.train_days) {
      return ctx.reply(`Nutzung: /plan add ${plan.train_days > 1 ? `<Tag 1-${plan.train_days}> ` : ''}Übungsname`);
    }
    if ((await exercises(getPool(), plan.id, tag - 1)).length >= 25) return ctx.reply('Maximal 25 Übungen pro Tag.');
    const pos = await addExercise(getPool(), cid, plan.id, tag - 1, name);
    const r = await renderDay(cid, plan, tag - 1);
    return ctx.reply(`✅ ${esc(name)} hinzugefügt (Platz ${pos}).\n\n${r.t}`, { ...html, reply_markup: r.kb });
  }
  if (sub === 'tag') {
    const tag = parseInt(a[1] ?? '', 10);
    const name = a.slice(2).join(' ').trim().slice(0, 40);
    if (!(tag >= 1 && tag <= plan.train_days) || !name) return ctx.reply('Nutzung: /plan tag 1 Push');
    await renameDay(getPool(), cid, plan.id, tag - 1, name);
    return ctx.reply(`✅ Tag ${tag} heißt jetzt: ${name}`);
  }
  await ctx.reply('Unbekannt. /plan zeigt den Plan, /plan add 1 Bankdrücken, /plan tag 1 Push, /plan neu Name 3 1');
});

training.command('training', async (ctx) => {
  const { cid, now, st } = await ctxInfo(ctx);
  const a = args(ctx);
  const info = await todayInfo(getPool(), cid, st, now.day);
  if (!info) return ctx.reply('Erst einen Plan aktivieren: /modus split oder /modus recovery');
  if (a[0] && /^\d+$/.test(a[0])) {
    const tag = parseInt(a[0], 10);
    if (tag < 1 || tag > info.plan.train_days) return ctx.reply(`Tag bitte 1 bis ${info.plan.train_days}.`);
    return beginSession(cid, info.plan, tag - 1, now.day, replier(ctx));
  }
  const kb = new InlineKeyboard();
  if (st.session && !st.session.finished && st.session.day === now.day) kb.text('▶️ Fortsetzen', 'tr:resume');
  else if (info.train) kb.text('▶️ Training starten', 'tr:start');
  await ctx.reply((await statusText(cid, st, now.day)) + '\n\nAnderen Tag trotzdem starten: /training 2', { ...html, reply_markup: kb });
});

training.command('verlauf', async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const q = String(ctx.match ?? '').trim();
  if (!q) return ctx.reply('Nutzung: /verlauf Bankdrücken');
  const rows = await history(getPool(), cid, q);
  if (!rows.length) return ctx.reply('Keine Einträge gefunden.');
  const best = Math.max(...rows.map((r) => r.weight));
  await ctx.reply(
    `📈 <b>${esc(rows[0]!.exercise)}</b> (letzte ${rows.length})\n` +
      rows.map((r) => `${ddmm(r.day)} · ${fmtSet(r)}`).join('\n') + `\n\nBestes Gewicht darin: ${fmtW(best)}`,
    html,
  );
});

// ---------- Körpergewicht ----------

async function bwText(cid: number, st: TrainingState) {
  const rows = await recentBodyWeights(getPool(), cid);
  let t = '⚖️ <b>Körpergewicht</b>\n';
  if (rows.length) {
    t += rows.map((r) => `${ddmm(r.day)} · ${fmtKg(r.kg)} kg`).join('\n');
    if (rows.length > 1) {
      const d = Math.round((rows[0]!.kg - rows.at(-1)!.kg) * 10) / 10;
      t += `\n\nÄnderung (${rows.length} Einträge): ${d > 0 ? '+' : ''}${fmtKg(d)} kg`;
    }
  } else t += 'Noch kein Eintrag.';
  return t + `\n\nTägliche Abfrage: ${st.bw_ask ? 'an um ' + st.bw_time : 'aus'}\n/gewicht 82,5 · /gewicht zeit 07:30 · /gewicht an · /gewicht aus`;
}

training.command('gewicht', async (ctx) => {
  const { cid, now, st } = await ctxInfo(ctx);
  const a = args(ctx);
  const sub = (a[0] ?? '').toLowerCase();
  if (!sub) return ctx.reply(await bwText(cid, st), html);
  if (sub === 'aus') {
    await updateState(getPool(), cid, { bw_ask: false });
    return ctx.reply('🔕 Tägliche Gewichtsabfrage aus.');
  }
  if (sub === 'an') {
    await updateState(getPool(), cid, { bw_ask: true });
    return ctx.reply(`🔔 Tägliche Abfrage an, um ${st.bw_time}. Uhrzeit ändern: /gewicht zeit 07:30`);
  }
  if (sub === 'zeit') {
    const t = parseTime(a[1]);
    if (!t) return ctx.reply('Nutzung: /gewicht zeit 07:30');
    await updateState(getPool(), cid, { bw_time: t, bw_ask: true });
    return ctx.reply(`🔔 Ich frage täglich um ${t} nach deinem Gewicht.`);
  }
  const kg = parseKg(a.join(' '));
  if (!kg) return ctx.reply('Nutzung: /gewicht 82,5 (zwischen 30 und 300 kg)');
  await saveBodyWeight(getPool(), cid, now.day, kg);
  await ctx.reply(`✅ Körpergewicht heute: ${fmtKg(kg)} kg`);
});

// ---------- Ausdauer (/add) ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const durKb = (id: number) => {
  const kb = new InlineKeyboard();
  DURATIONS.forEach((v) => kb.text(fmtDur(v), `ad:m:${id}:${v}`));
  return kb;
};
const cardioDone = (name: string, minutes: number, day: string, today: string, total: number) =>
  `🏃 <b>${esc(name)}</b>: ${fmtDur(minutes)} eingetragen${day === today ? '' : ` (${ddmm(day)})`}\nAusdauer an dem Tag gesamt: ${fmtDur(total)}`;

training.command('add', async (ctx) => {
  const { cid, now } = await ctxInfo(ctx);
  const t = args(ctx);
  if (t[0]?.toLowerCase() === 'undo') {
    const last = await deleteCardio(getPool(), cid);
    return ctx.reply(last ? `↩️ Gelöscht: ${last.name} ${fmtDur(last.minutes)} (${ddmm(last.day)})` : 'Kein Ausdauer-Eintrag vorhanden.');
  }
  let day = now.day;
  const lastWord = t.at(-1)?.toLowerCase();
  if (lastWord === 'gestern' || lastWord === 'vorgestern') {
    t.pop();
    day = addDays(now.day, lastWord === 'gestern' ? -1 : -2);
  }
  if (!t.length) {
    const rec = await recentCardio(getPool(), cid);
    const kb = new InlineKeyboard();
    rec.forEach((r) => kb.text(`🏃 ${r.name}`.slice(0, 30), `ad:n:${r.id}`).row());
    const tot = await cardioDayTotal(getPool(), cid, now.day);
    return ctx.reply(
      `🏃 <b>Ausdauer eintragen</b>${tot ? ` (heute schon ${fmtDur(tot)})` : ''}\n\n` +
        '/add Radfahren 45\n/add Laufen 1:15\n/add Schwimmen 30 gestern\n/add undo löscht den letzten Eintrag' +
        (rec.length ? '\n\nOder zuletzt genutzt antippen:' : ''),
      { ...html, reply_markup: kb },
    );
  }
  let minutes: number | null = null;
  if (t.length > 1) {
    minutes = parseMinutes(t.at(-1));
    if (minutes !== null) t.pop();
  }
  const name = cap(t.join(' ').slice(0, 40));
  if (minutes === null) {
    const known = (await recentCardio(getPool(), cid)).find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (known) return ctx.reply(`🏃 ${name}: wie lange?`, { reply_markup: durKb(known.id) });
    return ctx.reply(`Wie lange? Beispiel: /add ${name} 45`);
  }
  if (!minutes || minutes > 1440) return ctx.reply('Zeit nicht erkannt. Beispiele: 45, 1:30, 1,5h, 90min');
  const id = await addCardio(getPool(), cid, day, name, minutes);
  await ctx.reply(cardioDone(name, minutes, day, now.day, await cardioDayTotal(getPool(), cid, day)), {
    ...html, reply_markup: new InlineKeyboard().text('↩️ Rückgängig', `ad:u:${id}`),
  });
});

training.callbackQuery(/^ad:n:(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const name = await getCardio(getPool(), cid, Number(ctx.match[1]));
  await ctx.answerCallbackQuery();
  if (name) await ctx.editMessageText(`🏃 <b>${esc(name)}</b>: wie lange?`, { ...html, reply_markup: durKb(Number(ctx.match[1])) }).catch(() => {});
});

training.callbackQuery(/^ad:m:(\d+):(\d+)$/, async (ctx) => {
  const { cid, now } = await ctxInfo(ctx);
  const name = await getCardio(getPool(), cid, Number(ctx.match[1]));
  if (!name) return ctx.answerCallbackQuery({ text: 'Gibt es nicht mehr' });
  const minutes = Math.min(Number(ctx.match[2]), 1440);
  const id = await addCardio(getPool(), cid, now.day, name, minutes);
  await ctx.answerCallbackQuery({ text: `✅ ${fmtDur(minutes)}` });
  await ctx.editMessageText(cardioDone(name, minutes, now.day, now.day, await cardioDayTotal(getPool(), cid, now.day)), {
    ...html, reply_markup: new InlineKeyboard().text('↩️ Rückgängig', `ad:u:${id}`),
  }).catch(() => {});
});

training.callbackQuery(/^ad:u:(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const r = await deleteCardio(getPool(), cid, Number(ctx.match[1]));
  await ctx.answerCallbackQuery({ text: r ? '↩️ Gelöscht' : 'Schon gelöscht' });
  await ctx.editMessageText('↩️ Ausdauer-Eintrag gelöscht.').catch(() => {});
});

// ---------- Freitext: Sätze während der Einheit, Antwort auf die Gewichtsabfrage ----------

training.on('message:text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) return next();
  const { cid, now, st } = await ctxInfo(ctx);
  // Nach /plan import: eingefügter Plantext
  const waitUntil = awaitingPlanText.get(cid);
  if (waitUntil && waitUntil > Date.now()) {
    awaitingPlanText.delete(cid);
    return previewImport(ctx, cid, ctx.message.text, 'Importierter Plan');
  }
  const s = st.session;
  if (s && !s.finished) {
    const parsed = parseSets(ctx.message.text);
    if (!parsed) return ctx.reply('Format: Gewicht x Wiederholungen, z. B. 75x8\nMehrere Sätze: 75x8, 80x8 oder 60 8 3', { reply_markup: await promptKb(cid, s) });
    if ('error' in parsed) return ctx.reply(parsed.error);
    await saveRows(cid, s, parsed.rows);
    s.done = s.done.filter((k) => k !== s.i);
    await saveSession(getPool(), cid, s);
    const nr = s.log[s.i]!.reduce((a, r) => a + r.sets, 0);
    return ctx.reply(`✅ <b>${esc(s.ex[s.i]!.name)}</b>: ${fmtRows(parsed.rows)} (heute ${nr} ${nr === 1 ? 'Satz' : 'Sätze'})\nNächster Satz oder Button:`, {
      ...html, reply_markup: await promptKb(cid, s),
    });
  }
  if (st.bw_pending === now.day) {
    const kg = parseKg(ctx.message.text);
    if (kg) {
      await saveBodyWeight(getPool(), cid, now.day, kg);
      return ctx.reply(`✅ Körpergewicht heute: ${fmtKg(kg)} kg`);
    }
  }
  return next();
});

// ---------- Buttons: Plan bearbeiten ----------

training.callbackQuery('tr:nop', (ctx) => ctx.answerCallbackQuery());
training.callbackQuery('tr:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Abgebrochen.').catch(() => {});
});

async function showDay(ctx: BotContext, cid: number, planId: number, d: number) {
  const plan = await getPlan(getPool(), cid, planId);
  if (!plan || d < 0 || d >= plan.train_days) return;
  const r = await renderDay(cid, plan, d);
  await ctx.editMessageText(r.t, { ...html, reply_markup: r.kb }).catch(() => {});
}

training.callbackQuery(/^tr:pd:(\d+):(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  await ctx.answerCallbackQuery();
  await showDay(ctx, cid, Number(ctx.match[1]), Number(ctx.match[2]));
});

training.callbackQuery(/^tr:pv:(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  await ctx.answerCallbackQuery();
  const plan = await getPlan(getPool(), cid, Number(ctx.match[1]));
  if (!plan) return;
  const { t, kb } = await renderPlan(cid, plan);
  await ctx.editMessageText(t, { ...html, reply_markup: kb }).catch(() => {});
});

training.callbackQuery(/^tr:pdel:(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const plan = await getPlan(getPool(), cid, Number(ctx.match[1]));
  if (!plan || !(await deletePlan(getPool(), cid, plan.id))) return ctx.answerCallbackQuery({ text: 'Gibt es nicht mehr' });
  await ctx.answerCallbackQuery({ text: '🗑 Gelöscht' });
  await ctx.editMessageText(`🗑 Plan ${esc(plan.name)} gelöscht.`, html).catch(() => {});
});

training.callbackQuery(/^tr:mv:(\d+):([ud])$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const ex = await getExercise(getPool(), cid, Number(ctx.match[1]));
  if (!ex) return ctx.answerCallbackQuery({ text: 'Gibt es nicht mehr' });
  const j = await moveExercise(getPool(), cid, ex.id, ctx.match[2] === 'u' ? -1 : 1);
  await ctx.answerCallbackQuery({ text: j === null ? 'Schon am Rand' : `↕️ Jetzt Platz ${j + 1}` });
  await showDay(ctx, cid, ex.plan_id, ex.day_idx);
});

training.callbackQuery(/^tr:xd:(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const ex = await getExercise(getPool(), cid, Number(ctx.match[1]));
  if (!ex) return ctx.answerCallbackQuery({ text: 'Gibt es nicht mehr' });
  await deleteExercise(getPool(), cid, ex.id);
  await ctx.answerCallbackQuery({ text: '🗑 Entfernt' });
  await showDay(ctx, cid, ex.plan_id, ex.day_idx);
});

training.callbackQuery(/^tr:bd:(\d+)$/, async (ctx) => {
  const { cid } = await ctxInfo(ctx);
  const ex = await getExercise(getPool(), cid, Number(ctx.match[1]));
  if (!ex) return ctx.answerCallbackQuery({ text: 'Gibt es nicht mehr' });
  const bw = await toggleBodyweight(getPool(), cid, ex.id);
  await ctx.answerCallbackQuery({ text: bw ? '🧍 Körpergewichtsübung' : 'Normale Übung' });
  await showDay(ctx, cid, ex.plan_id, ex.day_idx);
});

// ---------- Buttons: laufende Einheit ----------

/** Laufende Einheit für Buttons, oder null mit Hinweis */
async function running(ctx: BotContext, idx?: number) {
  const { cid, st } = await ctxInfo(ctx);
  const s = st.session;
  if (!s || s.finished || (idx !== undefined && !s.ex[idx])) {
    await ctx.answerCallbackQuery({ text: 'Keine laufende Einheit' });
    return null;
  }
  return { cid, s };
}

training.callbackQuery(/^tr:undo:(\d+)$/, async (ctx) => {
  const { cid, st } = await ctxInfo(ctx);
  const s = st.session;
  const k = Number(ctx.match[1]);
  if (!s || !s.ex[k]) return ctx.answerCallbackQuery({ text: 'Keine laufende Einheit' });
  const r = (s.log[k] ?? []).pop();
  if (!r) return ctx.answerCallbackQuery({ text: 'Nichts zu löschen' });
  await deleteSet(getPool(), cid, r.id);
  s.vol = Math.max(0, s.vol - volume([r], s.ex[k]!.bw ? await bodyKg(getPool(), cid, s.day) : 0));
  if (!s.log[k]!.length) delete s.log[k];
  s.finished = false;
  s.i = k;
  s.done = s.done.filter((x) => x !== k);
  await saveSession(getPool(), cid, s);
  await ctx.answerCallbackQuery({ text: '↩️ Gelöscht' });
  await clearKb(ctx);
  await sendPrompt(cid, s, replier(ctx), `↩️ Gelöscht: ${esc(fmtSet(r))}\n\n`);
});

training.callbackQuery(/^tr:sw:(\d+)$/, async (ctx) => {
  const r = await running(ctx);
  if (!r) return;
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  r.s.ex.forEach((e, k) => {
    const cnt = (r.s.log[k] ?? []).reduce((a, x) => a + x.sets, 0);
    const mark = k === r.s.i ? '▶️' : r.s.done.includes(k) ? '✅' : cnt ? '🟡' : '⬜';
    kb.text(`${mark} ${k + 1}. ${e.name}${cnt ? ` (${cnt})` : ''}`.slice(0, 40), `tr:go:${k}`).row();
  });
  await ctx.reply('🔀 Zu welcher Übung wechseln? (✅ fertig · 🟡 begonnen · Zahl = Sätze)', { reply_markup: kb });
});

training.callbackQuery(/^tr:go:(\d+)$/, async (ctx) => {
  const k = Number(ctx.match[1]);
  const r = await running(ctx, k);
  if (!r) return;
  r.s.i = k;
  r.s.done = r.s.done.filter((x) => x !== k);
  await saveSession(getPool(), r.cid, r.s);
  await ctx.answerCallbackQuery({ text: `🔄 ${r.s.ex[k]!.name}` });
  await clearKb(ctx);
  await sendPrompt(r.cid, r.s, replier(ctx));
});

training.callbackQuery(/^tr:skip:(\d+)$/, async (ctx) => {
  const r = await running(ctx);
  if (!r) return;
  if (r.s.i !== Number(ctx.match[1])) return ctx.answerCallbackQuery({ text: 'Schon erledigt' });
  await ctx.answerCallbackQuery();
  await clearKb(ctx);
  await advance(r.cid, r.s, replier(ctx));
});

training.callbackQuery(/^tr:same:(\d+)$/, async (ctx) => {
  const r = await running(ctx);
  if (!r) return;
  if (r.s.i !== Number(ctx.match[1])) return ctx.answerCallbackQuery({ text: 'Schon erledigt' });
  const ex = r.s.ex[r.s.i]!;
  const last = await lastSets(getPool(), r.cid, ex.name, r.s.day, r.s.planId);
  if (!last.length) return ctx.answerCallbackQuery({ text: 'Kein letzter Wert vorhanden' });
  await saveRows(r.cid, r.s, last.map((x) => ({ weight: x.weight, reps: x.reps, sets: x.sets })));
  await ctx.answerCallbackQuery({ text: '🔁 Übernommen' });
  await clearKb(ctx);
  await ctx.reply(`✅ ${esc(ex.name)}: ${fmtRows(last)}`, html);
  await advance(r.cid, r.s, replier(ctx));
});

training.callbackQuery('tr:end', async (ctx) => {
  const r = await running(ctx);
  if (!r) return;
  await ctx.answerCallbackQuery();
  await clearKb(ctx);
  await finishPrompt(r.cid, r.s, replier(ctx));
});

training.callbackQuery(/^tr:d:(\d+)$/, async (ctx) => {
  const { cid, now, st } = await ctxInfo(ctx);
  const min = Math.min(Number(ctx.match[1]), 1440);
  const s = st.session;
  const h = await findHabit(getPool(), cid, 'training');
  if (h) await record(getPool(), h.id, s?.day ?? now.day, 'done', min);
  await saveSession(getPool(), cid, null);
  await ctx.answerCallbackQuery({ text: '✅ Eingetragen' });
  const summary = s ? ` · ${uebungen(Object.keys(s.log).length)} · ${Math.round(s.vol)} kg Volumen` : '';
  await ctx.editMessageText(
    h ? `✅ <b>Training</b>: ${fmtDur(min)} eingetragen${summary}` : `✅ Training beendet${summary}\n<i>Im Planer gibt es keine Aufgabe „training“, daher keine Zeit eingetragen.</i>`,
    html,
  ).catch(() => {});
});

training.callbackQuery(/^tr:(start|resume)$/, async (ctx) => {
  const { cid, now, st } = await ctxInfo(ctx);
  await ctx.answerCallbackQuery();
  await clearKb(ctx);
  if (ctx.match[1] === 'resume' && st.session && !st.session.finished) return sendPrompt(cid, st.session, replier(ctx));
  const info = await todayInfo(getPool(), cid, st, now.day);
  if (!info?.train || info.dayIdx === null) return ctx.reply('Heute ist Pause. Trotzdem trainieren: /training 1');
  await beginSession(cid, info.plan, info.dayIdx, now.day, replier(ctx));
});

// ---------- Trainingsplan als .txt einspielen ----------

/** Nach /plan import: nächster Text ist ein Plan (10 Minuten gültig) */
const awaitingPlanText = new Map<number, number>();
/** Geprüfter, noch nicht gespeicherter Plan je Nutzer (bis zur Bestätigung, 30 Minuten) */
const pendingImport = new Map<number, { plan: PlanText; until: number }>();
const MAX_TXT_BYTES = 64 * 1024;

/** Vorschau: so wurde die Datei verstanden; Buttons zum Anlegen, Ersetzen oder Abbrechen */
async function previewImport(ctx: BotContext, cid: number, text: string, fallbackName: string) {
  let p: PlanText;
  try {
    p = parsePlanText(text, fallbackName);
  } catch (err) {
    if (err instanceof PlanTextError) return ctx.reply(`❌ ${esc(err.message)}\n\nVorlage: /plan vorlage`, html);
    throw err;
  }
  pendingImport.set(cid, { plan: p, until: Date.now() + 30 * 60_000 });
  const lines: string[] = [];
  for (const [i, d] of p.days.entries()) {
    lines.push(`\n<b>Tag ${i + 1} - ${esc(d.name)}</b> (${uebungen(d.exercises.length)})`);
    for (const e of d.exercises) {
      const t = formatTargets(e.targets, e.bodyweight);
      lines.push(`• ${esc(e.name)}${e.bodyweight ? ' 🧍' : ''}${t ? `: ${esc(t)}` : ' <i>(ohne Vorgabe)</i>'}`);
    }
  }
  let body = lines.join('\n');
  if (body.length > 3000) body = body.slice(0, 3000) + '\n…';
  const existing = await findPlan(getPool(), cid, p.name);
  const kb = new InlineKeyboard();
  if (existing && norm(existing.name) === norm(p.name)) {
    kb.text(`♻️ „${existing.name}“ ersetzen`.slice(0, 40), `tr:imp:rep:${existing.id}`).row();
    kb.text('➕ Als zusätzlichen Plan', 'tr:imp:new').row();
  } else {
    kb.text('✅ Plan anlegen und aktivieren', 'tr:imp:act').row();
    kb.text('➕ Nur anlegen', 'tr:imp:new').row();
  }
  kb.text('Abbrechen', 'tr:imp:no');
  await ctx.reply(
    `📋 <b>Vorschau: ${esc(p.name)}</b> (${p.trainDays} Trainingstage, ${p.restDays} Pause)\n${body}` +
      (p.warnings.length ? `\n\n⚠️ ${p.warnings.map(esc).join('\n⚠️ ')}` : '') +
      `\n\nStimmt alles? Ersetzen behält deinen Verlauf („Wie letztes Mal“).`,
    { ...html, reply_markup: kb },
  );
}

training.on('message:document', async (ctx, next) => {
  const doc = ctx.message.document;
  const name = doc.file_name ?? '';
  if (!/\.txt$/i.test(name) && doc.mime_type !== 'text/plain') return next();
  const { cid } = await ctxInfo(ctx);
  if ((doc.file_size ?? 0) > MAX_TXT_BYTES) return ctx.reply('Die Datei ist zu groß (max. 64 KB).');
  const file = await ctx.getFile();
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
  if (!res.ok) return ctx.reply('❌ Datei konnte nicht geladen werden. Bitte nochmal schicken.');
  const text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  await previewImport(ctx, cid, text, name.replace(/\.txt$/i, '').replace(/[_-]+/g, ' ').trim() || 'Importierter Plan');
});

training.callbackQuery(/^tr:imp:(new|act|no|rep:(\d+))$/, async (ctx) => {
  const { cid, now } = await ctxInfo(ctx);
  const pending = pendingImport.get(cid);
  await ctx.answerCallbackQuery();
  await clearKb(ctx);
  if (ctx.match[1] === 'no') {
    pendingImport.delete(cid);
    return ctx.reply('Abgebrochen, nichts gespeichert.');
  }
  if (!pending || pending.until < Date.now()) return ctx.reply('Die Vorschau ist abgelaufen. Bitte die Datei nochmal schicken.');
  pendingImport.delete(cid);
  const replaceId = ctx.match[2] ? Number(ctx.match[2]) : undefined;
  if (!replaceId && (await listPlans(getPool(), cid)).length >= 10) return ctx.reply('Maximal 10 Pläne. Lösche zuerst einen: /plan löschen Name');
  const plan = await withTransaction((c) => importPlan(c, cid, pending.plan, replaceId));
  if (ctx.match[1] === 'act') {
    await updateState(getPool(), cid, { active_plan_id: plan.id, cycle_start: now.day, session: null });
  }
  const st = await getState(getPool(), cid);
  const active = st.active_plan_id === plan.id;
  const { t, kb } = await renderPlan(cid, plan);
  await ctx.reply(
    `✅ <b>${esc(plan.name)}</b> ${replaceId ? 'ersetzt' : 'angelegt'}${active ? ' und aktiv (heute = Tag 1)' : ''}.\n` +
      (active ? 'Los geht’s: /training\n\n' : `Aktivieren: /modus ${esc(norm(plan.name).slice(0, 12))}\n\n`) +
      t,
    { ...html, reply_markup: kb },
  );
});

// "📋 Wie Vorgabe": die Vorgabe der Übung als Sätze eintragen
training.callbackQuery(/^tr:tgt:(\d+)$/, async (ctx) => {
  const r = await running(ctx);
  if (!r) return;
  if (r.s.i !== Number(ctx.match[1])) return ctx.answerCallbackQuery({ text: 'Schon erledigt' });
  const ex = r.s.ex[r.s.i]!;
  const rows = targetRows(ex.target, ex.bw);
  if (!rows) return ctx.answerCallbackQuery({ text: 'Keine eintragbare Vorgabe' });
  await saveRows(r.cid, r.s, rows);
  await ctx.answerCallbackQuery({ text: '📋 Vorgabe übernommen' });
  await clearKb(ctx);
  await ctx.reply(`✅ ${esc(ex.name)}: ${fmtRows(rows)}`, html);
  await advance(r.cid, r.s, replier(ctx));
});
