// Phase-5 load test (spec 16.5): a dependency-free concurrency sweep against a
// running backend. Point it at any deployment — local (`npm run dev`/`start`)
// or a preview URL. It defaults to /api/health, which needs no auth or
// credentials, so it can gate a deploy without secrets.
//
//   npm run load-test                                   # defaults
//   LOAD_TARGET=http://localhost:3001 LOAD_URL=/api/roster/board \
//     LOAD_CONCURRENCY=25 LOAD_DURATION_MS=8000 npm run load-test
//
// Exits non-zero when p95 exceeds LOAD_P95_MAX_MS (default 500) or the error
// rate exceeds LOAD_ERROR_RATE_MAX (default 0.02), printing a JSON report.

const target = process.env.LOAD_TARGET || "http://localhost:3001";
const url = `${target}${process.env.LOAD_URL || "/api/health"}`;
const concurrency = Number(process.env.LOAD_CONCURRENCY || 20);
const durationMs = Number(process.env.LOAD_DURATION_MS || 5000);
const p95MaxMs = Number(process.env.LOAD_P95_MAX_MS || 500);
const errorRateMax = Number(process.env.LOAD_ERROR_RATE_MAX || 0.02);

async function main(): Promise<void> {
  const startedAt = Date.now();
  const latencies: number[] = [];
  let completed = 0;
  let errors = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (Date.now() - startedAt > durationMs) return;
      const t0 = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
      latencies[index] = Date.now() - t0;
      completed++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const sorted = latencies.filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const percentile = (p: number): number => {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  };
  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  const p99 = percentile(0.99);
  const errorRate = completed ? errors / completed : 0;
  const elapsedSec = (Date.now() - startedAt) / 1000;

  const report = {
    ts: new Date().toISOString(),
    level: "info",
    event: "load_test",
    target,
    url,
    concurrency,
    durationMs,
    completed,
    errors,
    errorRate: Number(errorRate.toFixed(4)),
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    requestsPerSec: elapsedSec ? Number((completed / elapsedSec).toFixed(1)) : 0,
  };
  console.log(JSON.stringify(report, null, 2));

  const failed = p95 > p95MaxMs || errorRate > errorRateMax;
  if (failed) {
    console.error(
      `LOAD TEST FAILED — p95=${p95}ms (max ${p95MaxMs}ms), errorRate=${(errorRate * 100).toFixed(2)}% (max ${errorRateMax * 100}%)`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
