import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSets, parseKg, cycleInfo, volume, fmtRows } from '../src/parse.ts';

test('Satz-Eingabe in allen Formen', () => {
  assert.deepEqual(parseSets('75x8'), { rows: [{ weight: 75, reps: 8, sets: 1 }] });
  const multi = parseSets('75x6, 85x8, 90x5');
  assert.ok(multi && 'rows' in multi);
  assert.deepEqual(multi.rows.map((r) => r.weight), [75, 85, 90]);
  assert.deepEqual(parseSets('60 8 3'), { rows: [{ weight: 60, reps: 8, sets: 3 }] });
  assert.deepEqual(parseSets('22,5kg x 10'), { rows: [{ weight: 22.5, reps: 10, sets: 1 }] });
  assert.deepEqual(parseSets('0 12 3'), { rows: [{ weight: 0, reps: 12, sets: 3 }] });
  assert.equal(parseSets('hallo'), null);
  assert.ok('error' in (parseSets('75x500') ?? {}));
});

test('Körpergewicht', () => {
  assert.equal(parseKg('82,5'), 82.5);
  assert.equal(parseKg('82.5 kg'), 82.5);
  assert.equal(parseKg('8'), null);
  assert.equal(parseKg('400'), null);
});

test('Zyklus: 3er Split (3+1) und Recovery (1+1)', () => {
  const split = { train_days: 3, rest_days: 1 };
  const start = '2026-11-16';
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map((d) => cycleInfo(split, start, d));
  assert.deepEqual(days.map((x) => x.dayIdx), [0, 1, 2, null, 0]);
  assert.equal(cycleInfo(split, start, '2026-11-15').train, false); // Tag vor dem Start = Pause (Ende des Zyklus)
  const rec = { train_days: 1, rest_days: 1 };
  assert.deepEqual(['2026-11-16', '2026-11-17', '2026-11-18'].map((d) => cycleInfo(rec, start, d).train), [true, false, true]);
});

test('Volumen mit Körpergewicht', () => {
  assert.equal(volume([{ weight: 60, reps: 8, sets: 3 }]), 1440);
  assert.equal(volume([{ weight: 0, reps: 10, sets: 2 }], 80), 1600); // Klimmzüge mit 80 kg
  assert.equal(fmtRows([{ weight: 0, reps: 12, sets: 3 }, { weight: 22.5, reps: 8, sets: 1 }]), 'Körpergewicht × 12 × 3 · 22,5 kg × 8');
});
