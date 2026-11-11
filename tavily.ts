// ─────────────────────────────────────────────────────────────
// AskScratch — action "tavily"
// Pencarian web lewat Tavily Search API (POST https://api.tavily.com/search).
//
// TAVILY_API_KEY dibaca dari env dan TIDAK pernah ditulis ke log.
// Hemat kredit:
//   • Hasil pencarian di-cache di D1 (tabel `search_cache`), TTL 6 jam.
//   • Pencarian BARU dicatat di `search_usage`: maks 15/IP/hari dan
//     `TAVILY_DAILY_CAP` per hari untuk semua IP (default 30).
// ─────────────────────────────────────────────────────────────
import { getEnv, sqlite } from "./platform.ts";
import { clientIp, hashIp } from "./feedback.ts";

export const TAVILY_MAX_QUERY_LENGTH = 300;
export const TAVILY_MAX_RESULTS = 6;
export const TAVILY_PER_IP_DAILY_MAX = 15;
export const TAVILY_DEFAULT_DAILY_CAP = 30;
export const TAVILY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const TAVILY_TIMEOUT_MS = 30_000;
/** search_depth selalu dipaksa "basic" — parameter dari client diabaikan. */
const TAVILY_SEARCH_DEPTH = "basic";
const DEFAULT_MAX_RESULTS = TAVILY_MAX_RESULTS;
const QUOTA_EXHAUSTED_MESSAGE = "Kuota pencarian hari ini habis";
const MAX_COUNTRY_LENGTH = 60;

// ── Helper validasi payload ──────────────────────────────────

/** Query: rapatkan spasi berlebih dan potong spasi tepi. */
export function normalizeQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

type NumberResult = { ok: true; value: number } | { ok: false; message: string };

/** max_results: bulat, 1–6. Kosong → default 6. */
function parseMaxResults(raw: unknown): NumberResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: DEFAULT_MAX_RESULTS };
  }

  let value: unknown = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      return { ok: false, message: 'Parameter "max_results" harus angka bulat.' };
    }
    value = Number(text);
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, message: 'Parameter "max_results" harus angka bulat.' };
  }
  if (value < 1 || value > TAVILY_MAX_RESULTS) {
    return {
      ok: false,
      message: `Parameter "max_results" harus antara 1 dan ${TAVILY_MAX_RESULTS}.`,
    };
  }
  return { ok: true, value };
}

// ── Kuota harian ─────────────────────────────────────────────

/** Tanggal UTC (YYYY-MM-DD) — reset kuota mengikuti hari UTC. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Batas total harian dari env TAVILY_DAILY_CAP (default 30). */
export function resolveDailyCap(): number {
  const raw = getEnv("TAVILY_DAILY_CAP");
  if (!raw || !raw.trim()) return TAVILY_DEFAULT_DAILY_CAP;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return TAVILY_DEFAULT_DAILY_CAP;
  return Math.floor(value);
}

/**
 * Reservasi satu slot pencarian BARU. `true` = boleh lanjut, `false` = habis.
 * Slot diambil dulu, lalu dikembalikan kalau ternyata melewati batas.
 */
export async function reserveSearchQuota(
  day: string,
  ipHash: string,
  dailyCap: number,
): Promise<boolean> {
  await sqlite.execute({
    sql: `INSERT INTO search_usage (day, ip_hash, "count") VALUES (?, ?, 1)
          ON CONFLICT(day, ip_hash) DO UPDATE SET "count" = "count" + 1`,
    args: [day, ipHash],
  });

  const { rows: ipRows } = await sqlite.execute({
    sql: `SELECT "count" AS used FROM search_usage WHERE day = ? AND ip_hash = ?`,
    args: [day, ipHash],
  });
  const usedByIp = Number(ipRows[0]?.used ?? 0);

  const { rows: dayRows } = await sqlite.execute({
    sql: `SELECT COALESCE(SUM("count"), 0) AS total FROM search_usage WHERE day = ?`,
    args: [day],
  });
  const usedToday = Number(dayRows[0]?.total ?? 0);

  if (usedByIp <= TAVILY_PER_IP_DAILY_MAX && usedToday <= dailyCap) {
    return true;
  }

  await sqlite.execute({
    sql: `UPDATE search_usage SET "count" = "count" - 1 WHERE day = ? AND ip_hash = ?`,
    args: [day, ipHash],
  });
  return false;
}

// ── Cache hasil pencarian ────────────────────────────────────

export type TavilyItem = {
  title: string;
  url: string;
  content: string;
  published_date: string | null;
};

function toItem(raw: unknown): TavilyItem | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url : "";
  if (!url) return null;

  return {
    title: typeof r.title === "string" ? r.title : "",
    url,
    content: typeof r.content === "string" ? r.content : "",
    published_date:
      typeof r.published_date === "string" && r.published_date
        ? r.published_date
        : null,
  };
}

function parseItems(raw: unknown): TavilyItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TavilyItem[] = [];
  for (const entry of raw) {
    const item = toItem(entry);
    if (item) out.push(item);
    if (out.length >= TAVILY_MAX_RESULTS) break;
  }
  return out;
}

/** Baca cache. `null` = miss (belum ada atau sudah lewat TTL 6 jam). */
export async function readCache(cacheKey: string): Promise<TavilyItem[] | null> {
  const { rows } = await sqlite.execute({
    sql: `SELECT results, created_at FROM search_cache WHERE cache_key = ?`,
    args: [cacheKey],
  });
  const row = rows[0];
  if (!row) return null;

  const createdAt = typeof row.created_at === "string"
    ? Date.parse(row.created_at)
    : NaN;
  if (!Number.isFinite(createdAt) || Date.now() - createdAt >= TAVILY_CACHE_TTL_MS) {
    return null;
  }
  if (typeof row.results !== "string") return null;

  try {
    const parsed = JSON.parse(row.results);
    if (!Array.isArray(parsed)) return null;
    return parseItems(parsed);
  } catch {
    return null;
  }
}

