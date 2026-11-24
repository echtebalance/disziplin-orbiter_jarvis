// Gegen die lokale Datenbank, jeder Test wird zurückgerollt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { getPool, closePool } from '@echte-balance/db';
import {
  ensurePlanner, listHabits, findHabit, record, createHabit, updateHabit, deleteLogs, getHabit,
  saveWeekFree, updateSettings, workPaused, getSettings, VACATION_OPEN,
} from '../src/store.ts';
import { computeStats } from '../src/stats.ts';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL fehlt';

async function withCustomer(fn: (c: pg.PoolClient, cid: number) => Promise<void>, tgId = 999100001) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('INSERT INTO core.customers (telegram_user_id) VALUES ($1) RETURNING id', [tgId]);
    await fn(c, Number(r.rows[0].id));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

after(closePool);

test('erster Aufruf legt Vorlage an, zweiter nicht erneut', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    const first = await listHabits(c, cid);
    assert.deepEqual(first.map((h) => h.key), ['arbeit', 'sidehustle', 'training', 'lesen']);
    await c.query('DELETE FROM planner.habits WHERE customer_id = $1', [cid]);
    await ensurePlanner(c, cid);
    assert.equal((await listHabits(c, cid)).length, 0, 'gelöschte Vorlage kommt nicht zurück');
  }));

test('Aufgaben suchen per Schlüssel, Name und Anfang', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    assert.equal((await findHabit(c, cid, 'hus'))?.key, undefined); // "hus" ist kein Anfang von "sidehustle"
    assert.equal((await findHabit(c, cid, 'side'))?.key, 'sidehustle');
    assert.equal((await findHabit(c, cid, 'Arbeit (Beruf)'))?.key, 'arbeit');
  }));

test('fremde Aufgaben sind nicht erreichbar', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    const other = await c.query('INSERT INTO core.customers (telegram_user_id) VALUES (999100002) RETURNING id');
    const otherId = Number(other.rows[0].id);
    const mine = (await listHabits(c, cid))[0]!;
    assert.equal(await getHabit(c, otherId, mine.id), null);
    await updateHabit(c, otherId, mine.id, { label: 'gehackt' });
    assert.equal((await getHabit(c, cid, mine.id))?.label, mine.label);
  }));

test('Statistik: Quote nach Mindestzeit, Ausgleich zwischen Tagen, nicht eingetragene Tage', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    await c.query('DELETE FROM planner.habits WHERE customer_id = $1', [cid]);
    const h = await createHabit(c, cid, { key: 'hustle', label: 'Hustle', min: 60, max: 120, category: 'hustle' });
    // Mo 16.11. 90 min, Di 30 min, Mi nicht eingetragen, Do (heute) noch offen
    await record(c, h.id, '2026-11-16', 'done', 90);
    await record(c, h.id, '2026-11-17', 'done', 30);
    const r = await computeStats(c, cid, '2026-11-16', '2026-11-19', '2026-11-19');
    const row = r.rows[0]!;
    assert.equal(row.planned, 3); // Mo, Di, Mi (heute zählt erst mit Eintrag)
    assert.equal(row.missing, 1);
    assert.equal(row.minutes, 120);
    assert.equal(row.pct, Math.round((120 / 180) * 100)); // 67 %
    assert.equal(r.minutesByCategory.hustle, 120);
  }));

test('Statistik: Arbeit zählt nicht in die Quote, aber in den Zeitvergleich', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    const work = (await findHabit(c, cid, 'arbeit'))!;
    await record(c, work.id, '2026-11-16', 'done', 480);
    const r = await computeStats(c, cid, '2026-11-16', '2026-11-16', '2026-11-16');
    assert.equal(r.rows.some((x) => x.habit.id === work.id), false);
    assert.equal(r.timeOnly[0]?.minutes, 480);
    assert.equal(r.minutesByCategory.work, 480);
  }));

test('Arbeit pausiert an freien Tagen und im Urlaub', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    await updateSettings(c, cid, { free_days: [0, 6] });
    let s = await getSettings(c, cid);
    assert.equal(await workPaused(c, cid, s, '2026-11-21'), true); // Samstag
    assert.equal(await workPaused(c, cid, s, '2026-11-18'), false); // Mittwoch
    await saveWeekFree(c, cid, '2026-11-16', [3]); // nur diese Woche: Mittwoch frei, Samstag nicht
    assert.equal(await workPaused(c, cid, s, '2026-11-18'), true);
    assert.equal(await workPaused(c, cid, s, '2026-11-21'), false);
    await updateSettings(c, cid, { vacation_until: VACATION_OPEN });
    s = await getSettings(c, cid);
    assert.equal(await workPaused(c, cid, s, '2026-11-19'), true);
  }));

