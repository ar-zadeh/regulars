import test from 'node:test';
import assert from 'node:assert/strict';
import {computeLoyalty} from '../src/loyalty.js';

const message = (id, timestamp, overrides = {}) => ({
  id, timestamp, viewer_id: 'viewer', moderation: 'cleared',
  organizer: 'assigned', bot: 0, text: 'hello', ...overrides,
});
const awardsFor = (messages, options = {}) => computeLoyalty({
  messages, timeZone: 'America/New_York', ...options,
});

test('Night Owl uses local midnight and excludes 05:00', () => {
  const messages = [
    message('before', '2026-01-02T04:59:00Z'), // 23:59 on January 1
    message('midnight', '2026-01-02T05:00:00Z'),
    message('last', '2026-01-02T09:59:59Z'),
    message('five', '2026-01-02T10:00:00Z'),
  ];
  assert.deepEqual(awardsFor(messages), [
    {title: 'Night Owl', viewerId: 'viewer', evidence: ['midnight']},
  ]);
  assert.deepEqual(awardsFor([messages[0], messages[3]]), []);
});

test('Night Owl spans the spring DST jump and fall repeated hour', () => {
  const spring = [
    message('after-five', '2026-03-08T09:00:00Z'), // 05:00 EDT
    message('before-jump', '2026-03-08T06:59:00Z'), // 01:59 EST
    message('after-jump', '2026-03-08T07:00:00Z'), // 03:00 EDT
  ];
  assert.deepEqual(awardsFor(spring), [
    {title: 'Night Owl', viewerId: 'viewer', evidence: ['before-jump']},
  ]);
  const fall = [
    message('second-one', '2026-11-01T06:30:00Z'), // 01:30 EST
    message('first-one', '2026-11-01T05:30:00Z'), // 01:30 EDT
  ];
  assert.deepEqual(awardsFor(fall), [
    {title: 'Night Owl', viewerId: 'viewer', evidence: ['first-one']},
  ]);
});

test('Day One compares the follow date in the streamer time zone', () => {
  const messages = [message('later-chat', '2026-01-03T13:00:00Z'), message('first-chat', '2026-01-02T12:00:00Z')];
  const options = {dayOneDate: '2026-01-01', followDates: {viewer: '2026-01-02T02:00:00Z'}};
  assert.deepEqual(awardsFor(messages, options), [
    {title: 'Day One', viewerId: 'viewer', evidence: ['first-chat']},
  ]);
  assert.deepEqual(awardsFor(messages, {...options, followDates: {viewer: '2026-01-02T05:00:00Z'}}), []);
  assert.deepEqual(awardsFor(messages, {...options, followDates: {}}), []);
});

test('custom Night Owl windows include their start and exclude their end across midnight', () => {
  const options = {nightOwlStart: '22:30', nightOwlEnd: '01:15'};
  assert.deepEqual(awardsFor([message('early', '2026-01-02T03:29:00Z')], options), []);
  assert.equal(awardsFor([message('start', '2026-01-02T03:30:00Z')], options)[0].evidence[0], 'start');
  assert.equal(awardsFor([message('before-end', '2026-01-02T06:14:00Z')], options)[0].evidence[0], 'before-end');
  assert.deepEqual(awardsFor([message('end', '2026-01-02T06:15:00Z')], options), []);
});

test('custom Night Owl window handles daytime and the repeated DST hour', () => {
  assert.equal(awardsFor([message('day', '2026-01-02T15:30:00Z')], {nightOwlStart:'10:00',nightOwlEnd:'11:00'})[0].evidence[0], 'day');
  const options = {nightOwlStart:'01:15',nightOwlEnd:'01:45'};
  for (const timestamp of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
    assert.equal(awardsFor([message('repeated', timestamp)], options)[0].title, 'Night Owl');
  }
  for (const invalid of [{nightOwlStart:'24:00'}, {nightOwlEnd:'05:60'}, {nightOwlStart:'01:00',nightOwlEnd:'01:00'}]) {
    assert.throws(() => awardsFor([], invalid), /Night Owl/);
  }
});

test('Day One is awarded in the first qualifying session only', () => {
  const options = {dayOneDate: '2026-01-01', followDates: {viewer: '2025-12-31T12:00:00Z'}};
  const first = awardsFor([message('first-session', '2026-01-02T12:00:00Z')], options);
  assert.equal(first.filter(award => award.title === 'Day One').length, 1);
  const later = awardsFor([message('later-session', '2026-01-03T12:00:00Z')], {...options, previousDayOne: ['viewer']});
  assert.equal(later.some(award => award.title === 'Day One'), false);
});

test('loyalty excludes ineligible chat', () => {
  const ineligible = [
    message('bot', '2026-01-02T06:00:00Z', {bot: 1}),
    message('shared', '2026-01-02T06:00:00Z', {shared: true}),
    message('broadcaster', '2026-01-02T06:00:00Z', {broadcaster: true}),
    message('hidden', '2026-01-02T06:00:00Z', {moderation: 'hidden'}),
    message('reaction', '2026-01-02T06:00:00Z', {organizer: 'reaction'}),
    message('command', '2026-01-02T06:00:00Z', {text: '!wrap'}),
    message('repeat', '2026-01-02T06:00:00Z', {repetitionOnly: true}),
  ];
  assert.deepEqual(awardsFor(ineligible, {dayOneDate: '2026-01-01', followDates: {viewer: '2025-12-31T12:00:00Z'}}), []);
});

test('Day One rejects impossible calendar dates', () => {
  for (const dayOneDate of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-01-00', '01/01/2026']) {
    assert.throws(() => awardsFor([], {dayOneDate}), /Invalid Day One date/);
  }
  assert.doesNotThrow(() => awardsFor([], {dayOneDate: '2028-02-29'}));
});
