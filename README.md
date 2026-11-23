# Voter Search (voter.bainslamusic.com)

Private, noindexed search over Rajasthan Panchayat electoral rolls. Admin uploads ward PDFs or page photos, Gemini OCR reads every voter entry, and anyone can search by Hindi or Roman name, relative name, ward, serial, house number or Voter ID, open the original page, and tick when a voter slip was given.

## Layout
- `server.js` - Express app: search API, slips (ticks), GP menu (District → Panchayat Samiti → GP → Ward), home-page `PINNED` GPs, admin login + email-OTP password reset, uploads, GP requests, source-page rendering.
- `lib/db.js` - SQLite schema (better-sqlite3), areas, name normalisation and search keys.
- `lib/ingest.js` - upload queue: splits PDFs, OCRs pages, retries pages that hit the free Gemini limit every 30 minutes.
- `lib/ocr.js`, `lib/keys.js` - Gemini calls (zoomed column strips, exact-spelling rules) and key × model rotation.
- `lib/match.js` - Hindi/English fuzzy matching.
- `public/` - single-page frontend (`index.html`, `app.js`, `style.css`).
- `scripts/` - `sec-feed.js` (feeds downloaded SEC ward PDFs into the queue), `reread-names.js` (re-reads names, changes one only when two reads agree), `merge-db.js`, `sections.js` (village/mohalla backfill), `pdf-pages.js`, `index-photos.js`, `verify-*.js`.

Voter data (`data/voters.db`, uploads, SEC PDFs) and secrets (`data/.env`) are not in git.

## Run
Node 20+, `poppler-utils` (pdftoppm, pdfinfo).
```bash
npm ci
mkdir -p data && cp .env.example data/.env   # fill in the values
node server.js                                # http://127.0.0.1:3580
```

## Production (162.35.107.192)
- App: `/var/www/voter-search` (copy of this repo); `data` and `uploads` are symlinks into `/var/www/voter-search-data`.
- PM2: `voter-search` (server.js), `voter-sec-feed` (`scripts/sec-feed.js /var/www/voter-search-data/sec`, env `SEC_ONLY=1 SEC_PRIORITY=<gp codes>`), `voter-reread*` (`scripts/reread-names.js <area>`).
- Deploy: back up `voters.db`, copy `server.js lib public scripts package*.json`, `pm2 restart voter-search`.
- nginx: `server_name voter.bainslamusic.com; client_max_body_size 400m; location / { proxy_pass http://127.0.0.1:3580; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_read_timeout 300s; }` with a Let's Encrypt certificate (certbot).

## Admin
Admins are the emails in `ADMIN_EMAILS` (default shivlalbainslaofficial@gmail.com, ajeetbainslaofficial@gmail.com). Menu → Admin login with your email and password. "Forgot or change password?" emails a 6-digit code (valid 10 minutes) to that admin; entering it with a new password sets that admin's own password and logs out their other sessions. Removing an email from `ADMIN_EMAILS` logs it out everywhere.