test('Über 100 % wird angezeigt, zählt in der Gesamtquote aber nur bis 100 %', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    await c.query('DELETE FROM planner.habits WHERE customer_id = $1', [cid]);
    const a = await createHabit(c, cid, { key: 'a', label: 'A', min: 60, max: 120 });
    const b = await createHabit(c, cid, { key: 'b', label: 'B', min: 60, max: 120 });
    await record(c, a.id, '2026-11-16', 'done', 120); // 200 %
    await record(c, b.id, '2026-11-16', 'skipped', 0); // 0 %
    const r = await computeStats(c, cid, '2026-11-16', '2026-11-16', '2026-11-16');
    assert.deepEqual(r.rows.map((x) => x.pct), [200, 0]);
    assert.equal(r.pct, 50, '200 % gleicht 0 % nicht aus');
  }));

test('Wochensoll: auf Arbeitstage verteilt, freie Tage zählen nicht', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    const work = (await findHabit(c, cid, 'arbeit'))!;
    await updateHabit(c, cid, work.id, { weekly_goal_min: 40 * 60 });
    const paused = new Set(['2026-11-21', '2026-11-22']); // Sa, So frei → 5 Arbeitstage, 8 h/Tag
    await record(c, work.id, '2026-11-16', 'done', 600); // Mo 10 h
    await record(c, work.id, '2026-11-17', 'done', 360); // Di 6 h
    const day = await computeStats(c, cid, '2026-11-16', '2026-11-16', '2026-11-16', { pausedDay: (d) => paused.has(d) });
    assert.equal(day.timeOnly[0]?.goalMin, 480);
    assert.equal(day.timeOnly[0]?.pct, 125);
    const week = await computeStats(c, cid, '2026-11-16', '2026-11-17', '2026-11-17', { pausedDay: (d) => paused.has(d) });
    assert.equal(week.timeOnly[0]?.goalMin, 960);
    assert.equal(week.timeOnly[0]?.pct, 100);
    assert.equal(week.rows.some((x) => x.habit.id === work.id), false, 'Arbeit bleibt außerhalb der Quote');
  }));

test('Training: nach Übungen, an reinen Ausdauertagen nach Zeit', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    const tr = (await findHabit(c, cid, 'training'))!;
    await updateHabit(c, cid, tr.id, { min_min: 90, max_min: 120, days: [1, 2, 3] }); // Mo, Di, Mi
    const exercisesByDay = new Map([['2026-11-16', { done: 4, planned: 5 }]]); // Mo 4/5 Übungen
    const cardioByDay = new Map([['2026-11-17', 45]]); // Di nur 45 min Laufen, Mi nichts
    const opts = { exercisesByDay, cardioByDay };
    const trRow = (r: Awaited<ReturnType<typeof computeStats>>) => r.rows.find((x) => x.habit.id === tr.id)!;
    const mo = await computeStats(c, cid, '2026-11-16', '2026-11-16', '2026-11-16', opts);
    assert.equal(trRow(mo).mode, 'exercises');
    assert.equal(trRow(mo).pct, 80);
    const di = await computeStats(c, cid, '2026-11-17', '2026-11-17', '2026-11-17', opts);
    assert.equal(trRow(di).pct, 50); // 45 von 90 min
    // "heute" = Donnerstag, damit der Mittwoch ohne Eintrag als offen zählt
    const week = await computeStats(c, cid, '2026-11-16', '2026-11-18', '2026-11-19', { ...opts });
    const row = trRow(week);
    assert.equal(row.planned, 3);
    assert.equal(row.missing, 1); // Mittwoch
    assert.equal(row.pct, Math.round(((0.8 + 0.5 + 0) / 3) * 100)); // 43 %
    assert.equal(row.exDone, 4);
  }));

test('Zurücksetzen löscht nur eigene Einträge des Tages', { skip }, () =>
  withCustomer(async (c, cid) => {
    await ensurePlanner(c, cid);
    const [a, b] = await listHabits(c, cid);
    await record(c, a!.id, '2026-11-18', 'done', 30);
    await record(c, b!.id, '2026-11-18', 'skipped', 0);
    await record(c, b!.id, '2026-11-17', 'done', 60);
    assert.equal(await deleteLogs(c, cid, '2026-11-18', a!.id), 1);
    assert.equal(await deleteLogs(c, cid, '2026-11-18'), 1);
    assert.equal(await deleteLogs(c, cid, '2026-11-17'), 1);
  }));
