// ─────────────────────────────────────────────────────────────
// AskScratch — action "feedback"
// Kiriman feedback disimpan di D1 (tabel `feedback`, lihat schema.sql).
// ─────────────────────────────────────────────────────────────
import { getEnv, sqlite } from "./platform.ts";

/** Rate limit: maksimum kiriman per IP dalam 1 jam. */
export const FEEDBACK_RATE_LIMIT_MAX = 5;
export const FEEDBACK_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Batas panjang tiap field. Teks yang kelewat panjang dipotong. */
const LIMIT = {
  anonId: 64,
  appVersion: 40,
  lang: 10,
  models: 10, // models_used maksimal 10 item
  model: 60, // panjang tiap nama model
  liked: 400,
  improve: 600,
  contact: 120,
} as const;

export type FeedbackRow = {
  id: number;
  created_at: string;
  anon_id: string;
  app_version: string;
  rating: number | null;
  models_used: string[];
  liked: string;
  improve: string;
  contact: string;
  lang: string;
  standalone: number;
  ip_hash: string;
};

// ── Helper parsing / validasi ────────────────────────────────

/**
 * Ambil IP klien. Di Cloudflare, `cf-connecting-ip` diisi Cloudflare sendiri
 * dan tidak bisa dipalsukan klien, jadi dipakai paling awal. (x-forwarded-for
 * sengaja jadi cadangan: entri pertamanya bisa diisi klien.)
 */
export function clientIp(req: Request): string {
  const headers = req.headers;
  return (
    headers.get("cf-connecting-ip")?.trim() ||
    (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

/** Jadikan apa pun string teks (dipotong), default "". */
function toText(value: unknown, maxLength: number): string {
  if (typeof value === "string") return value.trim().slice(0, maxLength);
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value).slice(0, maxLength);
  }
  return "";
}

/** Rating: 1–5 (bulat) atau null kalau tidak valid / kosong. */
function toRating(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

/** models_used: array of string, maksimal 10 item. */
function toModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = toText(item, LIMIT.model);
    if (text) out.push(text);
    if (out.length >= LIMIT.models) break;
  }
  return out;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" ||
    value === "TRUE" || value === "ya";
}

export type FeedbackFields = {
  anonId: string;
  appVersion: string;
  rating: number | null;
  modelsUsed: string[];
  liked: string;
  improve: string;
  contact: string;
  lang: string;
  standalone: boolean;
};

/** Validasi + normalisasi payload dari client. Terima snake_case & camelCase. */
export function normalizeFeedback(payload: unknown): FeedbackFields {
  const p = (payload && typeof payload === "object" ? payload : {}) as
    Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (p[key] !== undefined && p[key] !== null) return p[key];
    }
    return undefined;
  };

  return {
    anonId: toText(pick("anon_id", "anonId"), LIMIT.anonId),
    appVersion: toText(pick("app_version", "appVersion"), LIMIT.appVersion),
    rating: toRating(pick("rating")),
    modelsUsed: toModels(pick("models_used", "modelsUsed")),
    liked: toText(pick("liked"), LIMIT.liked),
    improve: toText(pick("improve", "improvement"), LIMIT.improve),
    contact: toText(pick("contact"), LIMIT.contact),
    lang: toText(pick("lang", "language"), LIMIT.lang),
    standalone: toBool(pick("standalone")),
  };
}

