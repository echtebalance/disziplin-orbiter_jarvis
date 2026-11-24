import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, parseKey } from '../src/crypto.ts';

const key = randomBytes(32);

test('verschlüsselt und entschlüsselt wieder zum Original', () => {
  const token = 'IGAAexample-token_123';
  const sealed = encryptSecret(token, key);
  assert.notEqual(sealed, token);
  assert.ok(!sealed.includes(token));
  assert.equal(decryptSecret(sealed, key), token);
});

test('gleicher Klartext ergibt jedes Mal einen anderen Geheimtext', () => {
  assert.notEqual(encryptSecret('abc', key), encryptSecret('abc', key));
});

test('falscher Schlüssel schlägt fehl', () => {
  const sealed = encryptSecret('geheim', key);
  assert.throws(() => decryptSecret(sealed, randomBytes(32)));
});

test('manipulierter Geheimtext schlägt fehl', () => {
  const parts = encryptSecret('geheim', key).split('.');
  parts[3] = Buffer.from('anders').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key));
});

test('parseKey prüft Vorhandensein und Länge', () => {
  assert.throws(() => parseKey(undefined), /fehlt/);
  assert.throws(() => parseKey(randomBytes(16).toString('base64')), /32 Byte/);
  assert.equal(parseKey(key.toString('base64')).length, 32);
});
