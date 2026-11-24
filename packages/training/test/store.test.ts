// Gegen die lokale Datenbank, jeder Test wird zurückgerollt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { getPool, closePool } from '@echte-balance/db';
import {
  ensureTraining, listPlans, findPlan, addExercise, exercises, moveExercise, getExercise, toggleBodyweight,
  deleteExercise, insertSets, lastSets, history, bodyKg, saveBodyWeight, addCardio, cardioSummary, deleteCardio,
  updateState, getState, todayInfo, importPlan, planAsText, copyPlan, type Session,
} from '../src/store.ts';
import { parsePlanText, formatPlanText, PLAN_TEMPLATE } from '../src/plan-text.ts';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL fehlt';

async function withCustomers(fn: (c: pg.PoolClient, cid: number, other: number) => Promise<void>) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const ids = await c.query('INSERT INTO core.customers (telegram_user_id) VALUES (999300001), (999300002) RETURNING id');
    await fn(c, Number(ids.rows[0].id), Number(ids.rows[1].id));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

after(closePool);

test('Vorlage: zwei leere Pläne, nur einmal angelegt', { skip }, () =>
  withCustomers(async (c, cid) => {
    await ensureTraining(c, cid);
    await ensureTraining(c, cid);
    const plans = await listPlans(c, cid);
    assert.deepEqual(plans.map((p) => [p.name, p.train_days, p.rest_days]), [['3er Split', 3, 1], ['Recovery (Ganzkörper)', 1, 1]]);
    assert.equal((await findPlan(c, cid, 'split'))?.name, '3er Split');
    assert.equal((await findPlan(c, cid, 'recovery'))?.name, 'Recovery (Ganzkörper)');
  }));

test('Übungen anlegen, sortieren, KG umschalten, löschen', { skip }, () =>
  withCustomers(async (c, cid) => {
    await ensureTraining(c, cid);
    const plan = (await findPlan(c, cid, 'split'))!;
    for (const n of ['Bankdrücken', 'Schrägbank', 'Dips']) await addExercise(c, cid, plan.id, 0, n);
    let list = await exercises(c, plan.id, 0);
    assert.deepEqual(list.map((e) => e.name), ['Bankdrücken', 'Schrägbank', 'Dips']);
    assert.equal(await moveExercise(c, cid, list[2]!.id, -1), 1);
    assert.equal(await moveExercise(c, cid, list[0]!.id, -1), null); // schon oben
    list = await exercises(c, plan.id, 0);
    assert.deepEqual(list.map((e) => e.name), ['Bankdrücken', 'Dips', 'Schrägbank']);
    assert.equal(await toggleBodyweight(c, cid, list[1]!.id), true);
    await deleteExercise(c, cid, list[0]!.id);
    assert.equal((await exercises(c, plan.id, 0)).length, 2);
  }));

test('fremde Pläne und Übungen sind nicht erreichbar', { skip }, () =>
  withCustomers(async (c, cid, other) => {
    await ensureTraining(c, cid);
    await ensureTraining(c, other);
    const plan = (await findPlan(c, cid, 'split'))!;
    await addExercise(c, cid, plan.id, 0, 'Kniebeuge');
    const ex = (await exercises(c, plan.id, 0))[0]!;
    assert.equal(await getExercise(c, other, ex.id), null);
    assert.equal(await toggleBodyweight(c, other, ex.id), null);
    await deleteExercise(c, other, ex.id);
    assert.equal(await addExercise(c, other, plan.id, 0, 'Hack'), undefined);
    assert.equal((await exercises(c, plan.id, 0)).length, 1);
  }));

test('Sätze: letzte Einheit, Verlauf, Körpergewicht', { skip }, () =>
  withCustomers(async (c, cid) => {
    await ensureTraining(c, cid);
    const plan = (await findPlan(c, cid, 'split'))!;
    const s = { planId: plan.id, dayIdx: 0 };
    await insertSets(c, cid, { ...s, day: '2026-11-10' }, 'Bankdrücken', [{ weight: 80, reps: 8, sets: 1 }]);
    await insertSets(c, cid, { ...s, day: '2026-11-14' }, 'Bankdrücken', [{ weight: 82.5, reps: 8, sets: 1 }, { weight: 85, reps: 6, sets: 1 }]);
    const last = await lastSets(c, cid, 'bankdrücken', '2026-11-18', plan.id);
    assert.deepEqual(last.map((x) => x.weight), [82.5, 85]);
    assert.equal((await lastSets(c, cid, 'Bankdrücken', '2026-11-14', plan.id))[0]?.weight, 80);
    assert.equal((await history(c, cid, 'bank')).length, 3);
    assert.equal((await history(c, cid, '%')).length, 0, 'Platzhalter werden nicht als Wildcard behandelt');

    assert.equal(await bodyKg(c, cid, '2026-11-18'), 0);
    await saveBodyWeight(c, cid, '2026-11-15', 81.4);
    assert.equal(await bodyKg(c, cid, '2026-11-18'), 81.4);
    assert.equal(await bodyKg(c, cid, '2026-11-14'), 0);
  }));