/** Hash IP (SHA-256 + salt) — IP asli tidak pernah disimpan. */
export async function hashIp(ip: string): Promise<string> {
  const salt = getEnv("IP_HASH_SALT") ?? "askscratch-feedback";
  const bytes = new TextEncoder().encode(`${salt}|${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Simpan ───────────────────────────────────────────────────

export type FeedbackResult = {
  status: number;
  body: Record<string, unknown>;
};

/** Proses satu kiriman feedback: cek rate limit 5/jam per IP, lalu INSERT. */
export async function submitFeedback(
  payload: unknown,
  ip: string,
): Promise<FeedbackResult> {
  try {
    const fields = normalizeFeedback(payload);
    const ipHash = await hashIp(ip);
    const since = new Date(Date.now() - FEEDBACK_RATE_LIMIT_WINDOW_MS)
      .toISOString();

    const { rows } = await sqlite.execute({
      sql:
        "SELECT COUNT(*) AS total FROM feedback WHERE ip_hash = ? AND created_at >= ?",
      args: [ipHash, since],
    });
    const recent = Number(rows[0]?.total ?? 0);
    if (recent >= FEEDBACK_RATE_LIMIT_MAX) {
      return {
        status: 429,
        body: {
          error:
            "Terlalu banyak kiriman feedback dari IP ini. Coba lagi dalam 1 jam.",
        },
      };
    }

    await sqlite.execute({
      sql: `INSERT INTO feedback
        (created_at, anon_id, app_version, rating, models_used, liked, improve, contact, lang, standalone, ip_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        new Date().toISOString(),
        fields.anonId,
        fields.appVersion,
        fields.rating,
        JSON.stringify(fields.modelsUsed),
        fields.liked,
        fields.improve,
        fields.contact,
        fields.lang,
        fields.standalone ? 1 : 0,
        ipHash,
      ],
    });

    return { status: 200, body: { ok: true } };
  } catch (err) {
    console.error("feedback: gagal menyimpan", err);
    return { status: 500, body: { error: "Gagal menyimpan feedback." } };
  }
}

// ── Baca (dipakai halaman /admin) ────────────────────────────

export type FeedbackStats = {
  total: number;
  rated: number;
  average: number | null;
};

export async function getFeedbackStats(): Promise<FeedbackStats> {
  const { rows } = await sqlite.execute(
    "SELECT COUNT(*) AS total, COUNT(rating) AS rated, AVG(rating) AS average FROM feedback",
  );
  const row = rows[0] ?? {};
  const total = Number(row.total ?? 0);
  const rated = Number(row.rated ?? 0);
  const raw = row.average === null || row.average === undefined
    ? null
    : Number(row.average);
  return {
    total: Number.isFinite(total) ? total : 0,
    rated: Number.isFinite(rated) ? rated : 0,
    average: raw !== null && Number.isFinite(raw) ? raw : null,
  };
}

function rowToFeedback(row: Record<string, unknown>): FeedbackRow {
  const modelsRaw = typeof row.models_used === "string" ? row.models_used : "";
  let models: string[] = [];
  if (modelsRaw) {
    try {
      const parsed = JSON.parse(modelsRaw);
      if (Array.isArray(parsed)) {
        models = parsed.filter((m): m is string => typeof m === "string");
      }
    } catch {
      models = [];
    }
  }

  const ratingRaw = row.rating === null || row.rating === undefined
    ? NaN
    : Number(row.rating);

  const text = (value: unknown) => (typeof value === "string" ? value : "");

  return {
    id: Number(row.id ?? 0),
    created_at: text(row.created_at),
    anon_id: text(row.anon_id),
    app_version: text(row.app_version),
    rating: Number.isFinite(ratingRaw) ? ratingRaw : null,
    models_used: models,
    liked: text(row.liked),
    improve: text(row.improve),
    contact: text(row.contact),
    lang: text(row.lang),
    standalone: Number(row.standalone ?? 0) ? 1 : 0,
    ip_hash: text(row.ip_hash),
  };
}

export async function listFeedback(limit = 200): Promise<FeedbackRow[]> {
  const { rows } = await sqlite.execute({
    sql: `SELECT id, created_at, anon_id, app_version, rating, models_used,
                 liked, improve, contact, lang, standalone, ip_hash
          FROM feedback ORDER BY id DESC LIMIT ?`,
    args: [limit],
  });
  return rows.map((row) => rowToFeedback(row as Record<string, unknown>));
}
