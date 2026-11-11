// ─────────────────────────────────────────────────────────────
// AskScratch — action "deapi-image-edit"
// Edit gambar (image-to-image) lewat deAPI, model FLUX.2 [klein].
// Memakai key, kuota, dan penjaga laju yang SAMA dengan "deapi-image".
// ─────────────────────────────────────────────────────────────
import { getEnv } from "./platform.ts";
import { clientIp, hashIp } from "./feedback.ts";
import {
  DEAPI_KEY_PREFIX,
  releaseDeapiQuota,
  reserveDeapiQuota,
  resolveDailyCap,
  resolveRpm,
  takeRateSlot,
  utcDay,
} from "./deapi-image.ts";

export const DEAPI_IMAGE_EDIT_ALLOWED_MODELS = ["Flux_2_Klein_4B_BF16"] as const;

const ALLOWED_MODELS_TEXT = DEAPI_IMAGE_EDIT_ALLOWED_MODELS
  .map((m) => `"${m}"`)
  .join(" dan ");

export const DEAPI_IMAGE_EDIT_MAX_PROMPT_LENGTH = 1200;
export const DEAPI_IMAGE_EDIT_MAX_BASE64_LENGTH = 6_000_000;
const MAX_IMAGE_BYTES = 4_500_000;
/** deAPI menolak gambar di bawah 1 KB — dicek di sini biar 400-nya jelas. */
const MIN_IMAGE_BYTES = 1024;

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const DEAPI_IMAGE_EDIT_ENDPOINT = "https://oai.deapi.ai/v1/images/edits";
const DEAPI_IMAGE_EDIT_TIMEOUT_MS = 80_000;
const DEAPI_IMAGE_FETCH_TIMEOUT_MS = 20_000;

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

type EditInput = { text: string; imageUrl: string };

/** Ambil teks + gambar dari pesan user terakhir di `messages`. */
function extractEditInput(payload: Record<string, unknown>): EditInput {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return { text: "", imageUrl: "" };

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    const role = message.role;
    if (role !== undefined && role !== "user") continue;

    const content = message.content;
    const textParts: string[] = [];
    let imageUrl = "";

    if (typeof content === "string") {
      textParts.push(content.trim());
    } else if (Array.isArray(content)) {
      for (const rawPart of content) {
        const part = asRecord(rawPart);
        const type = part.type;

        if ((type === "text" || type === undefined) && typeof part.text === "string") {
          textParts.push(part.text.trim());
          continue;
        }

        if (type === "image_url" && !imageUrl) {
          const direct = part.image_url;
          const nested = asRecord(direct).url;
          if (typeof direct === "string") imageUrl = direct.trim();
          else if (typeof nested === "string") imageUrl = nested.trim();
        }
      }
    }

    const text = textParts.filter(Boolean).join("\n").trim();
    if (text || imageUrl) return { text, imageUrl };
  }
  return { text: "", imageUrl: "" };
}

type DecodedImage =
  | { ok: true; bytes: Uint8Array; mime: string; ext: string }
  | { ok: false; status: number; message: string };

/** Validasi data-URL gambar, lalu decode base64 jadi bytes. */
function decodeImage(imageUrl: string): DecodedImage {
  if (!imageUrl) {
    return {
      ok: false,
      status: 400,
      message: 'Payload "messages" harus berisi gambar (content type "image_url").',
    };
  }

  const match = /^data:([^;,]+);base64,(.*)$/is.exec(imageUrl);
  if (!match) {
    return {
      ok: false,
      status: 400,
      message: "Gambar harus berupa data-URL base64 (image/jpeg, image/png, atau image/webp).",
    };
  }

  const mime = match[1].toLowerCase().trim();
  const ext = ALLOWED_IMAGE_TYPES[mime];
  if (!ext) {
    return {
      ok: false,
      status: 400,
      message: "Format gambar hanya image/jpeg, image/png, atau image/webp yang didukung.",
    };
  }

  const b64 = match[2].replace(/\s+/g, "");
  if (!b64) {
    return { ok: false, status: 400, message: "Gambar base64 kosong." };
  }
  if (b64.length > DEAPI_IMAGE_EDIT_MAX_BASE64_LENGTH) {
    return {
      ok: false,
      status: 413,
      message: "Gambar terlalu besar. Maksimal sekitar 4.5 MB.",
    };
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(b64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return { ok: false, status: 400, message: "Gambar base64 tidak valid." };
  }

  if (bytes.length < MIN_IMAGE_BYTES) {
    return { ok: false, status: 400, message: "Gambar terlalu kecil. Minimal 1 KB." };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 413,
      message: "Gambar terlalu besar. Maksimal sekitar 4.5 MB.",
    };
  }

  return { ok: true, bytes, mime, ext };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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

// ── Handler action ───────────────────────────────────────────

export type DeapiImageEditResult = {
  status: number;
  body: Record<string, unknown>;
};

/** Balasan sukses — bentuknya sama dengan action "deapi-image". */
function imageResponseBody(url: string): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          images: [{ image_url: { url } }],
        },
      },
    ],
  };
}

function errorBody(message: string): Record<string, unknown> {
  return { error: { message } };
}

