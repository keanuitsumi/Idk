// Halaman admin feedback. Versi Workers: HTML biasa (tanpa React / esm.sh),
// semua teks dari pengguna di-escape lewat esc().
import type { FeedbackRow, FeedbackStats } from "./feedback.ts";

export type AdminPageProps = {
  stats: FeedbackStats;
  rows: FeedbackRow[];
  csvHref: string;
};

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Tanggal ISO → teks ramah dibaca (WIB). Fallback ke teks aslinya. */
function formatDate(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  try {
    return new Date(ms).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " WIB";
  } catch {
    return new Date(ms).toISOString();
  }
}

function statCard(label: string, value: string, hint: string): string {
  return `
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">${esc(label)}</p>
      <p class="mt-1 text-3xl font-bold text-slate-900">${esc(value)}</p>
      <p class="mt-1 text-xs text-slate-500">${esc(hint)}</p>
    </div>`;
}

function ratingBadge(rating: number | null): string {
  if (rating === null) {
    return `<span class="inline-flex items-center rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-600">Tanpa rating</span>`;
  }
  return `<span class="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800" aria-label="Rating ${rating} dari 5"><span>${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span><span class="ml-2">${rating}/5</span></span>`;
}

function field(label: string, value: string): string {
  if (!value) return "";
  return `
      <div class="mt-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">${esc(label)}</p>
        <p class="whitespace-pre-wrap break-words text-sm text-slate-800">${esc(value)}</p>
      </div>`;
}

function submissionCard(row: FeedbackRow): string {
  const meta = [
    `#${row.id}`,
    row.app_version ? `v${row.app_version}` : "",
    row.lang,
    row.standalone ? "standalone" : "",
    row.anon_id ? `anon: ${row.anon_id}` : "",
  ].filter(Boolean).join(" · ");

  const models = row.models_used.length > 0
    ? `<div class="mt-3 flex flex-wrap gap-1.5">${
      row.models_used.map((m) =>
        `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">${esc(m)}</span>`
      ).join("")
    }</div>`
    : "";

  return `
    <article class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <header class="flex flex-wrap items-center justify-between gap-2">
        ${ratingBadge(row.rating)}
        <time class="text-xs text-slate-500" datetime="${esc(row.created_at)}">${esc(formatDate(row.created_at))}</time>
      </header>
      ${models}
      ${field("Liked", row.liked)}
      ${field("Improve", row.improve)}
      ${field("Contact", row.contact)}
      <p class="mt-3 break-words text-xs text-slate-400">${esc(meta)}</p>
    </article>`;
}

export function renderAdminPage({ stats, rows, csvHref }: AdminPageProps): string {
  const average = stats.average === null ? "–" : stats.average.toFixed(2);
  const ratedHint = stats.rated > 0
    ? `dari ${stats.rated} rating`
    : "belum ada rating";

  const list = rows.length === 0
    ? `<p class="mt-3 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">Belum ada kiriman feedback.</p>`
    : `<div class="mt-3 space-y-3">${rows.map(submissionCard).join("")}</div>`;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Feedback — AskScratch</title>
  <script src="https://cdn.twind.style" crossorigin></script>
</head>
<body class="bg-slate-100 font-sans text-slate-900 antialiased">
  <main class="mx-auto w-full max-w-3xl px-4 py-6">
    <header class="mb-5">
      <h1 class="text-2xl font-bold">Feedback AskScratch</h1>
      <p class="mt-1 text-sm text-slate-600">Panel admin · menampilkan ${rows.length} kiriman terbaru</p>
    </header>
    <section class="grid grid-cols-2 gap-3">
      ${statCard("Rata-rata rating", average, ratedHint)}
      ${statCard("Jumlah respons", String(stats.total), "total kiriman")}
    </section>
    <div class="mt-4 flex flex-wrap gap-2">
      <a href="${esc(csvHref)}" class="inline-flex items-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Unduh CSV</a>
    </div>
    <h2 class="mt-8 text-lg font-semibold">Kiriman terbaru</h2>
    ${list}
  </main>
</body>
</html>`;
}
