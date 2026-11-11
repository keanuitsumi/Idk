// ─────────────────────────────────────────────────────────────
// AskScratch — action "hf-image"
// Generate gambar lewat Hugging Face Inference Providers (provider "auto").
// Token dari env `HF_TOKEN`, tidak pernah di-log (error di-redact).
// Kuota: tabel `image_usage` — maks 10 gambar/IP/hari dan
// `HF_IMAGE_DAILY_CAP` gambar/hari untuk semua IP (default 40).
// ─────────────────────────────────────────────────────────────
import { InferenceClient } from "@huggingface/inference";
import { getEnv, sqlite } from "./platform.ts";
import { clientIp, hashIp } from "./feedback.ts";

/** Allowlist model — selain ini ditolak 400. */
export const HF_IMAGE_ALLOWED_MODELS = [
  "black-forest-labs/FLUX.1-schnell",
  "black-forest-labs/FLUX.2-klein",
] as const;

const ALLOWED_MODELS_TEXT = HF_IMAGE_ALLOWED_MODELS.map((m) => `"${m}"`).join(" dan ");

export const HF_IMAGE_PER_IP_DAILY_MAX = 10;
export const HF_IMAGE_DEFAULT_DAILY_CAP = 40;

const MAX_DIMENSION = 768;
const MIN_DIMENSION = 8;
const DIMENSION_STEP = 8;
const MAX_INFERENCE_STEPS = 4;
const DEFAULT_DIMENSION = 768;
const DEFAULT_INFERENCE_STEPS = 4;

const HF_IMAGE_TIMEOUT_MS = 120_000;
const QUOTA_EXHAUSTED_MESSAGE = "Kuota gambar hari ini habis";

// ── Helper validasi payload ──────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
}

type NumberResult = { ok: true; value: number } | { ok: false; message: string };

/** width/height: bulat, kelipatan 8, maksimal 768. Kosong → default 768. */
function parseDimension(raw: unknown, field: "width" | "height"): NumberResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: DEFAULT_DIMENSION };
  }

  let value: unknown = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      return { ok: false, message: `Parameter "${field}" harus angka bulat.` };
    }
    value = Number(text);
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, message: `Parameter "${field}" harus angka bulat.` };
  }
  if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
    return {
      ok: false,
      message: `Parameter "${field}" harus antara ${MIN_DIMENSION} dan ${MAX_DIMENSION} piksel.`,
    };
  }
  if (value % DIMENSION_STEP !== 0) {
    return {
      ok: false,
      message: `Parameter "${field}" harus kelipatan ${DIMENSION_STEP}.`,
    };
  }
  return { ok: true, value };
}

/** num_inference_steps: bulat, 1–4. Kosong → default 4. */
function parseSteps(raw: unknown): NumberResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: DEFAULT_INFERENCE_STEPS };
  }

  let value: unknown = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      return { ok: false, message: `Parameter "num_inference_steps" harus angka bulat.` };
    }
    value = Number(text);
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, message: `Parameter "num_inference_steps" harus angka bulat.` };
  }
  if (value < 1 || value > MAX_INFERENCE_STEPS) {
    return {
      ok: false,
      message: `Parameter "num_inference_steps" harus antara 1 dan ${MAX_INFERENCE_STEPS}.`,
    };
  }
  return { ok: true, value };
}

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

// ── Kuota harian ─────────────────────────────────────────────

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Batas total harian dari env HF_IMAGE_DAILY_CAP (default 40). */
export function resolveDailyCap(): number {
  const raw = getEnv("HF_IMAGE_DAILY_CAP");
  if (!raw || !raw.trim()) return HF_IMAGE_DEFAULT_DAILY_CAP;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return HF_IMAGE_DEFAULT_DAILY_CAP;
  return Math.floor(value);
}

/** Reservasi satu slot gambar. `true` = boleh lanjut, `false` = kuota habis. */
export async function reserveQuota(
  day: string,
  ipHash: string,
  dailyCap: number,
): Promise<boolean> {
  await sqlite.execute({
    sql: `INSERT INTO image_usage (day, ip_hash, "count") VALUES (?, ?, 1)
          ON CONFLICT(day, ip_hash) DO UPDATE SET "count" = "count" + 1`,
    args: [day, ipHash],
  });

  const { rows: ipRows } = await sqlite.execute({
    sql: `SELECT "count" AS used FROM image_usage WHERE day = ? AND ip_hash = ?`,
    args: [day, ipHash],
  });
  const usedByIp = Number(ipRows[0]?.used ?? 0);

  const { rows: dayRows } = await sqlite.execute({
    sql: `SELECT COALESCE(SUM("count"), 0) AS total FROM image_usage WHERE day = ?`,
    args: [day],
  });
  const usedToday = Number(dayRows[0]?.total ?? 0);

  if (usedByIp <= HF_IMAGE_PER_IP_DAILY_MAX && usedToday <= dailyCap) {
    return true;
  }

  await sqlite.execute({
    sql: `UPDATE image_usage SET "count" = "count" - 1 WHERE day = ? AND ip_hash = ?`,
    args: [day, ipHash],
  });
  return false;
}

// ── Blob → data URL ──────────────────────────────────────────

