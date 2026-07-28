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

// 2026-07-27 is a Monday, 2026-08-01 a Saturday.
const mon = (h: number, m = 0) => new Date(2026, 6, 27, h, m);
const sat = (h: number, m = 0) => new Date(2026, 7, 1, h, m);

test('isOpenNow: overnight span stays open after midnight', () => {
  const oh = 'Mo-Su 22:00-06:00';
  assert.equal(isOpenNow(oh, mon(23, 30)), true, 'before midnight');
  assert.equal(isOpenNow(oh, mon(3, 0)), true, 'after midnight, spill from Sunday');
  assert.equal(isOpenNow(oh, mon(12, 0)), false, 'midday is closed');
});

test('isOpenNow: lunch break does not close the afternoon', () => {
  const oh = 'Mo-Fr 08:00-12:00; Mo-Fr 14:00-18:00';
  assert.equal(isOpenNow(oh, mon(9, 0)), true, 'morning');
  assert.equal(isOpenNow(oh, mon(13, 0)), false, 'during the break');
  assert.equal(isOpenNow(oh, mon(15, 0)), true, 'afternoon');
});

test('isOpenNow: comma-separated spans in one segment are parsed', () => {
  const oh = 'Mo-Fr 08:00-12:00,14:00-18:00';
  assert.equal(isOpenNow(oh, mon(15, 0)), true);
  assert.equal(isOpenNow(oh, mon(13, 0)), false);
});

test('isOpenNow: a day the rules cover is answered, an uncovered day is unknown', () => {
  const oh = 'Mo-Fr 08:00-18:00';
  assert.equal(isOpenNow(oh, mon(20, 0)), false, 'covered day, outside hours');
  assert.equal(isOpenNow(oh, sat(10, 0)), null, 'Saturday is not mentioned at all');
});
