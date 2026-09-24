# Minimal Chat

Website chatbot minimalis: login, banyak chat, pilih model, lampiran file, history + konteks tersimpan di Supabase.
API key model **nggak pernah sampai ke browser**: disimpan di Edge Function secrets.

![Preview](docs/preview.png)

```
minimal-chat/
├── supabase/
│   ├── schema.sql              ← tabel + Row Level Security (install baru: jalankan ini aja)
│   ├── upgrade-v2.sql          ← buat yang udah install versi pertama
│   ├── upgrade-v3.sql          ← buat yang udah install v2 (file, edit, retry)
│   └── functions/chat/index.ts ← Edge Function: panggil model, stream, simpan history, memory
└── web/                        ← frontend statis (tanpa build)
    ├── index.html
    ├── style.css
    ├── app.js
    ├── artifacts.js            ← panel artifact (preview HTML/SVG/dokumen)
    ├── files.js                ← baca lampiran di browser (PDF, Word, Excel, PowerPoint, video, …)
    ├── tree.js                 ← versi pesan (edit & retry)
    ├── ambient.js              ← animasi background waktu chat masih kosong
    └── config.js               ← isi URL + key Supabase + daftar model + harga di sini

## Fitur

- **Chat + history** tersimpan di Supabase, pilih model per pesan, streaming, tombol Stop, markdown
- **Lampiran file** (tombol 📎, paste, atau drag & drop, maksimal 10 file per pesan): gambar, PDF (termasuk hasil scan), Word, Excel, PowerPoint, OpenDocument, EPUB, CSV, kode, ZIP, video. Detailnya di bagian **Lampiran file** di bawah
- **Edit** pesan lo dan **Retry** balasan (pakai model yang lagi dipilih). Versi lama nggak hilang: pindah-pindah pakai ‹ 1/2 ›, dan chat kebuka lagi di versi terakhir yang lo lihat
- **Copy** pesan lo, balasan, dan tiap blok kode
- **Animasi background** di layar chat baru (titik-titik yang bergelombang pelan, ikut gerak kursor). Diem kalau di HP/laptop lo nyalain "reduce motion"
- **Artifacts**: model bisa bikin halaman web, app kecil, SVG, atau dokumen panjang yang muncul di panel samping (Preview / Code, versi v1–v2–v3, Copy, Download). Preview jalan di iframe terisolasi, jadi kodenya nggak bisa ngakses login atau data lo
- **Settings** ala Claude:
  - **General**: tema (System/Light/Dark), notifikasi browser pas balasan selesai, instruksi buat semua chat
  - **Usage**: pemakaian token & estimasi biaya bulan ini dan hari ini, grafik harian, per model, budget bulanan
  - **Capabilities**: nyalain/matiin Artifacts
  - **Memory**: memory otomatis dari chat (bisa dilihat, diedit, dihapus, atau disuruh "tambah/ubah/hapus …"), plus "Search and reference chats"
  - **Account**: export semua data (JSON), hapus semua chat, sign out
- **Cari chat** di sidebar: judul langsung, isi pesan per kata
```

## 1 API key buat semua model?

Tergantung key-nya dari mana:

| Key dari | Bisa pakai model apa | Yang perlu diubah |
|---|---|---|
| **OpenRouter** (default) | Claude, GPT, Gemini, DeepSeek, Llama, dll. Semuanya pakai 1 key | Nggak ada, langsung jalan |
| OpenAI | Cuma model OpenAI | `LLM_BASE_URL` + id model di `config.js` |
| Anthropic | Cuma Claude | `LLM_BASE_URL` + id model di `config.js` |
| Google AI Studio | Cuma Gemini | `LLM_BASE_URL` + id model di `config.js` |

Function-nya ngomong pakai format OpenAI-compatible `/chat/completions`, jadi semua provider di atas bisa. Kalau key-nya **bukan** OpenRouter, set secret `LLM_BASE_URL` dan ganti id model:

