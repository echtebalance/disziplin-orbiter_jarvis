import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseListJson, extractFromZip, kindOfFile, mergeLists, ExportError } from '../src/export-parser.ts';

// Aktuelles Format: following.json als Objekt, Name in "title"
const following = JSON.stringify({
  relationships_following: [
    { title: 'Anna.Fit', string_list_data: [{ href: 'https://www.instagram.com/_u/anna.fit', timestamp: 1700000000 }] },
    { title: '', string_list_data: [{ href: 'https://www.instagram.com/ben_lifts/', timestamp: 1700000100 }] },
  ],
});
// followers_1.json als Array, Name in "value"
const followers = JSON.stringify([
  { title: '', string_list_data: [{ value: 'carla', href: 'https://www.instagram.com/carla', timestamp: 1690000000 }] },
  { title: '', string_list_data: [{ value: '<script>', timestamp: 1 }] }, // ungültig, wird verworfen
]);

test('erkennt Dateinamen', () => {
  assert.equal(kindOfFile('connections/followers_and_following/following.json'), 'following');
  assert.equal(kindOfFile('followers_12.json'), 'follower');
  assert.equal(kindOfFile('followers.html'), null);
  assert.equal(kindOfFile('close_friends.json'), null);
});

test('liest Following im Objekt-Format, auch Namen nur aus dem Link', () => {
  const list = parseListJson(following, 'following');
  assert.deepEqual(list.map((e) => e.username), ['anna.fit', 'ben_lifts']);
  assert.equal(list[0]!.followedAt?.toISOString(), new Date(1700000000 * 1000).toISOString());
});

test('liest Follower im Array-Format und verwirft ungültige Namen', () => {
  assert.deepEqual(parseListJson(followers, 'follower').map((e) => e.username), ['carla']);
});

test('HTML statt JSON gibt eine verständliche Fehlermeldung', () => {
  assert.throws(() => parseListJson('<html></html>', 'follower'), (e) => e instanceof ExportError && /JSON/.test(e.message));
});

test('ZIP: nur relevante Dateien werden entpackt', () => {
  const zip = zipSync({
    'connections/followers_and_following/following.json': strToU8(following),
    'connections/followers_and_following/followers_1.json': strToU8(followers),
    'your_instagram_activity/messages/inbox/x.json': strToU8('{"geheim": true}'),
  });
  const { files, hasHtml } = extractFromZip(zip);
  assert.equal(hasHtml, false);
  assert.deepEqual(files.map((f) => f.kind).sort(), ['follower', 'following']);
});

test('ZIP im HTML-Format wird erkannt', () => {
  const zip = zipSync({ 'connections/followers_and_following/followers_1.html': strToU8('<html/>') });
  assert.deepEqual(extractFromZip(zip), { files: [], hasHtml: true });
});

test('kaputte ZIP gibt eine verständliche Fehlermeldung', () => {
  assert.throws(() => extractFromZip(new Uint8Array([1, 2, 3])), ExportError);
});

test('mehrere Follower-Dateien werden ohne Doppelte zusammengeführt', () => {
  const e = (u: string) => ({ username: u, followedAt: null });
  const merged = mergeLists([
    { kind: 'follower', entries: [e('a'), e('b')] },
    { kind: 'follower', entries: [e('b'), e('c')] },
    { kind: 'following', entries: [e('x')] },
  ]);
  assert.deepEqual(merged.followers.map((x) => x.username), ['a', 'b', 'c']);
  assert.deepEqual(merged.following.map((x) => x.username), ['x']);
});
