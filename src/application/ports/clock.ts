/**
 * Time port. Injecting time keeps duration logic deterministic in tests and
 * separates "what time is it" from "how do we measure elapsed work".
 */
export interface Clock {
  /** Wall-clock epoch milliseconds (for timestamps). */
  now(): number;
  /** Monotonic milliseconds (for measuring durations; never goes backwards). */
  monotonic(): number;
}