| Provider | `LLM_BASE_URL` | Contoh id model |
|---|---|---|
| OpenRouter | *(kosongin)* | `anthropic/claude-sonnet-5`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview` |
| GutsAI (1 key, banyak model) | `https://api.gutsai.id/v1` | `claude-sonnet-5`, `gpt-5.5`, `deepseek-v4-pro` (daftar lengkap udah ada di `config.js`) |
| OpenAI | `https://api.openai.com/v1` | `gpt-5.5`, `gpt-5.4-mini` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.1-pro-preview`, `gemini-3-flash-preview` |

Id model yang persis bisa dicek di dokumentasi provider masing-masing (OpenRouter: [openrouter.ai/models](https://openrouter.ai/models)).

---

## Setup (±15 menit, semua lewat Dashboard, nggak perlu install apa-apa)

### 1. Bikin project Supabase
[supabase.com/dashboard](https://supabase.com/dashboard) → **New project**. Tunggu sampai siap.

### 2. Bikin tabel
**SQL Editor** → **New query** → paste seluruh isi `supabase/schema.sql` → **Run**.
(File ini udah termasuk semua fitur v2 dan v3, termasuk bucket Storage `chat-files` buat lampiran. `upgrade-v2.sql` / `upgrade-v3.sql` cuma buat yang install versi lama, lihat bagian **Update** di bawah.)
Harusnya muncul "Success". Tabel `chat_conversations`, `chat_messages`, `chat_settings`, `chat_memories`, dan `chat_attachments` sekarang ada di **Table Editor**, dan bucket `chat-files` di **Storage**.

### 3. Deploy Edge Function
**Edge Functions** → **Deploy a new function** → **Via Editor**.
- Nama function: **`chat`** (harus persis ini)
- Hapus kode contoh, paste seluruh isi `supabase/functions/chat/index.ts` → **Deploy**
- Biarkan **Verify JWT** tetap **ON** (default)

### 4. Simpan API key
**Edge Functions** → **Secrets** → tambah:

| Name | Value |
|---|---|
| `LLM_API_KEY` | API key kamu |
| `ALLOWED_EMAILS` | email kamu (disarankan, biar cuma kamu yang bisa pakai kuota API-nya) |
| `LLM_BASE_URL` | *hanya kalau key-nya bukan OpenRouter* (lihat tabel di atas) |

Secret langsung aktif, nggak perlu deploy ulang.

### 5. Bikin akun kamu
**Authentication** → **Users** → **Add user** → **Create new user** → isi email + password, centang **Auto Confirm User**.

Setelah itu matikan pendaftaran publik: **Authentication** → **Sign In / Providers** → matikan **Allow new users to sign up**. Di `web/config.js` juga set `ALLOW_SIGN_UP = false`.

### 6. Isi `web/config.js`
Ambil dari **Project Settings** → **API Keys**:

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_xxx' // atau legacy "anon" key
```

Dua nilai ini **aman ditaruh di frontend**: datanya dilindungi Row Level Security, dan API key model cuma ada di secrets.

