# Migrasi Yosh (AskScratch backend): Val Town → Cloudflare Workers + D1

Tenggat Val Town: read-only 10 Des 2026, semua layanan mati 10 Jan 2027.

## Langkah deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create askscratch-db
#  → salin database_id dari output ke wrangler.toml
npx wrangler d1 execute askscratch-db --remote --file=schema.sql
```

Isi secret satu per satu (nilainya salin dari halaman Environment variables val Yosh;
tool tidak bisa membaca nilai secret):

```bash
npx wrangler secret put GROQ_KEY
npx wrangler secret put HF_TOKEN
npx wrangler secret put HF_API_KEY_3
npx wrangler secret put NVIDIA_KEY
npx wrangler secret put GEMINI_KEY
npx wrangler secret put MISTRAL_KEY
npx wrangler secret put SERPER_KEY
npx wrangler secret put ZAI_KEY
npx wrangler secret put POOLSIDE_API_KEY
npx wrangler secret put DEEPINFRA_API_KEY
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put OPENROUTER_API_KEY_NEX
npx wrangler secret put DEAPI_KEY
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put ADMIN_TOKEN
```

Opsional, isi hanya kalau di Val Town nilainya kamu ubah dari default:
`HF_IMAGE_DAILY_CAP` (ada di Val Town, cek nilainya; default kode 40), `TAVILY_DAILY_CAP` (30),
`DEAPI_IMAGE_DAILY_CAP` (90), `DEAPI_RPM` (3). Taruh di `[vars]` pada `wrangler.toml`.
`DEEPSEEK_KEY` tidak dipakai oleh kode, jadi tidak perlu dipindah.

```bash
npx wrangler deploy
```

Hasilnya URL `https://askscratch.<akun>.workers.dev`.

## Tes cepat

```bash
curl -s -X POST https://URL-WORKER/ -H "content-type: application/json" \
  -d '{"action":"feedback","payload":{"rating":5,"liked":"tes"}}'
# → {"ok":true}
```
Lalu buka `https://URL-WORKER/admin?token=ADMIN_TOKEN`, dan coba chat dari aplikasi.

## Setelah itu

1. Ganti URL `askscratch.val.run` di frontend (askscratch.netlify.app) ke URL Worker. CORS sudah `*`.
2. Data: hanya tabel `feedback` yang layak dipindah (isi tabel lain cuma cache/kuota harian dan
   akan terisi ulang sendiri). Ekspor dari Val Town lalu impor ke D1 dengan `wrangler d1 execute --file=`.

## Beda perilaku dari versi Val Town

- IP klien kini diambil dari `cf-connecting-ip` (tidak bisa dipalsukan). Di Val Town, entri pertama
  `x-forwarded-for` bisa diisi klien sehingga limit IP bisa dilewati.
- Limit 20 request/menit per IP dan penjaga laju deAPI (3/menit) kini disimpan di D1 (jendela geser),
  bukan di memori, supaya berlaku lintas isolate.
- Halaman `/admin` ditulis ulang sebagai HTML biasa (tanpa React dari esm.sh); skrip `esm.town/std/catch` dihapus.
- Baris lama di tabel kuota dan laju dibersihkan otomatis (sesekali, di latar belakang).

## Sudah diuji / belum

Sudah diuji lokal (D1 tiruan di atas SQLite, 21 pengecekan lulus): routing, CORS, limit IP, feedback
dan limit 5/jam, halaman admin (termasuk escape XSS) dan CSV, cache + kuota Tavily, penjaga laju deAPI,
kuota hf-image, dan penerusan ke Groq/DeepInfra/HF coder termasuk SSE.

Belum diuji: deploy sungguhan ke Cloudflare dan panggilan nyata ke provider. `@huggingface/inference`
disimulasikan saat tes, jadi coba action `hf-image` setelah deploy. Endpoint `tts` memakai
`api-inference.huggingface.co` seperti kode lama; kalau sudah tidak jalan, itu masalah di luar migrasi ini.
