import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HABIT_CATALOG, findTemplate } from '../src/habit-catalog.ts';
import { parseTime } from '../src/time.ts';

test('Habit-Vorlagen sind gültig', () => {
  const keys = HABIT_CATALOG.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, 'Schlüssel eindeutig');
  for (const t of HABIT_CATALOG) {
    assert.match(t.key, /^[a-z0-9]{1,16}$/, `${t.key}: Schlüssel passt in Buttons und /log`);
    assert.ok(t.min >= 1 && t.max >= t.min && t.max <= 1440, `${t.key}: Dauer plausibel`);
    if (t.time) assert.equal(parseTime(t.time), t.time, `${t.key}: Uhrzeit gültig`);
    assert.ok(!/[–—]/.test(t.label), 'keine langen Striche');
  }
  assert.deepEqual([findTemplate('ernaehrung')?.min, findTemplate('ernaehrung')?.max], [5, 45]);
  assert.equal(findTemplate('stretching')?.time, '09:00');
});
