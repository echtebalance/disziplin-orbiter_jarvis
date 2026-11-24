import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanText, parseTargets, formatPlanText, formatTargets, PLAN_TEMPLATE, PlanTextError } from '../src/plan-text.ts';

const t = (spec: string) => parseTargets(spec)?.targets.map((x) => `${x.weight ?? '-'}x${x.reps}`).join(' ');

test('Satz-Vorgaben in allen Schreibweisen', () => {
  assert.equal(t('60kg x 10, 70kg x 8, 80kg x 6'), '60x10 70x8 80x6');
  assert.equal(t('3x10 @ 24kg'), '24x10 24x10 24x10');
  assert.equal(t('3x10@22,5'), '22.5x10 22.5x10 22.5x10');
  assert.equal(t('3x10'), '-x10 -x10 -x10', 'Sätze x Wdh. ohne Gewicht');
  assert.equal(t('100x5x5'), '100x5 100x5 100x5 100x5 100x5', 'Gewicht x Wdh. x Sätze');
  assert.equal(t('60 x 10'), '60x10', 'erste Zahl > 10 → Gewicht');
  assert.equal(t('3x12-15 @ 8kg'), '8x12-15 8x12-15 8x12-15');
  assert.equal(t('3x60s'), '-x60s -x60s -x60s');
  assert.equal(t('3×12 @ KG'), '0x12 0x12 0x12');
  assert.equal(parseTargets('3x12 @ KG')?.bodyweight, true);
  assert.equal(t(''), '');
  assert.equal(parseTargets('schwer und viel'), null);
  assert.equal(t('20x10'), '20x10', 'über 10 → Gewicht x Wdh.');
  assert.equal(parseTargets('16x10 @ 5kg'), null, 'mehr als 15 Sätze');
});

test('Vorlage wird vollständig verstanden', () => {
  const p = parsePlanText(PLAN_TEMPLATE);
  assert.equal(p.name, 'Push Pull Beine');
  assert.deepEqual([p.trainDays, p.restDays], [3, 1]);
  assert.deepEqual(p.days.map((d) => [d.name, d.exercises.length]), [['Push', 4], ['Pull', 4], ['Beine', 4]]);
  assert.deepEqual(p.warnings, []);
  const dips = p.days[0]!.exercises[2]!;
  assert.deepEqual([dips.name, dips.bodyweight, dips.targets.length], ['Dips', true, 3]);
  assert.deepEqual(p.days[1]!.exercises[3], { name: 'Face Pulls', bodyweight: false, targets: [] });
});

test('Freie Schreibweise: Aufzählungen, ohne Plan-Kopf, unbekannte Vorgabe', () => {
  const p = parsePlanText('- Bankdrücken: 3x10 @ 60kg\n• Butterfly: irgendwas\n2. Liegestütze (KG): 3x20', 'Mein Plan');
  assert.equal(p.name, 'Mein Plan');
  assert.deepEqual(p.days.map((d) => d.exercises.map((e) => e.name)), [['Bankdrücken', 'Butterfly', 'Liegestütze']]);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0]!, /Zeile 2/);
  assert.deepEqual([p.trainDays, p.restDays], [1, 1]);
});

test('Zyklus passt nicht zur Anzahl der Tage → Hinweis', () => {
  const p = parsePlanText('Zyklus: 4 2\nTag 1: A\nX: 3x10\nTag 2: B\nY: 3x10');
  assert.deepEqual([p.trainDays, p.restDays], [2, 2]);
  assert.match(p.warnings.join(), /es gilt 2/);
});

test('Fehler bei leerer oder zu großer Datei', () => {
  assert.throws(() => parsePlanText('# nur Kommentar\n\n'), PlanTextError);
  const many = Array.from({ length: 8 }, (_, i) => `Tag ${i + 1}\nX: 3x10`).join('\n');
  assert.throws(() => parsePlanText(many), /Maximal 7 Trainingstage/);
});

test('Export und erneuter Import ergeben denselben Plan', () => {
  const p = parsePlanText(PLAN_TEMPLATE);
  const again = parsePlanText(formatPlanText(p));
  assert.deepEqual(again.days, p.days);
  assert.deepEqual([again.name, again.trainDays, again.restDays], [p.name, p.trainDays, p.restDays]);
  assert.equal(formatTargets(p.days[0]!.exercises[1]!.targets), '3x10 @ 24kg');
  assert.equal(formatTargets(p.days[0]!.exercises[0]!.targets), '60kg x 10, 70kg x 8, 80kg x 6');
});
