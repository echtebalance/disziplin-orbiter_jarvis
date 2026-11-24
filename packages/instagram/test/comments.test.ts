// Abgleich und Auswertungen gegen die lokale Datenbank (zurückgerollt), Meta-API nachgebaut.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { getPool, closePool } from '@echte-balance/db';
import { getOrCreateAccount } from '../src/snapshots.ts';
import {
  apiCallLogger, apiCallStats,
  connectAccount, disconnectAccount, dismissComment, getApiAccount, neglectedCommenters, readToken, snooze, syncComments, topCommenters,
  unansweredComments, unsnooze,
} from '../src/comments.ts';
import type { IgComment, IgMedia, MetaClient } from '../src/meta-api.ts';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL fehlt';
const KEY = randomBytes(32);
const ME = { userId: '1784', username: 'echte_balance', accountType: 'BUSINESS' };

/** Nachgebaute Meta-API mit veränderbarem Zustand; zählt Kommentar-Abrufe */
function fakeClient(media: IgMedia[], comments: Record<string, IgComment[]>) {
  const calls = { comments: 0 };
  const client = {
    kind: 'instagram',
    expiresAt: async () => null,
    me: async () => ME,
    account: async () => ME,
    media: async () => media,
    comments: async (id: string) => {
      calls.comments++;
      return comments[id] ?? [];
    },
    refresh: async () => ({ token: 'IGAAneu', expiresIn: 5183944 }),
  } as MetaClient;
  return { client, calls };
}
const c = (id: string, username: string, text: string, replies: string[] = []): IgComment => ({
  id, username, text, timestamp: '2026-11-17T10:00:00+0000', fromId: null,
  replies: replies.map((u, i) => ({ id: `${id}-r${i}`, username: u, fromId: null, text: 'Danke!', timestamp: '2026-11-17T11:00:00+0000' })),
});
const m = (id: string, n: number, ts = '2026-11-17T09:00:00+0000'): IgMedia => ({ id, caption: 'Push Day', timestamp: ts, permalink: `https://instagram.com/p/${id}`, commentsCount: n });

