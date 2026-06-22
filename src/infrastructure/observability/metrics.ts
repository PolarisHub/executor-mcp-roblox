import type { Metrics } from "../../application/ports/metrics.js";

/** A single observed distribution's running aggregate. */
export interface ObservationSummary {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
}

/** Point-in-time view of all collected metrics, suitable for /health. */
export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly observations: Readonly<Record<string, ObservationSummary>>;
}

function keyOf(name: string, tags?: Readonly<Record<string, string>>): string {
  if (!tags) return name;
  const entries = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k] ?? ""}`);
  if (entries.length === 0) return name;
  return `${name}{${entries.join(",")}}`;
}

/**
 * Dependency-free, process-local {@link Metrics} implementation. Aggregates
 * counters, gauges and observation distributions in plain Maps. Intended for the
 * dashboard / `/health` endpoint, not for high-cardinality production export.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly observations = new Map<
    string,
    { count: number; sum: number; min: number; max: number }
  >();

  increment(name: string, value = 1, tags?: Readonly<Record<string, string>>): void {
    const key = keyOf(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, tags?: Readonly<Record<string, string>>): void {
    const key = keyOf(name, tags);
    const existing = this.observations.get(key);
    if (existing) {
      existing.count += 1;
      existing.sum += value;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
    } else {
      this.observations.set(key, { count: 1, sum: value, min: value, max: value });
    }
  }

  gauge(name: string, value: number, tags?: Readonly<Record<string, string>>): void {
    this.gauges.set(keyOf(name, tags), value);
  }

  /** Materialize a plain-object snapshot of every metric for reporting. */
  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) counters[key] = value;

    const gauges: Record<string, number> = {};
    for (const [key, value] of this.gauges) gauges[key] = value;

    const observations: Record<string, ObservationSummary> = {};
    for (const [key, agg] of this.observations) {
      observations[key] = {
        count: agg.count,
        sum: agg.sum,
        min: agg.min,
        max: agg.max,
      };
    }

    return { counters, gauges, observations };
  }
}

/** Construct the default in-memory {@link Metrics} adapter. */
export function createMetrics(): Metrics {
  return new InMemoryMetrics();
}
