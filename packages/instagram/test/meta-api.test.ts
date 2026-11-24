// Meta-API mit nachgebautem fetch - keine echten Aufrufe an Instagram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetaClient, endpointLabel, isEmojiOnly, looksLikeFbToken, looksLikeIgToken, MetaApiError, usageFromHeaders, GRAPH, type FetchFn,
} from '../src/meta-api.ts';

const TOKEN = 'IGAA' + 'x'.repeat(60);

/** Antwortet je nach Pfad; merkt sich alle aufgerufenen URLs */
function fakeFetch(routes: Record<string, (u: URL) => unknown>) {
  const calls: URL[] = [];
  const fn = (async (input: URL | string) => {
    const u = new URL(String(input));
    calls.push(u);
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    const body = key ? routes[key]!(u) : { error: { message: 'not found', code: 100 } };
    return new Response(JSON.stringify(body), { status: (body as any)?.error ? 400 : 200 });
  }) as unknown as FetchFn;
  return { fn, calls };
}

test('Token-Formen erkennen', () => {
  assert.equal(looksLikeIgToken(TOKEN), true);
  assert.equal(looksLikeIgToken('IGAA123'), false);
  assert.equal(looksLikeFbToken('EAA' + 'y'.repeat(60)), true);
  assert.equal(looksLikeIgToken('75x8'), false);
});

test('me: Version, Token als Parameter, Felder', async () => {
  const { fn, calls } = fakeFetch({ '/me': () => ({ user_id: '1784', username: 'Echte_Balance', account_type: 'MEDIA_CREATOR' }) });
  const me = await createMetaClient(TOKEN, fn).me();
  assert.deepEqual(me, { userId: '1784', username: 'echte_balance', accountType: 'MEDIA_CREATOR' });
  assert.ok(calls[0]!.href.startsWith(`${GRAPH}/me`));
  assert.equal(calls[0]!.searchParams.get('access_token'), TOKEN);
});

test('media: Rückfall ohne caption, wenn Meta das Feld ablehnt', async () => {
  const { fn, calls } = fakeFetch({
    '/1784/media': (u) =>
      u.searchParams.get('fields')!.includes('caption')
        ? { error: { message: '(#100) Tried accessing nonexisting field (caption)', code: 100 } }
        : { data: [{ id: 'm1', timestamp: '2026-11-17T10:00:00+0000', permalink: 'https://instagram.com/p/x', comments_count: 4 }] },
  });
  const media = await createMetaClient(TOKEN, fn).media('1784');
  assert.equal(calls.length, 2);
  assert.deepEqual(media, [{ id: 'm1', caption: null, timestamp: '2026-11-17T10:00:00+0000', permalink: 'https://instagram.com/p/x', commentsCount: 4 }]);
});

test('comments: Blättern und Antworten auslesen', async () => {
  const page2 = `${GRAPH}/m1/comments?after=abc&access_token=${TOKEN}`;
  const { fn, calls } = fakeFetch({
    '/m1/comments': (u) =>
      u.searchParams.get('after')
        ? { data: [{ id: 'c3', text: '🔥🔥', username: 'carla', timestamp: 't3' }] }
        : {
            data: [
              { id: 'c1', text: 'Stark!', username: 'Anna', timestamp: 't1', replies: { data: [{ id: 'r1', username: 'echte_balance' }] } },
              { id: 'c2', text: 'Wie oft trainierst du?', from: { id: '9', username: 'ben' }, timestamp: 't2' },
            ],
            paging: { next: page2 },
          },
  });
  const list = await createMetaClient(TOKEN, fn).comments('m1');
  assert.equal(calls.length, 2);
  assert.deepEqual(list.map((c) => [c.id, c.username, c.replies.map((r) => r.username)]), [
    ['c1', 'anna', ['echte_balance']],
    ['c2', 'ben', []],
    ['c3', 'carla', []],
  ]);
  assert.match(calls[0]!.searchParams.get('fields')!, /replies\{/);
});

test('ungültiger Token wird erkannt (Code 190)', async () => {
  const { fn } = fakeFetch({ '/me': () => ({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }) });
  await assert.rejects(createMetaClient(TOKEN, fn).me(), (e) => e instanceof MetaApiError && e.tokenInvalid);
});

test('Token verlängern', async () => {
  const { fn, calls } = fakeFetch({ '/refresh_access_token': () => ({ access_token: 'IGAAneu', token_type: 'bearer', expires_in: 5183944 }) });
  const r = await createMetaClient(TOKEN, fn).refresh();
  assert.deepEqual(r, { token: 'IGAAneu', expiresIn: 5183944 });
  assert.equal(calls[0]!.searchParams.get('grant_type'), 'ig_refresh_token');
  assert.equal(calls[0]!.host, 'graph.instagram.com');
});

const FB = 'EAA' + 'f'.repeat(80);

test('Facebook-Token: richtiger Server, Instagram-Konto über die Facebook-Seite', async () => {
  const { fn, calls } = fakeFetch({
    '/me/accounts': () => ({
      data: [
        { name: 'Andere Seite', id: '1' },
        { name: 'echte_balance', id: '2', instagram_business_account: { id: '1784', username: 'Echte_Balance' } },
      ],
    }),
  });
  const client = createMetaClient(FB, fn);
  assert.equal(client.kind, 'facebook');
  assert.deepEqual(await client.me(), { userId: '1784', username: 'echte_balance', accountType: 'BUSINESS' });
  assert.equal(calls[0]!.host, 'graph.facebook.com');
});

test('Systemnutzer-Token (Unified Login): Konto aus den Token-Berechtigungen', async () => {
  const { fn, calls } = fakeFetch({
    '/me/accounts': () => ({ error: { message: 'Unsupported get request', code: 100 } }), // Systemnutzer hat keine Seiten
    '/debug_token': () => ({
      data: {
        is_valid: true, expires_at: 0,
        granular_scopes: [
          { scope: 'ads_read' },
          { scope: 'instagram_basic', target_ids: ['1784'] },
          { scope: 'instagram_manage_comments', target_ids: ['1784'] },
        ],
      },
    }),
    '/1784': () => ({ id: '1784', username: 'Echte_Balance' }),
  });
  assert.deepEqual(await createMetaClient(FB, fn).me(), { userId: '1784', username: 'echte_balance', accountType: 'BUSINESS' });
  assert.ok(calls.some((u) => u.pathname.endsWith('/debug_token') && u.searchParams.get('input_token') === FB));
});

test('Token ohne Instagram-Konto: Meldung nennt die freigegebenen Berechtigungen', async () => {
  const { fn } = fakeFetch({
    '/me/accounts': () => ({ data: [{ name: 'Seite', id: '1' }] }),
    '/debug_token': () => ({ data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: ['1'] }] } }),
  });
  await assert.rejects(createMetaClient(FB, fn).me(), /Kein Instagram-Konto in diesem Token[\s\S]*pages_show_list[\s\S]*Diagnose: /);
});

