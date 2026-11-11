// ─────────────────────────────────────────────────────────────
// AskScratch — action "deapi-image"
// Generate gambar lewat deAPI (OpenAI-compatible, oai.deapi.ai).
// Key dari env `DEAPI_KEY`, tidak pernah di-log.
// Kuota: tabel `deapi_image_usage` — maks 10/IP/hari dan
// `DEAPI_IMAGE_DAILY_CAP` per hari untuk semua IP (default 90).
// Penjaga laju (akun deAPI Basic = 3 request/menit): `DEAPI_RPM` request per
// 60 detik untuk SEMUA pengguna, dicek SEBELUM kuota. Sekarang disimpan di D1
// (bukan memori) supaya berlaku lintas isolate Workers.
// ─────────────────────────────────────────────────────────────
import { getEnv, sqlite, takeRateHit } from "./platform.ts";
import { clientIp, hashIp } from "./feedback.ts";

export const DEAPI_IMAGE_ALLOWED_MODELS = ["Flux1schnell"] as const;

const ALLOWED_MODELS_TEXT = DEAPI_IMAGE_ALLOWED_MODELS
  .map((m) => `"${m}"`)
  .join(" dan ");

export const DEAPI_IMAGE_ALLOWED_SIZES = ["512x512", "768x768"] as const;
const ALLOWED_SIZES_TEXT = DEAPI_IMAGE_ALLOWED_SIZES
  .map((s) => `"${s}"`)
  .join(" atau ");
const DEFAULT_SIZE = "768x768";

export const DEAPI_IMAGE_MAX_PROMPT_LENGTH = 600;
export const DEAPI_IMAGE_PER_IP_DAILY_MAX = 10;
export const DEAPI_IMAGE_DEFAULT_DAILY_CAP = 90;

export const DEAPI_DEFAULT_RPM = 3;
export const DEAPI_RPM_WINDOW_MS = 60_000;

export const DEAPI_IMAGE_ENDPOINT = "https://oai.deapi.ai/v1/images/generations";
export const DEAPI_KEY_PREFIX = "dpn-sk-";

const DEAPI_IMAGE_TIMEOUT_MS = 80_000;
const QUOTA_EXHAUSTED_MESSAGE = "Kuota gambar hari ini habis";
const BUSY_MESSAGE = "Pembuat gambar lagi ramai, coba lagi sebentar";

// ── Helper umum ──────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
}

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function shorten(text: string, maxLength = 300): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

// ── Helper validasi payload ──────────────────────────────────

/** Ambil prompt dari pesan user terakhir di `messages`. */
function extractPrompt(payload: Record<string, unknown>): string {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    const role = message.role;
    const content = message.content;
    if (
      (role === undefined || role === "user") &&
      typeof content === "string" &&
      content.trim()
    ) {
      return content.trim();
    }
  }
  return "";
}

type SizeResult = { ok: true; value: string } | { ok: false; message: string };

