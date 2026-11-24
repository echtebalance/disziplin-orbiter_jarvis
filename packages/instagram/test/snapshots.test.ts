// Gegen die lokale Datenbank, jeder Test wird zurückgerollt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { getPool, closePool } from '@echte-balance/db';
import {
  getOrCreateAccount,
  importSnapshot,
  openNonFollowers,
  unfollowCandidates,
  followerChanges,
  markCleanup,
  undoCleanup,
  unfollowedToday,
  cleanupStats,
  savePending,
  takePending,
  KEEP_SNAPSHOTS,
} from '../src/snapshots.ts';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL fehlt';
const list = (...names: string[]) => names.map((username) => ({ username, followedAt: null }));

async function withAccount(fn: (c: pg.PoolClient, accountId: number) => Promise<void>) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const cust = await c.query('INSERT INTO core.customers (telegram_user_id) VALUES (999000001) RETURNING id');
    await fn(c, await getOrCreateAccount(c, Number(cust.rows[0].id)));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

after(closePool);

test('erster Import: Nicht-Follower, noch kein Vergleich', { skip }, () =>
  withAccount(async (c, acc) => {
    const r = await importSnapshot(c, acc, list('a', 'b', 'c'), list('b', 'c', 'd', 'e'));
    assert.deepEqual(r, { followers: 3, following: 4, hasPrevious: false, newFollowers: 0, lostFollowers: 0, stillFollowingMarked: 0 });
    assert.deepEqual((await openNonFollowers(c, acc)).map((n) => n.username), ['d', 'e']);
    assert.equal(await followerChanges(c, acc, 'lost'), null);
  }));

test('zweiter Import erkennt Unfollower und neue Follower', { skip }, () =>
  withAccount(async (c, acc) => {
    await importSnapshot(c, acc, list('a', 'b', 'c'), list('b', 'c'));
    const r = await importSnapshot(c, acc, list('a', 'c', 'f'), list('c', 'f'));
    assert.equal(r.lostFollowers, 1);
    assert.equal(r.newFollowers, 1);
    assert.deepEqual((await followerChanges(c, acc, 'lost'))?.usernames, ['b']);
    assert.deepEqual((await followerChanges(c, acc, 'new'))?.usernames, ['f']);
  }));

test('Abhaken, Tageszähler, Rückgängig und Warnung bei veraltetem Export', { skip }, () =>
  withAccount(async (c, acc) => {
    await importSnapshot(c, acc, list('a'), list('a', 'd', 'e'));
    await markCleanup(c, acc, 'd', 'unfollowed');
    await markCleanup(c, acc, 'e', 'keep');
    assert.deepEqual(await openNonFollowers(c, acc), []);
    assert.equal(await unfollowedToday(c, acc, 'Europe/Vienna'), 1);

    const stats = await cleanupStats(c, acc);
    assert.equal(stats.nonFollowers, 2);
    assert.equal(stats.unfollowed, 1);
    assert.equal(stats.kept, 1);

    assert.equal(await undoCleanup(c, acc), 'e'); // letzter geschützter
    assert.deepEqual((await openNonFollowers(c, acc)).map((n) => n.username), ['e']);

    // Neuer Export, in dem "d" noch drinsteht, obwohl als entfolgt abgehakt
    const r = await importSnapshot(c, acc, list('a'), list('a', 'd'));
    assert.equal(r.stillFollowingMarked, 1);
  }));

test('Kommentierer werden nie zum Entfolgen vorgeschlagen', { skip }, () =>
  withAccount(async (c, acc) => {
    await importSnapshot(c, acc, list('a'), list('a', 'x', 'y'));
    await c.query(`INSERT INTO instagram.posts (account_id, media_id) VALUES ($1, 'm1')`, [acc]);
    await c.query(
      `INSERT INTO instagram.comments (account_id, comment_id, media_id, username, text) VALUES ($1, 'c1', 'm1', 'X', 'Stark!')`,
      [acc],
    );
    const open = await openNonFollowers(c, acc);
    assert.deepEqual(open.map((n) => [n.username, n.commented]), [['x', true], ['y', false]]);
    assert.deepEqual((await unfollowCandidates(c, acc)).map((n) => n.username), ['y']);
  }));

test('nur die letzten Snapshots werden aufbewahrt', { skip }, () =>
  withAccount(async (c, acc) => {
    for (let i = 0; i < KEEP_SNAPSHOTS + 2; i++) await importSnapshot(c, acc, list('a'), list('a'));
    const { rows } = await c.query('SELECT count(*)::int AS n FROM instagram.snapshots WHERE account_id = $1', [acc]);
    assert.equal(rows[0].n, KEEP_SNAPSHOTS);
  }));

test('Einzeldateien warten und werden beim Abholen entfernt', { skip }, () =>
  withAccount(async (c, acc) => {
    await savePending(c, acc, 'followers_1.json', 'follower', list('a'));
    await savePending(c, acc, 'followers_1.json', 'follower', list('a', 'b')); // ersetzt
    await savePending(c, acc, 'following.json', 'following', list('z'));
    const parts = await takePending(c, acc);
    assert.equal(parts.length, 2);
    assert.equal(parts.find((p) => p.kind === 'follower')?.entries.length, 2);
    assert.deepEqual(await takePending(c, acc), []);
  }));

test('fehlende Liste wird abgelehnt', { skip }, () =>
  withAccount(async (c, acc) => {
    await assert.rejects(importSnapshot(c, acc, [], list('a')), /Follower-Liste/);
  }));