### 7. Online-kan
Paling gampang: [app.netlify.com/drop](https://app.netlify.com/drop) → drag folder **`web`** → dapat URL. Bisa juga GitHub Pages / Vercel (semuanya file statis).

> Jangan buka `index.html` langsung dengan double-click (`file://`), karena browser nge-blok module JS. Harus lewat server, misalnya Netlify, atau lokal pakai `npx serve web` / ekstensi Live Server di VS Code.

Buka URL-nya → login → chat.

---

## Update

### Ke v3: file, edit, retry (kalau udah pakai v2)

1. **Database**: SQL Editor → paste isi `supabase/upgrade-v3.sql` → **Run**. File ini bikin tabel `chat_attachments`, bucket Storage `chat-files` (private, maks 25 MB per file), dan nyambungin pesan-pesan lama jadi satu alur. Aman dijalanin lebih dari sekali.
2. **Edge Function**: Edge Functions → `chat` → **Code** → ganti seluruh isinya dengan `supabase/functions/chat/index.ts` yang baru → **Deploy**.
3. **Frontend**: timpa folder `web/` di repo lo (ada file baru `files.js`, `tree.js`, `ambient.js`), terus `git add .` → `git commit` → `git push`. Cloudflare Pages deploy otomatis.

Kalau langkah 1 kelewat, chat biasa tetap jalan. Tombol lampiran, Edit, dan Retry bakal ngasih tahu buat jalanin `upgrade-v3.sql` dulu.

### Ke v2 (kalau masih versi pertama)

Jalanin `supabase/upgrade-v2.sql` dulu, baru `upgrade-v3.sql`, terus langkah 2 & 3 di atas. Opsional: tambah secret `MEMORY_MODEL` = model murah buat update memory, misalnya `deepseek-v4-flash`. Tanpa ini, memory pakai model yang sama dengan chat.

## Lampiran file

File dibaca **di browser lo**, terus yang dikirim ke model adalah hal yang dia ngerti:

| File | Yang diterima model |
|---|---|
| Gambar (PNG, JPG, WebP, GIF, HEIC di Safari, …) | Gambarnya. Yang gede diperkecil ke maks 2048 px biar hemat token |
| PDF | Teks tiap halaman. PDF hasil scan (nggak ada teksnya) → 10 halaman pertama dikirim sebagai gambar |
| Word, Excel, PowerPoint (`docx`, `xlsx`, `pptx`), OpenDocument, EPUB | Teksnya: judul, list, tabel, isi tiap sheet (CSV), isi tiap slide + speaker notes |
| Kode, CSV, JSON, Markdown, TXT, HTML, SVG, log, … | Isinya apa adanya |
| ZIP | Daftar file di dalamnya + isi file-file teksnya (`node_modules`, `.git`, dll. dilewatin) |
| Video (MP4, WebM, MOV, …) | Sampai 8 frame dari sepanjang video, sebagai gambar (tanpa suara) |
| Audio, `.doc`/`.xls`/`.ppt` lama, file biner lain | Cuma nama, tipe, dan ukurannya (ditandai "name only") |

- Maksimal **10 file per pesan**. File asli disimpan di Storage (maks 25 MB). File yang lebih gede (sampai 250 MB) tetap dibaca, tapi yang disimpan cuma hasil bacaannya.
- Gambar cuma kebaca sama model yang bisa lihat gambar (Claude, GPT, Gemini, dll.). Kalau modelnya nolak, pesan error-nya bakal bilang. Tinggal ganti model terus pencet **Retry**.
- Di pesan-pesan berikutnya, model masih "ingat" file-file itu: teks file terbaru dikirim ulang sampai ±150.000 karakter, dan maks 10 gambar terakhir (bisa diatur, lihat `CONTEXT_MAX_FILE_CHARS` / `CONTEXT_MAX_IMAGES`).
- Hapus chat = file-filenya ikut kehapus dari Storage. File yang ke-upload tapi nggak jadi dikirim (misalnya tab-nya ketutup) dihapus otomatis waktu lo buka app lagi, kalau udah lebih dari sehari.
- Storage gratis Supabase 1 GB, cek pemakaiannya di **Storage** di Dashboard.

## Cara kerja history & konteks

Model AI itu **stateless**: tiap request dia lupa semuanya. Jadi tiap kamu kirim pesan, function-nya:

1. Simpan pesan kamu ke `chat_messages` (plus file yang dilampirkan)
2. Ambil history chat itu dari database: versi yang lagi lo lihat aja, versi lain hasil edit/retry nggak ikut (default: 40 pesan terakhir, maksimal ±60.000 karakter, plus isi file)
3. Susun konteks: **system prompt** (termasuk tanggal hari ini) + **instruksi buat semua chat** (Settings → General) + **Memory** (fakta tentang lo yang udah diingat) + potongan **chat lama yang relevan** (kalau "Search and reference chats" nyala) + **Instructions** chat ini (tombol di kolom ketik) + aturan artifact + history
4. Kirim ke model, stream balasan ke browser, sambil **nyimpen balasan tiap ±2 detik**. Jadi kalau koneksi putus di tengah jalan, sebagian besar balasan tetap tersimpan
5. Setelah balasan selesai (dan kalau Memory nyala), model ngecek ada fakta baru tentang lo yang perlu diingat. Ini jalan di background, jadi nggak bikin balasan lebih lama

Pesan yang lebih lama dari batas di atas nggak ikut dikirim (masih tersimpan, cuma nggak masuk konteks). Buat topik baru, bikin chat baru: lebih murah dan jawabannya lebih fokus, karena tiap pesan ngirim ulang history-nya.

## Opsi (Edge Function secrets)

| Secret | Default | Fungsi |
|---|---|---|
| `LLM_API_KEY` | wajib | API key provider |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint OpenAI-compatible |
| `ALLOWED_EMAILS` | semua user login | Daftar email yang boleh chat, pisah koma |
| `ALLOWED_MODELS` | semua | Batasi id model yang boleh dipakai, pisah koma |
| `DEFAULT_MODEL` | `anthropic/claude-sonnet-5` | Dipakai kalau browser nggak ngirim model |
| `SYSTEM_PROMPT` | asisten umum, jawab sesuai bahasa user | `{date}` diganti tanggal hari ini |
| `CONTEXT_MAX_MESSAGES` | `40` | Jumlah pesan terakhir yang jadi konteks |
| `CONTEXT_MAX_CHARS` | `60000` | Batas karakter history yang dikirim |
| `MAX_OUTPUT_TOKENS` | default provider | Batas panjang balasan |
| `MEMORY_MODEL` | model chat | Model buat update memory di background (pakai yang murah) |
| `CONTEXT_MAX_FILE_CHARS` | `150000` | Berapa karakter isi file (PDF, Word, …) yang dikirim ulang ke model tiap pesan |
| `CONTEXT_MAX_IMAGES` | `10` | Berapa gambar terakhir (termasuk frame video & halaman scan) yang dikirim ulang ke model |

Ganti/tambah model di picker: edit `MODELS` di `web/config.js` (model pertama = default).

## Keamanan

- API key model cuma ada di Edge Function secrets, nggak pernah dikirim ke browser.
- Row Level Security: tiap user cuma bisa baca/ubah chat miliknya sendiri.
- File disimpan di bucket **private**: tiap user cuma bisa buka folder miliknya sendiri, dan gambar ditampilkan lewat link sementara (kadaluarsa 1 jam). Teks hasil bacaan file disimpan di tabel `chat_attachments`.
- Function nolak request tanpa login, dan (kalau `ALLOWED_EMAILS` diisi) email yang nggak terdaftar.
- Output model di-sanitize sebelum ditampilkan, jadi HTML/script dari balasan nggak bisa jalan. Gambar di balasan ditampilkan sebagai link, bukan di-load otomatis.

## Kalau ada error

| Pesan | Artinya / solusinya |
|---|---|
| Layar "Almost there" | `web/config.js` belum diisi |
| "Run supabase/schema.sql in the SQL Editor first" | Langkah 2 belum dijalankan |
| "The "chat" Edge Function isn't deployed yet" | Langkah 3: nama function harus `chat` |
| "LLM_API_KEY is not set" | Langkah 4 |
| "Model API error 401 … Check the LLM_API_KEY secret" | Key salah, atau key bukan dari provider yang ada di `LLM_BASE_URL` |
| "… is not a valid model ID" / error 404 | Id model nggak cocok sama provider-nya (lihat tabel di atas) |
| "This account is not allowed to use this chat" | Email kamu belum ada di `ALLOWED_EMAILS` |
| "Your session has expired" | Sign out lalu login lagi |
| "Files, editing and retrying need a database update" | Jalanin `supabase/upgrade-v3.sql` (bagian **Update**) |
| "This model may not accept images…" | Model yang dipilih nggak bisa lihat gambar. Ganti model (Claude/GPT/Gemini) terus pencet **Retry** |
| File nyangkut di "Reading…" lama / "took too long" | File-nya kegedean atau rusak. Coba file yang lebih kecil, atau simpan ulang (misalnya `.doc` → `.docx`) |
| "Storage didn't allow the upload" / "Bucket not found" | Jalanin ulang `supabase/upgrade-v3.sql` |
| "The connection closed before the reply finished" | Balasan kelamaan. Edge Function di plan Free dibatasi 150 detik per request, dan bagian yang sudah keluar tetap tersimpan |

Log lengkap: **Edge Functions** → `chat` → **Logs**.

## Alternatif: deploy pakai CLI

Kalau lebih suka terminal (butuh Node.js):

```bash
npx supabase login
npx supabase functions deploy chat --project-ref <project-ref>
npx supabase secrets set LLM_API_KEY=xxx ALLOWED_EMAILS=kamu@email.com --project-ref <project-ref>
```

`<project-ref>` = bagian `abcdefgh` dari URL project. Schema tetap paling gampang dijalankan lewat SQL Editor.