async function withAccount(fn: (db: pg.PoolClient, accId: number) => Promise<void>) {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    const cust = await db.query('INSERT INTO core.customers (telegram_user_id) VALUES (999500001) RETURNING id');
    const accId = await getOrCreateAccount(db, Number(cust.rows[0].id));
    await connectAccount(db, accId, ME, 'IGAAgeheim', KEY, 'instagram', new Date(Date.now() + 60 * 86_400_000));
    await fn(db, accId);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

after(closePool);

test('Token wird verschlüsselt gespeichert und lässt sich lesen', { skip }, () =>
  withAccount(async (db, accId) => {
    const raw = await db.query('SELECT token_ciphertext, status FROM instagram.accounts WHERE id = $1', [accId]);
    assert.ok(!raw.rows[0].token_ciphertext.includes('IGAAgeheim'));
    assert.equal(raw.rows[0].status, 'active');
    assert.equal(await readToken(db, accId, KEY), 'IGAAgeheim');
  }));

test('Abgleich: unbeantwortet, beantwortet, Emojis, eigene Kommentare', { skip }, () =>
  withAccount(async (db, accId) => {
    const { client } = fakeClient([m('m1', 5)], {
      m1: [
        c('c1', 'anna', 'Wie viele Sätze machst du?'),
        c('c2', 'ben', 'Stark!', ['echte_balance']), // schon beantwortet
        c('c3', 'carla', '🔥🔥🔥'), // nur Emojis
        c('c4', 'echte_balance', 'Danke euch!'), // eigener Kommentar
      ],
    });
    const acc = (await getApiAccount(db, accId))!;
    const r = await syncComments(db, acc, client);
    assert.equal(r.newComments, 3);
    assert.deepEqual((await unansweredComments(db, accId)).map((x) => x.username), ['anna']);
  }));

test('nur Beiträge mit geänderter Kommentarzahl werden neu geladen; Antwort wird erkannt', { skip }, () =>
  withAccount(async (db, accId) => {
    const media = [m('m1', 1), m('m2', 1, '2026-11-16T09:00:00+0000')];
    const comments: Record<string, IgComment[]> = { m1: [c('c1', 'anna', 'Frage?')], m2: [c('c2', 'ben', 'Cool')] };
    const { client, calls } = fakeClient(media, comments);
    const acc = (await getApiAccount(db, accId))!;
    await syncComments(db, acc, client);
    assert.equal(calls.comments, 2);
    await syncComments(db, acc, client);
    assert.equal(calls.comments, 2, 'nichts geändert → keine Kommentar-Abrufe');
    // Kontoinhaber antwortet auf anna → Zahl steigt (Antworten zählen mit)
    media[0] = m('m1', 2);
    comments.m1 = [c('c1', 'anna', 'Frage?', ['echte_balance'])];
    await syncComments(db, acc, client);
    assert.equal(calls.comments, 3);
    assert.deepEqual((await unansweredComments(db, accId)).map((x) => x.username), ['ben']);
  }));

test('/status: Häufigkeit, Ausblenden für einige Tage, Zurückholen', { skip }, () =>
  withAccount(async (db, accId) => {
    const { client } = fakeClient([m('m1', 3), m('m2', 1, '2026-11-16T09:00:00+0000')], {
      m1: [c('a1', 'anna', 'x'), c('a2', 'anna', 'y'), c('b1', 'ben', 'z')],
      m2: [c('a3', 'anna', 'w')],
    });
    await syncComments(db, (await getApiAccount(db, accId))!, client);
    let top = await topCommenters(db, accId, 10);
    assert.deepEqual(top.active.map((x) => [x.username, x.count]), [['anna', 3], ['ben', 1]]);
    assert.deepEqual((await topCommenters(db, accId, 1)).active.map((x) => x.count), [2, 1]); // nur neuester Beitrag
    await snooze(db, accId, 'anna');
    top = await topCommenters(db, accId, 10);
    assert.deepEqual(top.active.map((x) => x.username), ['ben']);
    assert.equal(top.snoozedCount, 1);
    assert.equal(await unsnooze(db, accId, '@Anna'), true);
    assert.equal((await topCommenters(db, accId, 10)).active.length, 2);
  }));

test('Vergessene aktive Kommentierer: nie oder lange nicht zurückkommentiert', { skip }, () =>
  withAccount(async (db, accId) => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const cc = (id: string, u: string) => ({ ...c(id, u, 'Stark'), timestamp: recent });
    const { client } = fakeClient([m('m1', 3), m('m2', 2, '2026-11-16T09:00:00+0000')], {
      m1: [cc('a1', 'anna'), cc('a2', 'anna'), cc('b1', 'ben')],
      m2: [cc('a3', 'anna'), cc('b2', 'ben')],
    });
    await syncComments(db, (await getApiAccount(db, accId))!, client);
    const rules = { minComments: 3, windowDays: 30, afterDays: 14 };
    // anna: 3 Kommentare, nie zurückkommentiert → vergessen; ben: nur 2 → nicht aktiv genug
    assert.deepEqual((await neglectedCommenters(db, accId, rules)).map((r) => r.username), ['anna']);
    // Abgehakt → nicht mehr vergessen
    await snooze(db, accId, 'anna');
    assert.deepEqual(await neglectedCommenters(db, accId, rules), []);
    // Vor 20 Tagen zuletzt abgehakt, Ausblendung längst vorbei → wieder vergessen
    await db.query(`UPDATE instagram.commenter_snooze SET marked_at = now() - interval '20 days', snoozed_until = now() - interval '17 days' WHERE account_id = $1`, [accId]);
    const again = await neglectedCommenters(db, accId, rules);
    assert.equal(again[0]?.username, 'anna');
    assert.ok(again[0]?.marked_at);
    // Zurückholen (unsnooze) löscht den Zeitpunkt nicht
    await snooze(db, accId, 'anna');
    await unsnooze(db, accId, 'anna');
    const row = await db.query('SELECT marked_at FROM instagram.commenter_snooze WHERE account_id = $1', [accId]);
    assert.ok(Date.now() - new Date(row.rows[0].marked_at).getTime() < 60_000);
    // Schwellen lockern: ben (2 Kommentare) zählt bei minComments 2
    assert.deepEqual((await neglectedCommenters(db, accId, { ...rules, minComments: 2 })).map((r) => r.username), ['ben']);
  }));

test('/apicalls: Zählung, Fehler, Auslastung', { skip }, () =>
  withAccount(async (db, accId) => {
    const log = apiCallLogger(db, accId);
    log({ endpoint: 'media', ok: true, error: null, usagePct: 8 });
    log({ endpoint: 'comments', ok: true, error: null, usagePct: null });
    log({ endpoint: 'comments', ok: false, error: 'Rate limit', usagePct: 15 });
    const s = await apiCallStats(db, accId); // gleiche Verbindung → Einträge sind schon geschrieben
    assert.equal(s.last24h, 3);
    assert.equal(s.failed24h, 1);
    assert.deepEqual(s.byEndpoint24h, [{ endpoint: 'comments', n: 2 }, { endpoint: 'media', n: 1 }]);
    assert.equal(s.lastError?.error, 'Rate limit');
    assert.equal(s.usagePct, 15);
    assert.equal((await apiCallStats(db, null)).last24h >= 3, true);
  }));

test('Ignorieren und Trennen', { skip }, () =>
  withAccount(async (db, accId) => {
    const { client } = fakeClient([m('m1', 2)], { m1: [c('c1', 'anna', 'Frage?'), c('c2', 'ben', 'Noch eine?')] });
    await syncComments(db, (await getApiAccount(db, accId))!, client);
    await dismissComment(db, accId, 'c1');
    assert.deepEqual((await unansweredComments(db, accId)).map((x) => x.username), ['ben']);
    await disconnectAccount(db, accId);
    assert.equal(await getApiAccount(db, accId), null);
    const left = await db.query('SELECT count(*)::int AS n FROM instagram.comments WHERE account_id = $1', [accId]);
    assert.equal(left.rows[0].n, 0, 'Kommentardaten gelöscht');
  }));
