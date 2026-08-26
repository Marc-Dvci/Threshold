/**
 * The time model.
 *
 * An Instant is a day offset plus a wall-clock time. No timezones, no absolute dates, no Date
 * objects in any contract. Three reasons, all of them load-bearing:
 *
 *  1. Determinism. A film and a test suite that depend on `Date.now()` are a film and a test suite
 *     that break at midnight and in March.
 *  2. Legibility. `{ day: 1, at: "06:40" }` is the value the payload carries, the value DevTools
 *     shows, and the value the narration says. Nothing is translated on the way to the viewer.
 *  3. Safety. Four independent origins agreeing on a timezone offset is a class of bug this system
 *     does not need to have. Every party in one service area shares a locality by construction.
 *
 * All comparison goes through `minutesOf`, which is total and monotone, so link checks are ordinary
 * integer comparisons.
 */

import { CLOCK_TIME_PATTERN, type DayOffset } from './vocabulary.js';
import type { ClockTime, Instant } from './types.js';

export type { ClockTime, Instant };

const CLOCK_RE = new RegExp(CLOCK_TIME_PATTERN);

export function isClockTime(value: unknown): value is ClockTime {
  return typeof value === 'string' && CLOCK_RE.test(value);
}

/**
 * Minutes since the start of the search date. Total order over instants.
 * Throws on a malformed clock time rather than coercing: a silent NaN here would make every link
 * check quietly false.
 */
export function minutesOf(instant: Instant): number {
  if (!isClockTime(instant.at)) {
    throw new RangeError(`malformed clock time: ${JSON.stringify(instant.at)}`);
  }
  const hh = Number(instant.at.slice(0, 2));
  const mm = Number(instant.at.slice(3, 5));
  return instant.day * 1440 + hh * 60 + mm;
}

export function compareInstants(a: Instant, b: Instant): number {
  return minutesOf(a) - minutesOf(b);
}

export function isBeforeOrEqual(a: Instant, b: Instant): boolean {
  return minutesOf(a) <= minutesOf(b);
}

export function isAfter(a: Instant, b: Instant): boolean {
  return minutesOf(a) > minutesOf(b);
}

export function earliest(instants: readonly Instant[]): Instant {
  if (instants.length === 0) throw new RangeError('earliest() of an empty list');
  return instants.reduce((lo, i) => (minutesOf(i) < minutesOf(lo) ? i : lo), instants[0]!);
}

export function latest(instants: readonly Instant[]): Instant {
  if (instants.length === 0) throw new RangeError('latest() of an empty list');
  return instants.reduce((hi, i) => (minutesOf(i) > minutesOf(hi) ? i : hi), instants[0]!);
}

/** Add minutes to an instant, rolling the day over. Used for transport arrival = pickup + journey. */
export function addMinutes(instant: Instant, minutes: number): Instant {
  if (!Number.isInteger(minutes)) {
    throw new RangeError(`addMinutes expects an integer, got ${minutes}`);
  }
  const total = minutesOf(instant) + minutes;
  if (total < 0) throw new RangeError('instant moved before the search date');
  const day = Math.floor(total / 1440);
  if (day > 7) throw new RangeError('instant moved beyond the planning horizon');
  const rem = total % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return { day: day as DayOffset, at: `${hh}:${mm}` };
}

export function durationMinutes(from: Instant, to: Instant): number {
  return minutesOf(to) - minutesOf(from);
}

export function durationHours(from: Instant, to: Instant): number {
  return durationMinutes(from, to) / 60;
}

/**
 * How an instant is rendered for a person. Day 0 is "today", day 1 "tomorrow", then a weekday-free
 * "in N days" because the demo has no calendar and must not imply one.
 */
export function formatInstant(instant: Instant): string {
  if (instant.day === 0) return `today ${instant.at}`;
  if (instant.day === 1) return `tomorrow ${instant.at}`;
  return `in ${instant.day} days, ${instant.at}`;
}

/** Compact form for logs and tool output, where every byte of the budget counts. */
export function shortInstant(instant: Instant): string {
  return `D+${instant.day} ${instant.at}`;
}
