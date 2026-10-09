/**
 * util.ts -- small helpers shared by the scripts.
 */

export const DAY_MS = 86_400_000;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `worker` over `items`, at most `concurrency` in flight at once; results keep input order. */
export async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Strip formatting so tracking numbers like "1Z 999 AA1" and "1z999aa1" compare equal. */
export function normalizeTracking(s: string): string {
  return s.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

/** Run a script's main(), printing any thrown error and exiting 1. */
export function runMain(main: () => Promise<unknown>): void {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
