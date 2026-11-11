// AskScratch backend — versi Cloudflare Workers + D1 (dipindah dari Val Town "Yosh").
// Semua action dan bentuk balasan sama seperti versi Val Town.
import { handleAdmin } from "./admin.ts";
import { clientIp, submitFeedback } from "./feedback.ts";
import { handleHfImage } from "./hf-image.ts";
import { handleDeapiImage } from "./deapi-image.ts";
import { handleDeapiImageEdit } from "./deapi-image-edit.ts";
import { handleTavily } from "./tavily.ts";
import { handleHfCoder } from "./hf-coder.ts";
import { cleanupOld, getEnv, setEnv, takeRateHit } from "./platform.ts";

// Rate limit per IP: 20 request / 60 detik (jendela geser, disimpan di D1).
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function handler(req: Request): Promise<Response> {
  // Route admin: GET /admin?token=... (sebelum aturan "hanya POST").
  const url = new URL(req.url);
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return await handleAdmin(req, url);
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return Response.json(
      { error: "Gunakan method POST." },
      { headers: CORS_HEADERS, status: 405 },
    );
  }

  // Rate limit per IP. Kalau D1 bermasalah, jangan blokir chat.
  const ip = clientIp(req);
  let withinLimit = true;
  try {
    withinLimit = await takeRateHit(`ip:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  } catch (err) {
    console.error("rate limit: gagal", err instanceof Error ? err.message : err);
  }
  if (!withinLimit) {
    return Response.json(
      { error: { message: "Terlalu banyak request dari IP ini, coba lagi dalam beberapa saat." } },
      { headers: CORS_HEADERS, status: 429 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Body harus JSON." },
      { headers: CORS_HEADERS, status: 400 },
    );
  }

  const { action, payload, stream } = body;

  // Action "feedback": simpan ke D1, rate limit 5 kiriman/jam per IP.
  if (action === "feedback") {
    const result = await submitFeedback(payload, ip);
    return Response.json(result.body, {
      headers: CORS_HEADERS,
      status: result.status,
    });
  }

  const GROQ_KEY = getEnv("GROQ_KEY");
  const HF_TOKEN = getEnv("HF_TOKEN");
  const NVIDIA_KEY = getEnv("NVIDIA_KEY");
  const GEMINI_KEY = getEnv("GEMINI_KEY");
  const MISTRAL_KEY = getEnv("MISTRAL_KEY");
  const SERPER_KEY = getEnv("SERPER_KEY");
  const ZAI_KEY = getEnv("ZAI_KEY");
  const POOLSIDE_KEY = getEnv("POOLSIDE_API_KEY");

  let upstreamUrl = "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (action === "chat") {
    // Groq
    upstreamUrl = "https://api.groq.com/openai/v1/chat/completions";
    headers["Authorization"] = `Bearer ${GROQ_KEY}`;
  } else if (action === "multimodal") {
    // Hugging Face
    upstreamUrl = "https://router.huggingface.co/v1/chat/completions";
    headers["Authorization"] = `Bearer ${HF_TOKEN}`;
  } else if (action === "multimodal-nvidia") {
    // NVIDIA
    upstreamUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
    headers["Authorization"] = `Bearer ${NVIDIA_KEY}`;
  } else if (action === "gemma") {
    // Google AI Studio / Gemini API
    upstreamUrl =
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    headers["Authorization"] = `Bearer ${GEMINI_KEY}`;
  } else if (action === "mistral") {
    // Mistral
    upstreamUrl = "https://api.mistral.ai/v1/chat/completions";
    headers["Authorization"] = `Bearer ${MISTRAL_KEY}`;
  } else if (action === "zai") {
    // Z.ai (GLM) — OpenAI-compatible, endpoint global
    upstreamUrl = "https://api.z.ai/api/paas/v4/chat/completions";
    headers["Authorization"] = `Bearer ${ZAI_KEY}`;
  } else if (action === "poolside") {
    // Poolside Platform — request langsung ke inference.poolside.ai,
    // body dari client diteruskan apa adanya.
    if (!POOLSIDE_KEY) {
      return Response.json(
        { error: "POOLSIDE key tidak dikonfigurasi di environment." },
        { headers: CORS_HEADERS, status: 500 },
      );
    }

    const poolsideUrl = "https://inference.poolside.ai/v1/chat/completions";
    const callPoolside = (model?: string) =>
      fetch(poolsideUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${POOLSIDE_KEY}`,
        },
        // Kalau model di-override (retry tanpa prefix), sisanya tetap sama persis.
        body: JSON.stringify(model ? { ...payload, model } : payload),
      });

    let poolsideRes: Response;
    try {
      // 1) Coba dulu dengan model apa adanya (termasuk prefix "poolside/")
      poolsideRes = await callPoolside(payload?.model);
    } catch {
      return Response.json(
        { error: "Gagal terhubung ke Poolside API." },
        { headers: CORS_HEADERS, status: 502 },
      );
    }

    // 2) Kalau model ditolak, ulangi tanpa prefix "poolside/"
    const poolsideModel = payload?.model;
    if (
      !poolsideRes.ok &&
      typeof poolsideModel === "string" &&
      poolsideModel.startsWith("poolside/")
    ) {
      const poolsideErrText = await poolsideRes.text();
      const modelRejected = poolsideRes.status === 404 ||
        /model/i.test(poolsideErrText);
      if (!modelRejected) {
        // Auth / rate limit / payload kegedean — teruskan apa adanya.
        return new Response(poolsideErrText, {
          status: poolsideRes.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      try {
        poolsideRes = await callPoolside(
          poolsideModel.slice("poolside/".length),
        );
      } catch {
        return Response.json(
          { error: "Gagal terhubung ke Poolside API." },
          { headers: CORS_HEADERS, status: 502 },
        );
      }
    }

    // 3) Streaming SSE & non-streaming passthrough
    if (stream && poolsideRes.body) {
      return new Response(poolsideRes.body, {
        status: poolsideRes.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": poolsideRes.ok
            ? "text/event-stream"
            : "application/json",
          "Cache-Control": "no-cache",
        },
      });
    }

    const poolsideText = await poolsideRes.text();
    return new Response(poolsideText, {
      status: poolsideRes.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "deepinfra") {
    // DeepInfra — OpenAI-compatible. Body dari client diteruskan APA ADANYA.
    const DEEPINFRA_KEY = getEnv("DEEPINFRA_API_KEY");
    if (!DEEPINFRA_KEY) {
      return Response.json(
        {
          error: {
            message: "DEEPINFRA_API_KEY tidak dikonfigurasi di environment.",
          },
        },
        { headers: CORS_HEADERS, status: 500 },
      );
    }

    let deepinfraRes: Response;
    try {
      deepinfraRes = await fetch(
        "https://api.deepinfra.com/v1/openai/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${DEEPINFRA_KEY}`,
          },
          body: JSON.stringify(payload),
        },
      );
    } catch {
      return Response.json(
        { error: { message: "Gagal terhubung ke DeepInfra API." } },
        { headers: CORS_HEADERS, status: 502 },
      );
    }

    // Error DeepInfra: status ASLI diteruskan, body dinormalkan.
    if (!deepinfraRes.ok) {
      const deepinfraErrText = await deepinfraRes.text();
      let message: string = deepinfraErrText.trim();
      try {
        const parsed = JSON.parse(deepinfraErrText);
        message = parsed?.error?.message ??
          parsed?.message ??
          parsed?.detail ??
          message;
      } catch {
        // Bukan JSON — pakai teks mentah dari DeepInfra
      }
      if (!message) message = `DeepInfra error (${deepinfraRes.status})`;
      return Response.json(
        { error: { message: String(message).slice(0, 2000) } },
        { headers: CORS_HEADERS, status: deepinfraRes.status },
      );
    }

    if (stream && deepinfraRes.body) {
      return new Response(deepinfraRes.body, {
        status: deepinfraRes.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    const deepinfraText = await deepinfraRes.text();
    return new Response(deepinfraText, {
      status: deepinfraRes.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "tts") {
    // Hugging Face text-to-speech — audio biner
    const ttsUrl = "https://api-inference.huggingface.co/models/" + payload.model;
    const ttsRes = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: payload.inputs,
        options: { wait_for_model: true, use_cache: true },
      }),
    });
    const contentType = ttsRes.headers.get("content-type") || "";
    if (contentType.startsWith("audio")) {
      return new Response(ttsRes.body, {
        status: ttsRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": contentType },
      });
    }
    const errText = await ttsRes.text();
    return new Response(errText, {
      status: ttsRes.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "stt") {
    // Groq speech-to-text (Whisper) — decode audio base64, kirim multipart, balikin {text}
    if (!GROQ_KEY) {
      return Response.json(
        { error: "GROQ key tidak dikonfigurasi di environment." },
        { headers: CORS_HEADERS, status: 500 },
      );
    }
    if (!payload || typeof payload.audio !== "string" || !payload.audio.trim()) {
      return Response.json(
        { error: "Payload audio base64 wajib diisi." },
        { headers: CORS_HEADERS, status: 400 },
      );
    }

    const mime = (typeof payload.mime === "string" && payload.mime.trim())
      ? payload.mime.trim()
      : "audio/webm";
    const language = (typeof payload.language === "string" && payload.language.trim())
      ? payload.language.trim()
      : "id";
    const model = (typeof payload.model === "string" && payload.model.trim())
      ? payload.model.trim()
      : "whisper-large-v3-turbo";

    // 1. Decode base64 audio jadi bytes
    let audioBuffer: Uint8Array;
    try {
      const binary = atob(payload.audio);
      audioBuffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        audioBuffer[i] = binary.charCodeAt(i);
      }
    } catch {
      return Response.json(
        { error: "Audio base64 tidak valid." },
        { headers: CORS_HEADERS, status: 400 },
      );
    }

    // 2. Kirim sebagai multipart/form-data ke Groq
    const form = new FormData();
    form.append("file", new Blob([audioBuffer], { type: mime }), "recording");
    form.append("model", model);
    form.append("language", language);

    let groqRes: Response;
    try {
      groqRes = await fetch(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_KEY}` },
          body: form,
        },
      );
    } catch {
      return Response.json(
        { error: "Gagal terhubung ke Groq Speech-to-Text API." },
        { headers: CORS_HEADERS, status: 502 },
      );
    }

    const groqData = await groqRes.json().catch(() => null);
    if (!groqRes.ok) {
      const message = groqData?.error?.message || groqData?.message || "terjadi kesalahan";
      return Response.json(
        { error: `Groq STT gagal: ${message}` },
        { headers: CORS_HEADERS, status: groqRes.status || 502 },
      );
    }

    return Response.json({ text: groqData?.text ?? "" }, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "news") {
    // Serper News — ambil { q } dan balikin hasil JSON apa adanya
    if (!SERPER_KEY) {
      return Response.json(
        { error: "SERPER key tidak dikonfigurasi di environment." },
        { headers: CORS_HEADERS, status: 500 },
      );
    }
    const q = (payload && typeof payload.q === "string" && payload.q.trim())
      ? payload.q.trim()
      : "berita terbaru indonesia";
    let newsRes: Response;
    try {
      newsRes = await fetch("https://google.serper.dev/news", {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q, gl: "id", hl: "id", num: 8 }),
      });
    } catch {
      return Response.json(
        { error: "Gagal terhubung ke Serper News API." },
        { headers: CORS_HEADERS, status: 502 },
      );
    }
    if (!newsRes.ok) {
      const errText = await newsRes.text();
      return new Response(errText, {
        status: newsRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const newsJson = await newsRes.json();
    return Response.json(newsJson, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "search") {
    // Serper
    upstreamUrl = "https://google.serper.dev/search";
    headers["X-API-KEY"] = SERPER_KEY ?? "";
  } else if (action === "shopping") {
    // Serper shopping
    upstreamUrl = "https://google.serper.dev/shopping";
    headers["X-API-KEY"] = SERPER_KEY ?? "";
  } else if (action === "openrouter-image") {
    // OpenRouter — image generation (FLUX). Non-streaming (stream dipaksa false).
    const OPENROUTER_KEY = getEnv("OPENROUTER_KEY");
    if (!OPENROUTER_KEY) {
      return Response.json(
        { error: "OPENROUTER key tidak dikonfigurasi di environment." },
        { headers: CORS_HEADERS, status: 500 },
      );
    }

    let openrouterRes: Response;
    try {
      openrouterRes = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENROUTER_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://askscratch.netlify.app",
            "X-Title": "AskScratch - K-Oss Image",
          },
          body: JSON.stringify({ ...payload, stream: false }),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch {
      return Response.json(
        { error: "Gagal terhubung ke OpenRouter API." },
        { headers: CORS_HEADERS, status: 502 },
      );
    }

    if (!openrouterRes.ok) {
      const openrouterErrText = await openrouterRes.text();
      return new Response(openrouterErrText, {
        status: openrouterRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const openrouterJson = await openrouterRes.json();
    return Response.json(openrouterJson, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "openrouter-nex") {
    // OpenRouter — Nex. Payload diteruskan APA ADANYA; hanya `model` divalidasi.
    const NEX_MODEL = "nex-agi/nex-n2.5-pro";

    if (!payload || payload.model !== NEX_MODEL) {
      return Response.json(
        { error: `Model tidak diizinkan. Hanya "${NEX_MODEL}" yang didukung.` },
        { headers: CORS_HEADERS, status: 400 },
      );
    }

    const OPENROUTER_NEX_KEY = getEnv("OPENROUTER_API_KEY_NEX");
    if (!OPENROUTER_NEX_KEY) {
      return Response.json(
        { error: "OPENROUTER_API_KEY_NEX belum diset" },
        { headers: CORS_HEADERS, status: 500 },
      );
    }

    let nexRes: Response;
    try {
      nexRes = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENROUTER_NEX_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "AskScratch",
            "X-Title": "AskScratch",
          },
          body: JSON.stringify(payload),
        },
      );
    } catch {
      return Response.json(
        { error: "Gagal terhubung ke OpenRouter API." },
        { headers: CORS_HEADERS, status: 502 },
      );
    }

    // Error dari OpenRouter diteruskan apa adanya (body + status code).
    if (!nexRes.ok) {
      const nexErrText = await nexRes.text();
      return new Response(nexErrText, {
        status: nexRes.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (stream && nexRes.body) {
      return new Response(nexRes.body, {
        status: nexRes.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    const nexText = await nexRes.text();
    return new Response(nexText, {
      status: nexRes.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } else if (action === "hf-image") {
    // Generate gambar via Hugging Face Inference Providers.
    const hfImageResult = await handleHfImage(payload, req);
    return Response.json(hfImageResult.body, {
      headers: CORS_HEADERS,
      status: hfImageResult.status,
    });
  } else if (action === "deapi-image") {
    // Generate gambar via deAPI.
    try {
      const r = await handleDeapiImage(payload, req);
      return Response.json(r.body, { headers: CORS_HEADERS, status: r.status });
    } catch (err) {
      console.error("deapi-image error:", err);
      return Response.json(
        { error: "deAPI image error internal: " + (err instanceof Error ? err.message : String(err)) },
        { headers: CORS_HEADERS, status: 500 },
      );
    }
  } else if (action === "deapi-image-edit") {
    // Edit gambar (image-to-image) via deAPI.
    try {
      const r = await handleDeapiImageEdit(payload, req);
      return Response.json(r.body, { headers: CORS_HEADERS, status: r.status });
    } catch (err) {
      console.error("deapi-image-edit error:", err);
      return Response.json(
        { error: "deAPI image edit error internal: " + (err instanceof Error ? err.message : String(err)) },
        { headers: CORS_HEADERS, status: 500 },
      );
    }
  } else if (action === "tavily") {
    // Pencarian web via Tavily (cache D1 6 jam + kuota harian).
    const tavilyResult = await handleTavily(payload, req);
    return Response.json(tavilyResult.body, {
      headers: CORS_HEADERS,
      status: tavilyResult.status,
    });
  } else if (action === "hf-coder") {
    // Router Hugging Face khusus coding (selalu streaming SSE).
    return await handleHfCoder(payload, stream, CORS_HEADERS);
  } else {
    return Response.json(
      { error: "Action tidak dikenali." },
      { headers: CORS_HEADERS, status: 400 },
    );
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (stream && upstreamRes.body) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstreamRes.ok
          ? "text/event-stream"
          : "application/json",
        "Cache-Control": "no-cache",
      },
    });
  }

  const data = await upstreamRes.text();

  return new Response(data, {
    status: upstreamRes.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ── Pintu masuk Cloudflare Workers ───────────────────────────
export default {
  // deno-lint-ignore no-explicit-any
  async fetch(req: Request, env: any, ctx: any): Promise<Response> {
    setEnv(env);
    // Bersih-bersih tabel kuota/laju sesekali (±2% request), tanpa menahan balasan.
    if (Math.random() < 0.02) ctx.waitUntil(cleanupOld().catch(() => {}));
    return await handler(req);
  },
};