/** Tebak mime dari magic bytes — lebih dipercaya daripada blob.type. */
function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return "image/gif";
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Ubah output textToImage (Blob) jadi data URL base64. */
async function toDataUrl(output: unknown): Promise<string> {
  if (typeof output === "string") {
    const text = output.trim();
    if (!text) throw new Error("Output gambar kosong.");
    if (text.startsWith("data:") || /^https?:\/\//i.test(text)) return text;
    return `data:image/png;base64,${text}`;
  }

  const blobLike = output as { arrayBuffer?: unknown; type?: unknown } | null;
  if (blobLike && typeof blobLike.arrayBuffer === "function") {
    const declared = typeof blobLike.type === "string" && blobLike.type
      ? blobLike.type
      : "";
    const bytes = new Uint8Array(await (blobLike as unknown as Blob).arrayBuffer());
    if (!bytes.length) throw new Error("Output gambar kosong.");
    const mime = sniffMime(bytes) ?? (declared || "image/png");
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }

  throw new Error("Output gambar tidak dikenali.");
}

// ── Helper error ─────────────────────────────────────────────

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

/** Ambil status HTTP dari error SDK; fallback 502 (gagal terhubung). */
function extractStatus(err: unknown): number {
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    const httpResponse = anyErr.httpResponse as Record<string, unknown> | undefined;
    for (const candidate of [anyErr.statusCode, anyErr.status, httpResponse?.status]) {
      const value = Number(candidate);
      if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
    }
  }
  return 502;
}

/** Ambil pesan error yang berguna dari error SDK (dipotong). */
function extractMessage(err: unknown): string {
  const FALLBACK = "terjadi kesalahan";
  const MAX_LENGTH = 500;

  if (!err || typeof err !== "object") return FALLBACK;
  const anyErr = err as Record<string, unknown>;

  const body = (anyErr.httpResponse as Record<string, unknown> | undefined)?.body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") return b.error.slice(0, MAX_LENGTH);
    if (b.error && typeof b.error === "object") {
      const message = (b.error as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message.slice(0, MAX_LENGTH);
    }
    if (typeof b.message === "string" && b.message) return b.message.slice(0, MAX_LENGTH);
  }

  if (typeof anyErr.message === "string" && anyErr.message) {
    return anyErr.message.slice(0, MAX_LENGTH);
  }
  return FALLBACK;
}

// ── Handler action ───────────────────────────────────────────

export type HfImageResult = {
  status: number;
  body: Record<string, unknown>;
};

/** Balasan sukses — persis bentuk action "openrouter-image". */
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

export async function handleHfImage(
  payload: unknown,
  req: Request,
): Promise<HfImageResult> {
  const p = asRecord(payload);

  // 1. Allowlist model.
  const model = typeof p.model === "string" ? p.model.trim() : "";
  if (!(HF_IMAGE_ALLOWED_MODELS as readonly string[]).includes(model)) {
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

  // 3. Batas parameter.
  const params = asRecord(p.parameters);
  const width = parseDimension(params.width, "width");
  if (!width.ok) return { status: 400, body: { error: width.message } };
  const height = parseDimension(params.height, "height");
  if (!height.ok) return { status: 400, body: { error: height.message } };
  const steps = parseSteps(params.num_inference_steps);
  if (!steps.ok) return { status: 400, body: { error: steps.message } };

  // 4. Token HF dari env. Nilainya tidak pernah di-log.
  const hfToken = getEnv("HF_TOKEN");
  if (!hfToken) {
    return {
      status: 500,
      body: { error: "HF token tidak dikonfigurasi di environment." },
    };
  }

  // 5. Kuota harian (per IP + total harian).
  const day = utcDay();
  const dailyCap = resolveDailyCap();
  let allowed: boolean;
  try {
    allowed = await reserveQuota(day, await hashIp(clientIp(req)), dailyCap);
  } catch (err) {
    console.error(
      "hf-image: gagal memeriksa kuota",
      err instanceof Error ? err.message : err,
    );
    return { status: 500, body: { error: "Gagal memeriksa kuota gambar." } };
  }
  if (!allowed) {
    return {
      status: 429,
      body: { error: { message: QUOTA_EXHAUSTED_MESSAGE } },
    };
  }

  // 6. Satu percobaan saja — retry_on_error dimatikan.
  const client = new InferenceClient(hfToken);
  let output: unknown;
  try {
    output = await client.textToImage(
      {
        provider: "auto",
        model,
        inputs: prompt,
        parameters: {
          width: width.value,
          height: height.value,
          num_inference_steps: steps.value,
        },
      },
      {
        retry_on_error: false,
        signal: AbortSignal.timeout(HF_IMAGE_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const message = redact(extractMessage(err), hfToken);
    console.error("hf-image: gagal generate", message);
    return {
      status: extractStatus(err),
      body: { error: `HF image gagal: ${message}` },
    };
  }

  // 7. Blob → data URL base64.
  let dataUrl: string;
  try {
    dataUrl = await toDataUrl(output);
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err), hfToken);
    console.error("hf-image: output tidak valid", message);
    return { status: 502, body: { error: `HF image gagal: ${message}` } };
  }

  return { status: 200, body: imageResponseBody(dataUrl) };
}
