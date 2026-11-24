import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nowIn, parseMinutes, parseTime, parseDays, parseFreeDays, parseTermin, weekStart, dayLabel, InputError, type LocalNow,
} from '../src/time.ts';

test('nowIn rechnet in der Zeitzone des Nutzers', () => {
  const at = new Date('2026-11-17T23:30:00Z'); // in Wien schon der 18.
  assert.deepEqual(nowIn('Europe/Vienna', at), { day: '2026-11-18', time: '00:30', dow: 3, minutes: 30 });
  assert.equal(nowIn('America/New_York', at).day, '2026-11-17');
});

test('Zeitangaben', () => {
  assert.equal(parseMinutes('45'), 45);
  assert.equal(parseMinutes('1:30'), 90);
  assert.equal(parseMinutes('1,5h'), 90);
  assert.equal(parseMinutes('1h15'), 75);
  assert.equal(parseMinutes('90min'), 90);
  assert.equal(parseMinutes('viel'), null);
  assert.equal(parseTime('9'), '09:00');
  assert.equal(parseTime('9.30'), '09:30');
  assert.equal(parseTime('24:00'), null);
});

test('Wochentage', () => {
  assert.deepEqual(parseDays('mo-fr'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('fr-mo'), [0, 1, 5, 6]);
  assert.deepEqual(parseDays('mo,mi,fr'), [1, 3, 5]);
  assert.equal(parseDays('xy'), null);
  assert.deepEqual(parseFreeDays(['Samstag', 'so']), [6, 0]);
  assert.equal(dayLabel([1, 2, 3, 4, 5, 6]), 'Mo-Sa');
  assert.equal(weekStart('2026-11-22'), '2026-11-16'); // Sonntag → Montag davor
});

const now: LocalNow = { day: '2026-11-18', time: '10:00', dow: 3, minutes: 600 }; // Mittwoch

test('Termine: relative Angaben, Wochentage, Datum', () => {
  assert.deepEqual(parseTermin('Zahnarzt morgen 9:00', now), { title: 'Zahnarzt', day: '2026-11-19', time: '09:00' });
  assert.deepEqual(parseTermin('Physio Freitag 14:30', now), { title: 'Physio', day: '2026-11-20', time: '14:30' });
  // Heute schon vorbei → nächste Woche
  assert.equal(parseTermin('Meeting Mittwoch 9:00', now)?.day, '2026-11-25');
  // Datum ohne Jahr, das schon vorbei ist → nächstes Jahr
  assert.equal(parseTermin('Arzt 03.01. 8:15', now)?.day, '2027-01-03');
  assert.equal(parseTermin('Gespräch mit Max 24.12.2026 18:00', now)?.title, 'Gespräch mit Max');
});

test('Termine: Fehler werden verständlich gemeldet', () => {
  assert.equal(parseTermin('morgen 9:00', now), null);
  assert.throws(() => parseTermin('Arzt heute 8:00', now), (e) => e instanceof InputError && /Vergangenheit/.test(e.message));
  assert.throws(() => parseTermin('Arzt 31.02. 8:00', now), /Ungültiges Datum/);
  assert.throws(() => parseTermin('Arzt morgen später', now), /Uhrzeit/);
});
