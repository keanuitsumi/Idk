// ─────────────────────────────────────────────────────────────
// Lapisan kompatibilitas Cloudflare Workers (pengganti Val Town)
//   • getEnv()  → pengganti Deno.env.get()
//   • sqlite    → pengganti https://esm.town/v/std/sqlite (di atas D1)
//   • takeRateHit() → pembatas laju berbasis D1 (pengganti Map di memori,
//     karena isolate Workers tidak berbagi memori antar request)
// ─────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
let current: any = null;

/** Dipanggil sekali per request dari main.ts. */
// deno-lint-ignore no-explicit-any
export function setEnv(env: any): void {
  current = env;
}

export function getEnv(key: string): string | undefined {
  const value = current?.[key];
  return typeof value === "string" ? value : undefined;
}

export type Row = Record<string, any>;

export const sqlite = {
  /** Sama bentuknya dengan std/sqlite: execute("sql") atau execute({ sql, args }). */
  async execute(
    query: string | { sql: string; args?: unknown[] },
  ): Promise<{ rows: Row[] }> {
    const sql = typeof query === "string" ? query : query.sql;
    const args = typeof query === "string" ? [] : (query.args ?? []);
    const { results } = await current.DB.prepare(sql).bind(...args).all();
    return { rows: (results ?? []) as Row[] };
  },
};

/**
 * Jendela geser berbasis D1. `true` = boleh lanjut, `false` = sudah penuh.
 * Satu key = satu pembatas (mis. "ip:1.2.3.4" atau "deapi").
 */
export async function takeRateHit(
  key: string,
  max: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  await sqlite.execute({
    sql: "DELETE FROM rate_hits WHERE k = ? AND ts <= ?",
    args: [key, now - windowMs],
  });
  const { rows } = await sqlite.execute({
    sql: "SELECT COUNT(*) AS n FROM rate_hits WHERE k = ?",
    args: [key],
  });
  if (Number(rows[0]?.n ?? 0) >= max) return false;
  await sqlite.execute({
    sql: "INSERT INTO rate_hits (k, ts) VALUES (?, ?)",
    args: [key, now],
  });
  return true;
}

/** Bersih-bersih baris lama (dipanggil sesekali lewat ctx.waitUntil). */
export async function cleanupOld(): Promise<void> {
  const now = Date.now();
  const oldDay = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  await sqlite.execute({
    sql: "DELETE FROM rate_hits WHERE ts < ?",
    args: [now - 3_600_000],
  });
  for (const table of ["search_usage", "image_usage", "deapi_image_usage"]) {
    await sqlite.execute({
      sql: `DELETE FROM ${table} WHERE day < ?`,
      args: [oldDay],
    });
  }
}
