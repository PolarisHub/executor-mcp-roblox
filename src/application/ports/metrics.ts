/**
 * Metrics port. A thin, vendor-neutral surface (counter / histogram / gauge) so
 * the application can be instrumented without binding to Prometheus, OTel, or
 * StatsD. The default adapter is a no-op; a real exporter is wired in `main`.
 */
export interface Metrics {
  /** Increment a counter (default by 1). */
  increment(name: string, value?: number, tags?: Readonly<Record<string, string>>): void;
  /** Record a value in a distribution (e.g. a latency in ms). */
  observe(name: string, value: number, tags?: Readonly<Record<string, string>>): void;
  /** Set a point-in-time gauge (e.g. connected client count). */
  gauge(name: string, value: number, tags?: Readonly<Record<string, string>>): void;
}
