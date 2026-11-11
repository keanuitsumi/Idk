// ─────────────────────────────────────────────────────────────
// AskScratch — route GET /admin?token=...
//   ?token=<ADMIN_TOKEN>            → halaman HTML daftar feedback
//   ?token=<ADMIN_TOKEN>&format=csv → unduh CSV
// Token dibandingkan dengan env ADMIN_TOKEN; selain itu 403.
// ─────────────────────────────────────────────────────────────
import {
  type FeedbackRow,
  getFeedbackStats,
  listFeedback,
} from "./feedback.ts";
import { renderAdminPage } from "./admin-page.ts";
import { getEnv } from "./platform.ts";

const PAGE_ROWS = 200;
const CSV_ROWS = 10_000;

/** Perbandingan string yang tidak bocor lewat waktu eksekusi. */
export function isValidAdminToken(
  token: string | null,
  expected: string | null,
): boolean {
  if (!token || !expected) return false; // ADMIN_TOKEN belum diset → selalu 403
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** CSV: bungkus tiap field dengan kutip ganda. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function csvNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export function toCsv(rows: FeedbackRow[]): string {
  const header = [
    "id",
    "created_at",
    "anon_id",
    "app_version",
    "rating",
    "models_used",
    "liked",
    "improve",
    "contact",
    "lang",
    "standalone",
    "ip_hash",
  ].join(",");

  const lines = rows.map((row) =>
    [
      csvNumber(row.id),
      csvField(row.created_at),
      csvField(row.anon_id),
      csvField(row.app_version),
      csvNumber(row.rating),
      csvField(row.models_used.join(", ")),
      csvField(row.liked),
      csvField(row.improve),
      csvField(row.contact),
      csvField(row.lang),
      csvNumber(row.standalone),
      csvField(row.ip_hash),
    ].join(",")
  );

  return [header, ...lines].join("\r\n") + "\r\n";
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function handleAdmin(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") {
    return plain(405, "Method Not Allowed");
  }

  const token = url.searchParams.get("token");
  if (!isValidAdminToken(token, getEnv("ADMIN_TOKEN") ?? null)) {
    return plain(403, "403 Forbidden");
  }

  const format = (url.searchParams.get("format") ?? "").toLowerCase();

  if (format === "csv") {
    const rows = await listFeedback(CSV_ROWS);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response("\uFEFF" + toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="askscratch-feedback-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const [stats, rows] = await Promise.all([
    getFeedbackStats(),
    listFeedback(PAGE_ROWS),
  ]);

  const csvHref = `/admin?token=${encodeURIComponent(token ?? "")}&format=csv`;

  return new Response(renderAdminPage({ stats, rows, csvHref }), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