/** Simpan hasil ke cache + buang entry yang sudah lewat TTL. */
export async function writeCache(
  cacheKey: string,
  items: TavilyItem[],
): Promise<void> {
  await sqlite.execute({
    sql: `INSERT INTO search_cache (cache_key, results, created_at) VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            results = excluded.results,
            created_at = excluded.created_at`,
    args: [cacheKey, JSON.stringify(items), new Date().toISOString()],
  });

  await sqlite.execute({
    sql: `DELETE FROM search_cache WHERE created_at < ?`,
    args: [new Date(Date.now() - TAVILY_CACHE_TTL_MS).toISOString()],
  }).catch(() => {});
}

// ── Helper error ─────────────────────────────────────────────

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function extractMessage(text: string): string {
  const FALLBACK = "terjadi kesalahan";
  const MAX_LENGTH = 500;

  const trimmed = text.trim();
  if (!trimmed) return FALLBACK;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.detail === "string" && parsed.detail) {
      return parsed.detail.slice(0, MAX_LENGTH);
    }
    if (typeof parsed.error === "string" && parsed.error) {
      return parsed.error.slice(0, MAX_LENGTH);
    }
    if (typeof parsed.message === "string" && parsed.message) {
      return parsed.message.slice(0, MAX_LENGTH);
    }
    if (parsed.error && typeof parsed.error === "object") {
      const message = (parsed.error as Record<string, unknown>).message;
      if (typeof message === "string" && message) {
        return message.slice(0, MAX_LENGTH);
      }
    }
  } catch {
    // Bukan JSON — jatuh ke teks mentah di bawah.
  }

  return trimmed.slice(0, MAX_LENGTH);
}

// ── Handler action ───────────────────────────────────────────

export type TavilyResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function handleTavily(
  payload: unknown,
  req: Request,
): Promise<TavilyResult> {
  const p = (payload && typeof payload === "object" ? payload : {}) as
    Record<string, unknown>;

  // 1. Query (wajib, maksimal 300 karakter).
  const query = normalizeQuery(p.query);
  if (!query) {
    return { status: 400, body: { error: 'Payload "query" wajib diisi.' } };
  }
  if (query.length > TAVILY_MAX_QUERY_LENGTH) {
    return {
      status: 400,
      body: {
        error: `Payload "query" maksimal ${TAVILY_MAX_QUERY_LENGTH} karakter.`,
      },
    };
  }

  // 2. max_results (1–6, default 6).
  const maxResults = parseMaxResults(p.max_results);
  if (!maxResults.ok) {
    return { status: 400, body: { error: maxResults.message } };
  }

  // 3. country (opsional). search_depth diabaikan — selalu "basic".
  const country = typeof p.country === "string"
    ? p.country.trim().slice(0, MAX_COUNTRY_LENGTH)
    : "";

  // 4. Cache dulu: key = query lowercase tanpa spasi berlebih.
  const cacheKey = query.toLowerCase();
  let cached: TavilyItem[] | null = null;
  try {
    cached = await readCache(cacheKey);
  } catch (err) {
    console.error(
      "tavily: gagal membaca cache",
      err instanceof Error ? err.message : err,
    );
  }
  if (cached) {
    return { status: 200, body: { results: cached.slice(0, maxResults.value) } };
  }

  // 5. Key Tavily dari env. Nilainya tidak pernah di-log.
  const tavilyKey = getEnv("TAVILY_API_KEY");
  if (!tavilyKey) {
    return {
      status: 500,
      body: { error: "TAVILY API key tidak dikonfigurasi di environment." },
    };
  }

  // 6. Kuota pencarian BARU (per IP + total harian).
  const day = utcDay();
  const dailyCap = resolveDailyCap();
  let allowed: boolean;
  try {
    allowed = await reserveSearchQuota(day, await hashIp(clientIp(req)), dailyCap);
  } catch (err) {
    console.error(
      "tavily: gagal memeriksa kuota",
      err instanceof Error ? err.message : err,
    );
    return { status: 500, body: { error: "Gagal memeriksa kuota pencarian." } };
  }
  if (!allowed) {
    return {
      status: 429,
      body: { error: { message: QUOTA_EXHAUSTED_MESSAGE } },
    };
  }

  // 7. Panggil Tavily Search API.
  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tavilyKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults.value,
        search_depth: TAVILY_SEARCH_DEPTH,
        include_answer: false,
        include_raw_content: false,
        ...(country ? { country } : {}),
      }),
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    });
  } catch (err) {
    const message = redact(
      err instanceof Error ? err.message : String(err),
      tavilyKey,
    );
    console.error("tavily: gagal terhubung", message);
    return { status: 502, body: { error: "Gagal terhubung ke Tavily API." } };
  }

  // 8. Error dari Tavily diteruskan. Kredit/batas paket habis → selalu 429.
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const message = redact(extractMessage(errText), tavilyKey);
    console.error("tavily: upstream error", res.status, message);

    const status = res.status === 429 || res.status === 432 ? 429 : res.status;
    return { status, body: { error: `Tavily gagal: ${message}` } };
  }

  const data = await res.json().catch(() => null);
  const items = parseItems(
    (data as Record<string, unknown> | null)?.results,
  );

  // 9. Simpan ke cache (best-effort).
  try {
    await writeCache(cacheKey, items);
  } catch (err) {
    console.error(
      "tavily: gagal menulis cache",
      err instanceof Error ? err.message : err,
    );
  }

  return { status: 200, body: { results: items.slice(0, maxResults.value) } };
}
