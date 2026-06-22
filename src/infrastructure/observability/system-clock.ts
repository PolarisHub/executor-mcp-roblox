import { performance } from "node:perf_hooks";
import type { Clock } from "../../application/ports/clock.js";

/**
 * The production {@link Clock}: wall-clock time from `Date.now()` and monotonic
 * time from `performance.now()` (which never runs backwards, even across NTP
 * adjustments). Tests inject a fake clock instead.
 */
export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
  monotonic(): number {
    return performance.now();
  },
};
