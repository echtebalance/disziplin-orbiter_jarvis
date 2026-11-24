// Diskussionen unter Kommentaren, Bildtext und Kontext für die KI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getPool, closePool } from '@echte-balance/db';
import { threadStatus, connectAccount, getApiAccount, syncComments, unansweredComments, threadHistory, setImageText } from '../src/comments.ts';
import { getOrCreateAccount } from '../src/snapshots.ts';
import { storeSuggestions, cachedSuggestions, buildMessages } from '../src/ai.ts';
import type { IgComment, MetaClient } from '../src/meta-api.ts';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL fehlt';
after(closePool);

const OWN = 'echte_balance';
const t = (min: number) => new Date(Date.UTC(2026, 10, 18, 10, min)).toISOString();
const reply = (id: string, username: string, text: string, min: number) => ({ id, username, text, timestamp: t(min), fromId: null });
const comment = (replies: ReturnType<typeof reply>[]): IgComment => ({
  id: 'c1', username: 'anna', text: 'Wie oft trainierst du?', timestamp: t(0), fromId: null, replies,
});
const open = (c: IgComment) => threadStatus(c, OWN, '1784').filter((x) => !x.done).map((x) => x.id);

test('Kommentar ohne Antwort ist offen, mit deiner Antwort erledigt', () => {
  assert.deepEqual(open(comment([])), ['c1']);
  assert.deepEqual(open(comment([reply('r1', OWN, '4x pro Woche', 5)])), []);
});

test('Diskussion: neue Antwort nach deiner ist offen, bis du wieder antwortest', () => {
  const thread = [reply('r1', OWN, '4x pro Woche', 5), reply('r2', 'anna', 'Und welcher Split?', 10)];
  assert.deepEqual(open(comment(thread)), ['r2']);
  assert.deepEqual(open(comment([...thread, reply('r3', OWN, 'Push/Pull/Beine', 15)])), []);
});

test('Zwei andere unterhalten sich: nichts zu tun - außer du wirst erwähnt', () => {
  const talk = [reply('r1', 'ben', 'Ich auch 4x!', 5), reply('r2', 'anna', 'Nice', 6)];
  assert.deepEqual(open(comment(talk)), ['c1'], 'nur der ursprüngliche Kommentar');
  const mention = [...talk, reply('r3', 'ben', '@echte_balance was meinst du?', 7)];
  assert.deepEqual(open(comment(mention)), ['c1', 'r3']);
  // @echte_balance_fan ist nicht @echte_balance
  assert.deepEqual(open(comment([reply('r4', 'ben', 'frag @echte_balance_fan', 8)])), ['c1']);
});

test('Prompt enthält Bildtext, volle Caption und Verlauf', () => {
  const caption = 'A'.repeat(700) + ' ENDE';
  const [, user] = buildMessages(
    {
      username: 'anna', text: 'Und welcher Split?', caption, imageText: 'Disziplin schlägt Motivation',
      history: [{ username: 'anna', text: 'Wie oft trainierst du?', own: false }, { username: OWN, text: '4x pro Woche', own: true }],
    },
    null,
  );
  assert.match(user!.content, /<bildtext>\nDisziplin schlägt Motivation/);
  assert.match(user!.content, /ENDE/, 'Caption bis 800 Zeichen bleibt ganz');
  assert.match(user!.content, /ICH: 4x pro Woche/);
  assert.match(user!.content, /Neue Antwort von @anna/);
});

test('Abgleich speichert Diskussionen; Verlauf und Bildtext für die KI', { skip }, async () => {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const cid = Number((await db.query('INSERT INTO core.customers (telegram_user_id) VALUES (999800002) RETURNING id')).rows[0].id);
    const accId = await getOrCreateAccount(db, cid);
    await connectAccount(db, accId, { userId: '1784', username: OWN, accountType: 'BUSINESS' }, 'IGAAx', randomBytes(32), 'instagram', null);
    const client = {
      media: async () => [{ id: 'm1', caption: 'Push Day', timestamp: t(0), permalink: null, commentsCount: 3 }],
      comments: async () => [comment([reply('r1', OWN, '4x pro Woche', 5), reply('r2', 'anna', 'Und welcher Split?', 10)])],
    } as unknown as MetaClient;
    await syncComments(db, (await getApiAccount(db, accId))!, client);

    const list = await unansweredComments(db, accId);
    assert.deepEqual(list.map((c) => [c.commentId, c.parentId]), [['r2', 'c1']]);
    const hist = await threadHistory(db, accId, list[0]!, OWN);
    assert.deepEqual(hist.map((h) => [h.own, h.text]), [[false, 'Wie oft trainierst du?'], [true, '4x pro Woche'], [false, 'Und welcher Split?']]);

    // /status zählt nur echte Kommentare, nicht deine Antworten
    const own = await db.query(`SELECT count(*)::int AS n FROM instagram.comments WHERE account_id = $1 AND username = $2`, [accId, OWN]);
    assert.equal(own.rows[0].n, 1, 'eigene Antwort als Verlauf gespeichert');

    // Bildtext setzen verwirft alte Vorschläge dieses Beitrags
    await storeSuggestions(db, accId, 'r2', 'Und welcher Split?', ['alt']);
    await setImageText(db, accId, 'm1', 'Disziplin schlägt Motivation');
    assert.equal(await cachedSuggestions(db, accId, 'r2', 'Und welcher Split?'), null);
    assert.equal((await unansweredComments(db, accId))[0]?.imageText, 'Disziplin schlägt Motivation');
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});