function toInteger(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** width/height: hanya 512 atau 768. Kosong → default 768. */
function parseSize(params: Record<string, unknown>): SizeResult {
  const rawWidth = params.width;
  const rawHeight = params.height;
  const empty = (v: unknown) => v === undefined || v === null || v === "";

  let width = 768;
  if (!empty(rawWidth)) {
    const parsed = toInteger(rawWidth);
    if (parsed === null) {
      return { ok: false, message: 'Parameter "width" harus angka bulat.' };
    }
    width = parsed;
  }

  let height = 768;
  if (!empty(rawHeight)) {
    const parsed = toInteger(rawHeight);
    if (parsed === null) {
      return { ok: false, message: 'Parameter "height" harus angka bulat.' };
    }
    height = parsed;
  }

  const size = `${width}x${height}`;
  if (!(DEAPI_IMAGE_ALLOWED_SIZES as readonly string[]).includes(size)) {
    return {
      ok: false,
      message: `Ukuran gambar hanya ${ALLOWED_SIZES_TEXT} yang didukung.`,
    };
  }
  return { ok: true, value: size };
}

/** low = num_inference_steps <= 2, selain itu medium. "high" tidak dipakai. */
export function resolveQuality(rawSteps: unknown): "low" | "medium" {
  const steps = toInteger(rawSteps);
  if (steps !== null && steps <= 2) return "low";
  return "medium";
}

// ── Kuota harian ─────────────────────────────────────────────

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function resolveDailyCap(): number {
  const raw = getEnv("DEAPI_IMAGE_DAILY_CAP");
  if (!raw || !raw.trim()) return DEAPI_IMAGE_DEFAULT_DAILY_CAP;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return DEAPI_IMAGE_DEFAULT_DAILY_CAP;
  return Math.floor(value);
}

/** Reservasi satu slot gambar. `true` = boleh lanjut, `false` = kuota habis. */
export async function reserveDeapiQuota(
  day: string,
  ipHash: string,
  dailyCap: number,
): Promise<boolean> {
  await sqlite.execute({
    sql: `INSERT INTO deapi_image_usage (day, ip_hash, "count") VALUES (?, ?, 1)
          ON CONFLICT(day, ip_hash) DO UPDATE SET "count" = "count" + 1`,
    args: [day, ipHash],
  });

  const { rows: ipRows } = await sqlite.execute({
    sql: `SELECT "count" AS used FROM deapi_image_usage WHERE day = ? AND ip_hash = ?`,
    args: [day, ipHash],
  });
  const usedByIp = Number(ipRows[0]?.used ?? 0);

  const { rows: dayRows } = await sqlite.execute({
    sql: `SELECT COALESCE(SUM("count"), 0) AS total FROM deapi_image_usage WHERE day = ?`,
    args: [day],
  });
  const usedToday = Number(dayRows[0]?.total ?? 0);

  if (usedByIp <= DEAPI_IMAGE_PER_IP_DAILY_MAX && usedToday <= dailyCap) {
    return true;
  }

  await releaseDeapiQuota(day, ipHash);
  return false;
}

/** Kembalikan satu slot (kuota lewat, atau panggilan deAPI gagal). */
export async function releaseDeapiQuota(
  day: string,
  ipHash: string,
): Promise<void> {
  try {
    await sqlite.execute({
      sql: `UPDATE deapi_image_usage SET "count" = "count" - 1
            WHERE day = ? AND ip_hash = ?`,
      args: [day, ipHash],
    });
    await sqlite.execute({
      sql: `DELETE FROM deapi_image_usage WHERE day = ? AND ip_hash = ? AND "count" <= 0`,
      args: [day, ipHash],
    });
  } catch (err) {
    console.error(
      "deapi-image: gagal mengembalikan slot kuota",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Penjaga laju (D1) ────────────────────────────────────────

/** Batas request/menit dari env DEAPI_RPM (default 3). */
export function resolveRpm(): number {
  const raw = getEnv("DEAPI_RPM");
  if (!raw || !raw.trim()) return DEAPI_DEFAULT_RPM;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEAPI_DEFAULT_RPM;
  return Math.floor(value);
}

/**
 * Ambil satu slot laju. `false` = sedang penuh, jangan panggil deAPI dan
 * jangan pakai kuota. Berlaku untuk SEMUA pengguna (bukan per IP).
 */
export async function takeRateSlot(rpm: number): Promise<boolean> {
  try {
    return await takeRateHit("deapi", rpm, DEAPI_RPM_WINDOW_MS);
  } catch (err) {
    // Kalau D1 bermasalah, jangan blokir — kuota di bawah tetap berlaku.
    console.error(
      "deapi: gagal memeriksa laju",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

// ── Handler action ───────────────────────────────────────────

export type DeapiImageResult = {
  status: number;
  body: Record<string, unknown>;
};

function imageResponseBody(dataUrl: string): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          images: [{ type: "image_url", image_url: { url: dataUrl } }],
        },
      },
    ],
  };
}

/** Ambil bagian error dari body deAPI: { error: { message, type, code } }. */
function extractUpstreamError(body: unknown): {
  message: string;
  type: string;
  code: string;
} {
  const root = asRecord(body);
  const nested = asRecord(root.error);
  const source = Object.keys(nested).length > 0 ? nested : root;

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    message: text(source.message) || text(root.error),
    type: text(source.type),
    code: text(source.code),
  };
}

export async function handleDeapiImage(
  payload: unknown,
  req: Request,
): Promise<DeapiImageResult> {
  const p = asRecord(payload);

  // 1. Allowlist model.
  const model = typeof p.model === "string" ? p.model.trim() : "";
  if (!(DEAPI_IMAGE_ALLOWED_MODELS as readonly string[]).includes(model)) {
    return {
      status: 400,
      body: {
        error: `Model tidak diizinkan. Hanya ${ALLOWED_MODELS_TEXT} yang didukung.`,
      },
    };
  }

  // 2. Prompt dari pesan user.
  const prompt = extractPrompt(p);
  if (!prompt) {
    return {
      status: 400,
      body: { error: 'Payload "messages" harus berisi pesan user dengan prompt.' },
    };
  }
  if (prompt.length > DEAPI_IMAGE_MAX_PROMPT_LENGTH) {
    return {
      status: 400,
      body: {
        error: `Prompt terlalu panjang. Maksimal ${DEAPI_IMAGE_MAX_PROMPT_LENGTH} karakter.`,
      },
    };
  }

  // 3. Ukuran gambar.
  const params = asRecord(p.parameters);
  const size = parseSize(params);
  if (!size.ok) return { status: 400, body: { error: size.message } };

  // 4. Key deAPI dari env. Nilainya tidak pernah di-log.
  const rawKey = getEnv("DEAPI_KEY");
  if (!rawKey || !rawKey.trim()) {
    return {
      status: 500,
      body: { error: "DEAPI key tidak dikonfigurasi di environment." },
    };
  }
  const key = rawKey.trim();
  const authKey = key.startsWith(DEAPI_KEY_PREFIX) ? key : `${DEAPI_KEY_PREFIX}${key}`;

  // 5. Penjaga laju — dicek SEBELUM kuota. Penuh → 429 tanpa panggil deAPI.
  if (!(await takeRateSlot(resolveRpm()))) {
    return { status: 429, body: { error: { message: BUSY_MESSAGE } } };
  }

  // 6. Kuota harian (per IP + total harian). Slot diambil lebih dulu.
  const day = utcDay();
  const dailyCap = resolveDailyCap();
  const ipHash = await hashIp(clientIp(req));
  let allowed: boolean;
  try {
    allowed = await reserveDeapiQuota(day, ipHash, dailyCap);
  } catch (err) {
    console.error(
      "deapi-image: gagal memeriksa kuota",
      err instanceof Error ? err.message : err,
    );
    return { status: 500, body: { error: "Gagal memeriksa kuota gambar." } };
  }
  if (!allowed) {
    return { status: 429, body: { error: { message: QUOTA_EXHAUSTED_MESSAGE } } };
  }

  // 7. Satu percobaan saja — tanpa retry otomatis.
  const quality = resolveQuality(params.num_inference_steps);
  let res: Response;
  try {
    res = await fetch(DEAPI_IMAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        size: size.value || DEFAULT_SIZE,
        quality,
        n: 1,
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(DEAPI_IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    await releaseDeapiQuota(day, ipHash);
    const message = redact(
      shorten(err instanceof Error ? err.message : String(err)),
      authKey,
    ) || "terjadi kesalahan";
    console.error("deapi-image: gagal terhubung", message);
    return { status: 502, body: { error: `deAPI image gagal: ${message}` } };
  }

  let resBody: unknown = null;
  try {
    resBody = await res.json();
  } catch {
    resBody = null;
  }

  if (!res.ok) {
    const upstream = extractUpstreamError(resBody);
    console.error(
      "deapi-image: gagal generate",
      res.status,
      redact(shorten(upstream.message), authKey),
    );

    if (
      res.status === 402 ||
      (res.status === 429 &&
        (upstream.type === "insufficient_quota" ||
          upstream.code === "key_limit_exceeded"))
    ) {
      await releaseDeapiQuota(day, ipHash);
      return { status: 429, body: { error: { message: QUOTA_EXHAUSTED_MESSAGE } } };
    }
    if (res.status === 429) {
      await releaseDeapiQuota(day, ipHash);
      return { status: 429, body: { error: { message: BUSY_MESSAGE } } };
    }

    await releaseDeapiQuota(day, ipHash);
    const message = redact(shorten(upstream.message), authKey) ||
      "terjadi kesalahan";
    return {
      status: res.status || 502,
      body: { error: `deAPI image gagal: ${message}` },
    };
  }

  // 8. Ambil data[0].b64_json → data URL.
  const data = asRecord(resBody).data;
  const first = Array.isArray(data) ? asRecord(data[0]) : {};
  const b64 = typeof first.b64_json === "string" ? first.b64_json.trim() : "";

  if (!b64) {
    await releaseDeapiQuota(day, ipHash);
    console.error("deapi-image: respons deAPI tidak berisi gambar");
    return {
      status: 502,
      body: { error: "deAPI image gagal: respons tidak berisi gambar." },
    };
  }

  const dataUrl = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  return { status: 200, body: imageResponseBody(dataUrl) };
}
