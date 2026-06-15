import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenNow, fmtOpeningHours } from './openingHours.ts';

test('fmtOpeningHours: null stays null', () => {
  assert.equal(fmtOpeningHours(null), null);
});

test('fmtOpeningHours: 24/7 is humanised', () => {
  assert.equal(fmtOpeningHours('24/7'), '24/7 geöffnet');
});

test('fmtOpeningHours: semicolons become separators', () => {
  assert.equal(
    fmtOpeningHours('Mo-Fr 08:00-20:00; Sa 09:00-18:00'),
    'Mo-Fr 08:00-20:00 | Sa 09:00-18:00'
  );
});

test('isOpenNow: no data returns null', () => {
  assert.equal(isOpenNow(null), null);
  assert.equal(isOpenNow(''), null);
});

test('isOpenNow: unparseable strings return null', () => {
  assert.equal(isOpenNow('irgendwas unparsebares'), null);
});

test('isOpenNow: 24/7 is always open regardless of clock', () => {
  assert.equal(isOpenNow('24/7'), true);
});