test('Ausdauer: Zusammenfassung und Rückgängig', { skip }, () =>
  withCustomers(async (c, cid) => {
    await addCardio(c, cid, '2026-11-16', 'Laufen', 30);
    await addCardio(c, cid, '2026-11-17', 'laufen', 45);
    const id = await addCardio(c, cid, '2026-11-17', 'Radfahren', 60);
    let sum = await cardioSummary(c, cid, '2026-11-16', '2026-11-22');
    assert.equal(sum.minutes, 135);
    assert.equal(sum.days, 2);
    assert.deepEqual(sum.byName.map((x) => x.minutes), [75, 60]);
    assert.equal((await deleteCardio(c, cid, id))?.name, 'Radfahren');
    assert.equal((await deleteCardio(c, cid))?.minutes, 45); // letzter Eintrag
    sum = await cardioSummary(c, cid, '2026-11-16', '2026-11-22');
    assert.equal(sum.minutes, 30);
  }));

test('Plan aus Textdatei: anlegen, ersetzen (gleiche ID), exportieren', { skip }, () =>
  withCustomers(async (c, cid) => {
    await ensureTraining(c, cid);
    const p = parsePlanText(PLAN_TEMPLATE);
    const plan = await importPlan(c, cid, p);
    const day1 = await exercises(c, plan.id, 0);
    assert.deepEqual(day1.map((e) => e.name), ['Bankdrücken', 'Schrägbank Kurzhantel', 'Dips', 'Seitheben']);
    assert.deepEqual(day1[0]!.target, [{ weight: 60, reps: '10' }, { weight: 70, reps: '8' }, { weight: 80, reps: '6' }]);
    assert.equal(day1[2]!.bodyweight, true);

    await insertSets(c, cid, { day: '2026-11-18', planId: plan.id, dayIdx: 0 }, 'Bankdrücken', [{ weight: 80, reps: 6, sets: 1 }]);
    const v2 = parsePlanText(PLAN_TEMPLATE.replace('80kg x 6', '85kg x 5'));
    const replaced = await importPlan(c, cid, v2, plan.id);
    assert.equal(replaced.id, plan.id, 'gleiche Plan-ID');
    assert.equal((await exercises(c, plan.id, 0))[0]!.target?.[2]?.weight, 85);
    assert.equal((await lastSets(c, cid, 'Bankdrücken', '2026-11-19', plan.id)).length, 1, 'Verlauf bleibt verknüpft');

    const text = formatPlanText((await planAsText(c, cid, plan.id))!);
    assert.deepEqual(parsePlanText(text).days, v2.days);
  }));

test('Plan weitergeben: Kopie mit Herkunft, Original bleibt unverändert', { skip }, () =>
  withCustomers(async (c, admin, friend) => {
    await ensureTraining(c, admin);
    const original = await importPlan(c, admin, parsePlanText(PLAN_TEMPLATE));
    const copy = await copyPlan(c, admin, original.id, friend);
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.origin_plan_id, original.id);
    assert.equal((await listPlans(c, friend)).some((p) => p.name === 'Push Pull Beine'), true, 'Freund hat den Plan');
    // Freund ändert seine Kopie → Original unverändert
    const ex = (await exercises(c, copy.id, 0))[0]!;
    await deleteExercise(c, friend, ex.id);
    assert.equal((await exercises(c, original.id, 0)).length, 4);
    assert.equal((await exercises(c, copy.id, 0)).length, 3);
    assert.deepEqual((await exercises(c, copy.id, 2))[0]!.target, (await exercises(c, original.id, 2))[0]!.target, 'Vorgaben kopiert');
  }));

test('Zyklus und laufende Einheit im Zustand', { skip }, () =>
  withCustomers(async (c, cid) => {
    await ensureTraining(c, cid);
    const plan = (await findPlan(c, cid, 'split'))!;
    await updateState(c, cid, { active_plan_id: plan.id, cycle_start: '2026-11-16' });
    let st = await getState(c, cid);
    assert.equal((await todayInfo(c, cid, st, '2026-11-18'))?.dayIdx, 2);
    assert.equal((await todayInfo(c, cid, st, '2026-11-19'))?.train, false);

    const session: Session = {
      day: '2026-11-18', planId: plan.id, dayIdx: 2, ex: [{ name: 'Kniebeuge', bw: false }],
      i: 0, vol: 0, done: [], log: {}, ts: Math.floor(Date.now() / 1000), finished: false,
    };
    await updateState(c, cid, { session });
    st = await getState(c, cid);
    assert.equal(st.session?.ex[0]?.name, 'Kniebeuge');
    await updateState(c, cid, { session: { ...session, ts: session.ts - 11 * 3600 } });
    assert.equal((await getState(c, cid)).session, null, 'Einheit nach 10 Stunden abgelaufen');
  }));