export async function handleDeapiImageEdit(
  payload: unknown,
  req: Request,
): Promise<DeapiImageEditResult> {
  const p = asRecord(payload);

  // 1. Allowlist model.
  const model = typeof p.model === "string" ? p.model.trim() : "";
  if (!(DEAPI_IMAGE_EDIT_ALLOWED_MODELS as readonly string[]).includes(model)) {
    return {
      status: 400,
      body: errorBody(
        `Model tidak diizinkan. Hanya ${ALLOWED_MODELS_TEXT} yang didukung.`,
      ),
    };
  }

  // 2. Instruksi edit + gambar dari pesan user.
  const input = extractEditInput(p);
  if (!input.text) {
    return {
      status: 400,
      body: errorBody('Payload "messages" harus berisi pesan user dengan instruksi edit.'),
    };
  }
  if (input.text.length > DEAPI_IMAGE_EDIT_MAX_PROMPT_LENGTH) {
    return {
      status: 400,
      body: errorBody(
        `Instruksi edit terlalu panjang. Maksimal ${DEAPI_IMAGE_EDIT_MAX_PROMPT_LENGTH} karakter.`,
      ),
    };
  }

  // 3. Gambar: data-URL jpeg/png/webp → bytes.
  const image = decodeImage(input.imageUrl);
  if (!image.ok) {
    return { status: image.status, body: errorBody(image.message) };
  }

  // 4. Key deAPI dari env (sama dengan "deapi-image"). Tidak pernah di-log.
  const rawKey = getEnv("DEAPI_KEY");
  if (!rawKey || !rawKey.trim()) {
    return {
      status: 500,
      body: { error: "DEAPI key tidak dikonfigurasi di environment." },
    };
  }
  const key = rawKey.trim();
  const authKey = key.startsWith(DEAPI_KEY_PREFIX) ? key : `${DEAPI_KEY_PREFIX}${key}`;

  // 5. Penjaga laju — dicek SEBELUM kuota.
  if (!(await takeRateSlot(resolveRpm()))) {
    return { status: 429, body: errorBody(BUSY_MESSAGE) };
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
      "deapi-image-edit: gagal memeriksa kuota",
      err instanceof Error ? err.message : err,
    );
    return { status: 500, body: { error: "Gagal memeriksa kuota gambar." } };
  }
  if (!allowed) {
    return { status: 429, body: errorBody(QUOTA_EXHAUSTED_MESSAGE) };
  }

  // 7. Kirim multipart/form-data ke deAPI. Satu percobaan saja.
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", input.text);
  form.append(
    "image",
    new Blob([image.bytes], { type: image.mime }),
    `input.${image.ext}`,
  );

  let res: Response;
  try {
    res = await fetch(DEAPI_IMAGE_EDIT_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authKey}`,
        // Content-Type (termasuk boundary) diisi otomatis oleh fetch.
      },
      body: form,
      signal: AbortSignal.timeout(DEAPI_IMAGE_EDIT_TIMEOUT_MS),
    });
  } catch (err) {
    await releaseDeapiQuota(day, ipHash);
    const message = redact(
      shorten(err instanceof Error ? err.message : String(err)),
      authKey,
    ) || "terjadi kesalahan";
    console.error("deapi-image-edit: gagal terhubung", message);
    return { status: 502, body: errorBody(`deAPI image edit gagal: ${message}`) };
  }

  let resBody: unknown = null;
  try {
    resBody = await res.json();
  } catch {
    resBody = null;
  }

  // 8. Error deAPI: status ASLI diteruskan, body dinormalkan.
  if (!res.ok) {
    const upstream = extractUpstreamError(resBody);
    console.error(
      "deapi-image-edit: gagal edit",
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
      return { status: 429, body: errorBody(QUOTA_EXHAUSTED_MESSAGE) };
    }
    if (res.status === 429) {
      await releaseDeapiQuota(day, ipHash);
      return { status: 429, body: errorBody(BUSY_MESSAGE) };
    }

    await releaseDeapiQuota(day, ipHash);
    const message = redact(shorten(upstream.message), authKey) ||
      "terjadi kesalahan";
    return {
      status: res.status || 502,
      body: errorBody(`deAPI image edit gagal: ${message}`),
    };
  }

  // 9. Hasil: data[0].b64_json ATAU data[0].url.
  const data = asRecord(resBody).data;
  const first = Array.isArray(data) ? asRecord(data[0]) : {};
  const b64 = typeof first.b64_json === "string" ? first.b64_json.trim() : "";
  const remoteUrl = typeof first.url === "string" ? first.url.trim() : "";

  if (b64) {
    const dataUrl = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
    return { status: 200, body: imageResponseBody(dataUrl) };
  }

  if (remoteUrl) {
    // Ambil di server supaya frontend (canvas watermark) tidak kena CORS.
    try {
      const imgRes = await fetch(remoteUrl, {
        signal: AbortSignal.timeout(DEAPI_IMAGE_FETCH_TIMEOUT_MS),
      });
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);

      const buf = new Uint8Array(await imgRes.arrayBuffer());
      if (buf.length === 0) throw new Error("gambar kosong");

      const contentType = (imgRes.headers.get("content-type") || "").split(";")[0]
        .trim().toLowerCase();
      const mime = ALLOWED_IMAGE_TYPES[contentType] ? contentType : "image/png";

      return {
        status: 200,
        body: imageResponseBody(`data:${mime};base64,${bytesToBase64(buf)}`),
      };
    } catch (err) {
      // Gagal fetch → kembalikan URL aslinya (jangan potong kuota).
      console.error(
        "deapi-image-edit: gagal mengambil hasil URL",
        redact(shorten(err instanceof Error ? err.message : String(err)), authKey),
      );
      return { status: 200, body: imageResponseBody(remoteUrl) };
    }
  }

  // Respons tanpa gambar — slot dikembalikan.
  await releaseDeapiQuota(day, ipHash);
  console.error("deapi-image-edit: respons deAPI tidak berisi gambar");
  return {
    status: 502,
    body: errorBody("deAPI image edit gagal: respons tidak berisi gambar."),
  };
}