test('Systemnutzer im Business-Portfolio: Konto über das Portfolio', async () => {
  const { fn } = fakeFetch({
    '/me/accounts': () => ({ data: [] }),
    '/debug_token': () => ({ error: { message: '(#100) The App_id in the input_token did not match', code: 100 } }),
    '/me/businesses': () => ({ data: [{ id: '77', name: 'echte_balance' }] }),
    '/77/instagram_accounts': () => ({ data: [{ id: '1784', username: 'echte_balance' }] }),
  });
  assert.equal((await createMetaClient(FB, fn).me()).userId, '1784');
});

test('EAA-Token aus dem Login über Instagram: gilt am Instagram-Server', async () => {
  const { fn, calls } = fakeFetch({
    '/me/accounts': () => ({ data: [] }),
    '/debug_token': () => ({ error: { message: 'You must provide an app access token', code: 100 } }),
    '/me/businesses': () => ({ error: { message: '(#100) Missing Permission', code: 100 } }),
    '/me': (u) =>
      u.host === 'graph.instagram.com'
        ? { user_id: '1784', username: 'echte_balance', account_type: 'MEDIA_CREATOR' }
        : { id: '99', name: 'X' },
  });
  const me = await createMetaClient(FB, fn).me();
  assert.deepEqual(me, { userId: '1784', username: 'echte_balance', accountType: 'MEDIA_CREATOR', kind: 'instagram' });
  assert.ok(calls.some((u) => u.host === 'graph.instagram.com'));
});

test('Instagram-Server lehnt EAA-Token ab: kein Abbruch, Diagnose läuft weiter', async () => {
  const { fn } = fakeFetch({
    '/me/accounts': () => ({ data: [] }),
    '/debug_token': () => ({ error: { message: 'You must provide an app access token', code: 100 } }),
    '/me/businesses': () => ({ error: { message: '(#100) Missing Permission', code: 100 } }),
    '/me': (u) =>
      u.host === 'graph.instagram.com'
        ? { error: { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 } }
        : { id: '99', name: 'Test' },
    '/me/permissions': () => ({ data: [{ permission: 'instagram_basic', status: 'granted' }] }),
  });
  await assert.rejects(createMetaClient(FB, fn).me(), (e) =>
    e instanceof MetaApiError && !e.tokenInvalid && /Instagram-Server: Invalid OAuth[\s\S]*Profil-Konto: /.test(e.message));
});

