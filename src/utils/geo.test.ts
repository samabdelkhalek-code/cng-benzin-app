import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, fmtTime } from './geo.ts';

test('haversineKm: distance to the same point is 0', () => {
  assert.equal(haversineKm(48.137, 11.575, 48.137, 11.575), 0);
});

test('haversineKm: München → Berlin is ~504 km', () => {
  const d = haversineKm(48.137, 11.575, 52.52, 13.405);
  assert.ok(Math.abs(d - 504) < 6, `expected ~504, got ${d}`);
});

test('haversineKm: is symmetric', () => {
  const a = haversineKm(48.1, 11.5, 49.0, 12.0);
  const b = haversineKm(49.0, 12.0, 48.1, 11.5);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('fmtTime: under an hour shows minutes (50 km/h)', () => {
  assert.equal(fmtTime(10), '~12 min'); // 10/50*60 = 12
});

test('fmtTime: exactly one hour collapses to hours', () => {
  assert.equal(fmtTime(50), '~1h'); // 60 min
});

test('fmtTime: over an hour shows hours and minutes', () => {
  assert.equal(fmtTime(55), '~1h 6min'); // ceil(66) = 66 min
});
