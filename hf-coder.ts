// ─────────────────────────────────────────────────────────────
// AskScratch — action "hf-coder"
// Pass-through tipis ke https://router.huggingface.co/v1/chat/completions
//   • Secret dari env `HF_API_KEY_3`, tidak pernah di-log (di-redact).
//   • Payload klien diteruskan APA ADANYA; hanya `stream` dipaksa `true`.
//   • SSE diteruskan mentah tanpa buffering.
//   • Upstream non-2xx → status + body error diteruskan apa adanya.
// ─────────────────────────────────────────────────────────────
import { getEnv } from "./platform.ts";

export const HF_CODER_URL = "https://router.huggingface.co/v1/chat/completions";
export const HF_CODER_KEY_ENV = "HF_API_KEY_3";

type CorsHeaders = Record<string, string>;

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function jsonResponse(body: unknown, status: number, cors: CorsHeaders): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number, cors: CorsHeaders): Response {
  return jsonResponse({ error: { message } }, status, cors);
}

export async function handleHfCoder(
  payload: unknown,
  _stream: unknown,
  cors: CorsHeaders,
): Promise<Response> {
  // 1. Kredensial dari environment.
  const hfToken = getEnv(HF_CODER_KEY_ENV);
  if (!hfToken) {
    return errorResponse(
      `${HF_CODER_KEY_ENV} belum diset di environment.`,
      500,
      cors,
    );
  }

  // 2. Payload harus object JSON.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse("Payload harus berupa object JSON.", 400, cors);
  }

  // 3. Teruskan apa adanya — hanya `stream` yang dipaksa `true`.
  const upstreamBody = {
    ...(payload as Record<string, unknown>),
    stream: true,
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(HF_CODER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${hfToken}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    const message = redact(
      err instanceof Error ? err.message : String(err),
      hfToken,
    );
    console.error("hf-coder: gagal terhubung ke Hugging Face router", message);
    return errorResponse("Gagal terhubung ke Hugging Face router.", 502, cors);
  }

  // 4. Upstream non-2xx → status + body error diteruskan APA ADANYA.
  if (!upstreamRes.ok) {
    const errText = redact(await upstreamRes.text(), hfToken);
    return new Response(errText, {
      status: upstreamRes.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // 5. 2xx tapi tanpa body (jarang) — jangan buang isinya.
  if (!upstreamRes.body) {
    const text = redact(await upstreamRes.text(), hfToken);
    return new Response(text, {
      status: upstreamRes.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // 6. Streaming SSE: teruskan body upstream mentah tanpa di-buffer.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