test('Token aus „Token generieren“ (Dashboard): /me ist das Instagram-Konto, Name per ID', async () => {
  const { fn, calls } = fakeFetch({
    '/me/accounts': () => ({ data: [] }),
    '/debug_token': () => ({ error: { message: 'You must provide an app access token', code: 100 } }),
    '/me/businesses': () => ({ error: { message: '(#100) Missing Permission', code: 100 } }),
    '/me': (u) =>
      u.host === 'graph.instagram.com'
        ? { error: { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 } }
        : u.searchParams.get('fields')?.includes('username')
          ? { error: { message: '(#12) username field is deprecated for versions v2.0 and higher', code: 12 } }
          : { id: '17841400000000001' },
    '/17841400000000001': () => ({ id: '17841400000000001', username: 'Kunde_Eins' }),
  });
  const me = await createMetaClient(FB, fn).me();
  assert.deepEqual(me, { userId: '17841400000000001', username: 'kunde_eins', accountType: 'BUSINESS' });
  assert.ok(!calls.some((u) => u.pathname.endsWith('/me') && u.searchParams.get('fields')?.includes('username') && u.host === 'graph.facebook.com'));
});

test('Konto direkt per ID: Facebook-Server, sonst Instagram-Server', async () => {
  const fb = fakeFetch({ '/17841400000000123': (u) => (u.host === 'graph.facebook.com' ? { id: '17841400000000123', username: 'echte_balance' } : {}) });
  assert.deepEqual(await createMetaClient(FB, fb.fn).account('17841400000000123'), {
    userId: '17841400000000123', username: 'echte_balance', accountType: 'BUSINESS',
  });
  const ig = fakeFetch({
    '/17841400000000123': (u) =>
      u.host === 'graph.facebook.com'
        ? { error: { message: 'Unsupported get request', code: 100 } }
        : { id: '17841400000000123', username: 'echte_balance' },
  });
  assert.equal((await createMetaClient(FB, ig.fn).account('17841400000000123')).kind, 'instagram');
  const none = fakeFetch({ '/1784': () => ({ error: { message: 'Unsupported get request', code: 100 } }) });
  await assert.rejects(createMetaClient(FB, none.fn).account('1784'), /Unsupported get request/);
});

test('abgelaufener Facebook-Token wird nicht als "kein Konto" gemeldet', async () => {
  const { fn } = fakeFetch({ '/me/accounts': () => ({ error: { message: 'Session has expired', code: 190 } }) });
  await assert.rejects(createMetaClient(FB, fn).me(), (e) => e instanceof MetaApiError && e.tokenInvalid);
});

test('Ablaufdatum: Facebook über debug_token, 0 = läuft nie ab', async () => {
  const in30 = Math.floor(Date.now() / 1000) + 30 * 86400;
  let exp = in30;
  const { fn, calls } = fakeFetch({ '/debug_token': () => ({ data: { expires_at: exp, is_valid: true } }) });
  const d = await createMetaClient(FB, fn).expiresAt();
  assert.equal(d?.getTime(), in30 * 1000);
  assert.equal(calls[0]!.searchParams.get('input_token'), FB);
  exp = 0;
  assert.equal(await createMetaClient(FB, fn).expiresAt(), null);
  await assert.rejects(createMetaClient(FB, fn).refresh(), /neu erzeugt/);
});

test('Protokoll: jede Anfrage ohne Token und IDs, mit Metas Auslastung', async () => {
  const calls: { endpoint: string; ok: boolean; usagePct: number | null }[] = [];
  const fn = (async (input: URL) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith('/comments')) return new Response(JSON.stringify({ error: { message: 'boom', code: 1 } }), { status: 500 });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'x-business-use-case-usage': JSON.stringify({ '1784': [{ type: 'instagram', call_count: 12, total_time: 3, total_cputime: 4 }] }) },
    });
  }) as unknown as FetchFn;
  const client = createMetaClient(FB, fn, 'facebook', (i) => calls.push(i));
  await client.media('17841400000000123');
  await assert.rejects(client.comments('17999999999999999'));
  assert.deepEqual(calls, [
    { endpoint: 'media', ok: true, error: null, usagePct: 12 },
    { endpoint: 'comments', ok: false, error: 'boom', usagePct: null },
  ]);
  assert.ok(!JSON.stringify(calls).includes(FB), 'Token nie im Protokoll');
});

test('Auslastungs-Header lesen', () => {
  assert.equal(usageFromHeaders(new Headers({ 'x-app-usage': '{"call_count":7,"total_time":25,"total_cputime":3}' })), 25);
  assert.equal(usageFromHeaders(new Headers()), null);
  assert.equal(endpointLabel(new URL('https://graph.facebook.com/v26.0/me/accounts')), 'me/accounts');
  assert.equal(endpointLabel(new URL('https://graph.facebook.com/v26.0/17841400000000123')), 'objekt');
});

test('reine Emoji-Kommentare erkennen', () => {
  assert.equal(isEmojiOnly('🔥🔥🔥'), true);
  assert.equal(isEmojiOnly('❤️ 💪🏼!'), true);
  assert.equal(isEmojiOnly('👏🏻👏🏻'), true);
  assert.equal(isEmojiOnly(''), true);
  assert.equal(isEmojiOnly('Stark 💪'), false);
  assert.equal(isEmojiOnly('Wie viele Sätze?'), false);
});
