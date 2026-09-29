/**
 * A D1 ADAPTER THAT COUNTS WHAT A ROUTE COSTS THE DATABASE.
 *
 * `prepares` is how many statements the handler built; `executions` how many
 * it ran (`.all()`, `.first()`, `.run()`, and each `batch()` as ONE); `waves`
 * how many DEPENDENT round trips it took — the number that turns into latency
 * from a Worker whose D1 primary sits in another region (docs/
 * MERCHANT_PLATFORM_V2.md §B.1 #4: «TTFB −1 D1 RTT per removed wave»).
 *
 * WAVES ARE MEASURED, NOT INFERRED. Every execution waits a simulated round
 * trip (`rttMs`, a real timer); executions that start while that timer is
 * pending — the members of one `Promise.all`, the statements of one batch —
 * share it and count as one wave. A statement that can only start once an
 * earlier answer arrived starts after the timer fired, opens the next wave,
 * and is counted. The handler's wall time therefore ≈ waves × rttMs plus its
 * own CPU, which is exactly the shape of the live cost.
 *
 * `batch()` returns each statement's ROWS for a SELECT (the live D1 does; the
 * plain adapter returns `run()` metadata only), so a route that batches a
 * read wave can be exercised here.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SqliteD1, SqliteStatement } from './d1';

export interface WaveCounts {
  prepares: number;
  executions: number;
  batches: number;
  waves: number;
  /** The first 90 chars of every executed statement, in execution order. */
  sqls: string[];
}

export class WavesStatement {
  constructor(
    private readonly db: WavesD1,
    public readonly inner: SqliteStatement,
    public readonly sql: string,
    private readonly params: unknown[] = []
  ) {}
  bind(...values: unknown[]): WavesStatement {
    return new WavesStatement(this.db, this.inner.bind(...values), this.sql, values);
  }
  async run() {
    await this.db.roundTrip(this.sql);
    return this.inner.run();
  }
  async first<T = Record<string, unknown>>() {
    await this.db.roundTrip(this.sql);
    return this.inner.first<T>();
  }
  async all<T = Record<string, unknown>>() {
    await this.db.roundTrip(this.sql);
    return this.inner.all<T>();
  }
}

export class WavesD1 {
  public counts: WaveCounts = { prepares: 0, executions: 0, batches: 0, waves: 0, sqls: [] };
  private wave: Promise<void> | null = null;
  constructor(private readonly inner: SqliteD1, public rttMs = 0) {}

  reset(): void {
    this.counts = { prepares: 0, executions: 0, batches: 0, waves: 0, sqls: [] };
  }

  prepare(sql: string): WavesStatement {
    this.counts.prepares += 1;
    return new WavesStatement(this, this.inner.prepare(sql), sql);
  }

  /** One simulated round trip; concurrent callers share the open one. */
  roundTrip(sql: string): Promise<void> {
    this.counts.executions += 1;
    this.counts.sqls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 90));
    if (!this.wave) {
      this.counts.waves += 1;
      this.wave = new Promise<void>((resolve) => {
        const done = () => {
          this.wave = null;
          resolve();
        };
        if (this.rttMs > 0) setTimeout(done, this.rttMs);
        else setImmediate(done);
      });
    }
    return this.wave;
  }

  async batch(statements: WavesStatement[]) {
    this.counts.batches += 1;
    await this.roundTrip(`BATCH(${statements.length}): ${statements.map((s) => s.sql).join(' | ')}`);
    const out = [];
    for (const s of statements) {
      const head = s.sql.trim().slice(0, 6).toUpperCase();
      out.push(head === 'SELECT' || head.startsWith('WITH') ? await s.inner.all() : await s.inner.run());
    }
    return out;
  }
}

export function wavesD1(raw: DatabaseSync, rttMs = 0): { waves: WavesD1; db: D1Database } {
  const waves = new WavesD1(new SqliteD1(raw), rttMs);
  return { waves, db: waves as unknown as D1Database };
}
