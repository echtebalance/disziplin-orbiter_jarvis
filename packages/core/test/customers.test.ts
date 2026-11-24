// Läuft gegen die lokale Datenbank, aber jeder Test in einer Transaktion, die am Ende
// zurückgerollt wird. Es bleiben keine Testdaten zurück. Ohne DATABASE_URL werden die Tests übersprungen.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { getPool, closePool } from '@echte-balance/db';
import {
  createInvite,
  redeemInvite,
  grantModule,
  revokeModule,
  activeModules,
  findCustomer,
  touchCustomer,
  deleteCustomer,
  listOpenInvites,
  generateInviteCode,
  requestAccess,
  getAccessRequest,
  decideAccess,
  requestUnlock,
  decideUnlock,
  hasModule,
  saveMessage,
  markMessageDone,
  openRequests,
} from '../src/customers.ts';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL fehlt';
const tg = (id: number, username = `user${id}`) => ({ id: 900_000_000 + id, username, name: `Test ${id}` });

async function inRollback(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

after(closePool);

test('Einladungscodes sind eindeutig lesbar', () => {
  const code = generateInviteCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
});

test('Einladung einlösen legt Kunden an und schaltet Module frei', { skip }, () =>
  inRollback(async (c) => {
    const invite = await createInvite(c, { note: 'Max', modules: ['instagram_api'], validDays: 30 });
    const r = await redeemInvite(c, invite.code.toLowerCase(), tg(1));
    assert.ok(r.ok);
    assert.deepEqual(await activeModules(c, r.customer.id), ['instagram_api']);
    assert.equal((await listOpenInvites(c)).some((i) => i.code === invite.code), false);
  }));

test('Code ist nur einmal einlösbar, auch nachdem der Kunde gelöscht wurde', { skip }, () =>
  inRollback(async (c) => {
    const invite = await createInvite(c);
    const first = await redeemInvite(c, invite.code, tg(2));
    assert.ok(first.ok);
    assert.deepEqual(await redeemInvite(c, invite.code, tg(3)), { ok: false, reason: 'used' });
    await deleteCustomer(c, first.customer.id);
    assert.deepEqual(await redeemInvite(c, invite.code, tg(3)), { ok: false, reason: 'used' });
  }));

test('unbekannter und abgelaufener Code werden abgelehnt', { skip }, () =>
  inRollback(async (c) => {
    assert.deepEqual(await redeemInvite(c, 'GIBTSNICHT', tg(4)), { ok: false, reason: 'invalid' });
    const old = await createInvite(c, { expiresInDays: -1 });
    assert.deepEqual(await redeemInvite(c, old.code, tg(4)), { ok: false, reason: 'expired' });
  }));

test('bereits registrierter Nutzer kann keinen zweiten Code verbrauchen', { skip }, () =>
  inRollback(async (c) => {
    assert.ok((await redeemInvite(c, (await createInvite(c)).code, tg(5))).ok);
    const second = await createInvite(c);
    assert.deepEqual(await redeemInvite(c, second.code, tg(5)), { ok: false, reason: 'already_registered' });
    assert.equal((await listOpenInvites(c)).some((i) => i.code === second.code), true);
  }));

test('Freischalten, Ablauf und Sperren', { skip }, () =>
  inRollback(async (c) => {
    const r = await redeemInvite(c, (await createInvite(c)).code, tg(6));
    assert.ok(r.ok);
    const id = r.customer.id;
    assert.deepEqual(await activeModules(c, id), []);

    assert.equal(await grantModule(c, id, 'training_plans', null), null); // unbefristet
    await grantModule(c, id, 'instagram_api', 0); // läuft sofort ab
    assert.deepEqual(await activeModules(c, id), ['training_plans']);

    assert.equal(await revokeModule(c, id, 'training_plans'), 1);
    assert.deepEqual(await activeModules(c, id), []);
  }));

test('Kunden finden per @name, Nummer und Telegram-ID; Username wird aktualisiert', { skip }, () =>
  inRollback(async (c) => {
    const r = await redeemInvite(c, (await createInvite(c)).code, tg(7, 'alt'));
    assert.ok(r.ok);
    await touchCustomer(c, tg(7, 'NeuName'));
    assert.equal((await findCustomer(c, '@neuname'))?.id, r.customer.id);
    assert.equal((await findCustomer(c, String(r.customer.id)))?.id, r.customer.id);
    assert.equal((await findCustomer(c, String(tg(7).id)))?.id, r.customer.id);
    assert.equal(await findCustomer(c, 'quatsch'), null);
  }));

test('Zugangsanfragen: eine pro Tag, Nachtrag, Entscheidung nur einmal, Ablehnung sperrt', { skip }, () =>
  inRollback(async (c) => {
    const who = tg(20, 'neugierig');
    assert.equal(await requestAccess(c, who, null), 'created');
    assert.equal(await requestAccess(c, who, null), 'too_soon');
    assert.equal(await requestAccess(c, who, 'Hi, ich trainiere 4x die Woche'), 'updated');
    assert.equal(await requestAccess(c, who, 'noch was'), 'too_soon', 'nur ein Nachtrag');
    assert.equal((await getAccessRequest(c, who.id))?.message, 'Hi, ich trainiere 4x die Woche');
    assert.equal(await decideAccess(c, who.id, true), true);
    assert.equal(await decideAccess(c, who.id, false), false, 'schon entschieden');

    const other = tg(21);
    await requestAccess(c, other, null);
    await decideAccess(c, other.id, false);
    assert.equal(await requestAccess(c, other, 'bitte'), 'declined');
    // Nach über einem Tag darf eine offene, unbeantwortete Anfrage erneuert werden
    const third = tg(22);
    await requestAccess(c, third, null);
    await c.query(`UPDATE core.access_requests SET created_at = now() - interval '2 days' WHERE telegram_user_id = $1`, [third.id]);
    assert.equal(await requestAccess(c, third, null), 'created');
  }));

test('Freischaltungs-Anfragen: eine pro Tag, Freigabe schaltet frei, Ablehnung sperrt', { skip }, () =>
  inRollback(async (c) => {
    const r = await redeemInvite(c, (await createInvite(c)).code, tg(30));
    assert.ok(r.ok);
    const id = r.customer.id;
    assert.equal(await requestUnlock(c, id, 'instagram_api'), 'created');
    assert.equal(await requestUnlock(c, id, 'instagram_api'), 'too_soon');
    assert.equal(await requestUnlock(c, id, 'ai_replies'), 'created', 'pro Modul getrennt');
    assert.equal(await decideUnlock(c, id, 'instagram_api', true), true);
    assert.equal(await decideUnlock(c, id, 'instagram_api', true), false, 'schon entschieden');
    assert.equal(await hasModule(c, id, 'instagram_api'), true);
    assert.equal(await requestUnlock(c, id, 'instagram_api'), 'already');

    assert.equal(await decideUnlock(c, id, 'ai_replies', false), true);
    assert.equal(await hasModule(c, id, 'ai_replies'), false);
    assert.equal(await requestUnlock(c, id, 'ai_replies'), 'declined');
    await c.query(`UPDATE core.unlock_requests SET decided_at = now() - interval '8 days' WHERE customer_id = $1`, [id]);
    assert.equal(await requestUnlock(c, id, 'ai_replies'), 'created', 'nach einer Woche wieder möglich');
  }));

test('Unregistrierte bekommen von touchCustomer null', { skip }, () =>
  inRollback(async (c) => {
    assert.equal(await touchCustomer(c, tg(8)), null);
  }));

test('/anfragen: offene Zugangs-, Freischaltungs-Anfragen und Nachrichten; erledigte verschwinden', { skip }, () =>
  inRollback(async (c) => {
    const base = await openRequests(c); // vorhandene echte Anfragen der lokalen DB nicht mitzählen
    await requestAccess(c, tg(40), 'Hi, ich bin Anna');
    const r = await redeemInvite(c, (await createInvite(c)).code, tg(41));
    assert.ok(r.ok);
    const cid = r.customer.id;
    await requestUnlock(c, cid, 'ai_replies');
    const mid = await saveMessage(c, cid, 'Ich hätte gern einen Recovery-Plan');

    let o = await openRequests(c);
    assert.equal(o.access.length, base.access.length + 1);
    assert.equal(o.access.at(-1)!.message, 'Hi, ich bin Anna');
    assert.deepEqual(o.unlock.filter((u) => u.customerId === cid).map((u) => [u.module, u.who]), [['ai_replies', 'Test 41']]);
    assert.deepEqual(o.messages.filter((m) => m.customerId === cid).map((m) => [m.text, m.username]), [['Ich hätte gern einen Recovery-Plan', 'user41']]);

    assert.equal(await markMessageDone(c, mid), true);
    assert.equal(await markMessageDone(c, mid), false, 'zweimal erledigt');
    await decideAccess(c, tg(40).id, true);
    await decideUnlock(c, cid, 'ai_replies', false);
    o = await openRequests(c);
    assert.equal(o.access.length, base.access.length);
    assert.equal(o.unlock.length, base.unlock.length);
    assert.equal(o.messages.length, base.messages.length);
  }));
