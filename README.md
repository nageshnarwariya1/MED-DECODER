# Med-Decoder — Public Lab Report Explainer

A simple public website that explains laboratory reports in plain English, Hindi or Marathi. Visitors do **not** create accounts. Only the site administrator signs in at `/admin` to review de-identified analysis records.

## What is included

### Public website
- No public login, signup or user dashboard.
- Upload a report as PDF, JPG/JPEG, PNG, WEBP, TXT or CSV (maximum 15 MB).
- AI reading through Google Gemini, with the explanation language selectable as English, Hindi or Marathi.
- Faster Gemini request settings: uses low thinking mode, limits long generated responses, retries the primary model once after a short wait, then tries one fallback request. Large image uploads are resized in the browser when safe to do so; original PDF uploads are not modified.
- Test-by-test table showing the extracted value, unit and reference range.
- High/low flags are calculated by the server only from numeric reference bounds that were read from the uploaded report. If a range is missing or unclear, the value is marked **Check**.
- Plain-language summary and key findings.
- Questions to discuss with a doctor, including medication, diet and follow-up topics. The AI does not prescribe medicines or a personal diet plan.
- Report-specific AI chat and general website support chat.
- Print-friendly **Save as PDF** action (browser print dialog → Save as PDF).
- Sample report so the interface can be demonstrated without an API key. Sample values are synthetic.

### Admin-only area
- Admin sign-in at `/admin`; no admin credentials are hardcoded.
- Report list, received date, report type, number of tests, out-of-range count and AI confidence estimate.
- View individual de-identified analysis records and delete records.
- Automatic retention expiry, default 30 days.

### Privacy and limitations
- Original uploads are held in memory for processing and are not written to disk by this application.
- The extracted report interpretation is saved in the server data store so the admin can monitor the public service. It may still contain sensitive health information even after identifiers are omitted; keep the admin password private and review your applicable privacy obligations before public launch.
- The uploaded document is sent to the configured Google Gemini API for analysis. The user must accept the notice before analysis.
- The AI prompt requests no patient names, contact details, ID numbers or other identifiers in the returned record. Ask users to redact these before uploading.
- The confidence number is an AI-generated **reading-confidence estimate**, not a clinically validated accuracy percentage. It must not be advertised as diagnostic accuracy.
- This project is a hackathon prototype, not a certified medical device. It does not diagnose, prescribe, or replace a qualified healthcare professional.
- Only PDF, common image files (JPG/JPEG/PNG/WEBP), TXT and CSV are accepted. It does not support every arbitrary file format (for example DOCX, XLSX, ZIP or HEIC). Convert unsupported files to PDF or a supported image first.

## Requirements
- Node.js 20 or newer.
- A Google Gemini API key for live analysis and chat. Sample mode works without the key.

## Run locally in VS Code

1. Extract the ZIP file.
2. Open the extracted `Med-Decoder` folder in VS Code.
3. Open **Terminal → New Terminal**.
4. Install packages:

   ```bash
   npm install
   ```

5. Create your local environment file by copying `.env.example` to `.env`.
   - Windows PowerShell:
     ```powershell
     Copy-Item .env.example .env
     ```
   - macOS/Linux:
     ```bash
     cp .env.example .env
     ```
6. Open `.env` and set:

   ```env
   GEMINI_API_KEY=your_real_google_gemini_api_key
   GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.7-flash
   ADMIN_EMAIL=admin@meddecoder.in
   ADMIN_PASSWORD=choose_a_long_unique_password
   SESSION_SECRET=generate_a_random_secret_of_at_least_32_characters
   DATA_DIR=./data
   REPORT_RETENTION_DAYS=30
   PORT=3000
   NODE_ENV=development
   ```

   Generate a random session secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Do not upload `.env` to GitHub.

7. Start the website:

   ```bash
   npm run dev
   ```

8. Open:
   - Public website: `http://localhost:3000`
   - Admin page: `http://localhost:3000/admin`

If you do not set `GEMINI_API_KEY`, use **Try a sample report** to test the interface. Real report analysis and chat require the key.

## Handling Gemini 503 errors

Gemini may temporarily return `503 UNAVAILABLE` when the selected model is at capacity. The server now retries the primary model once after a short wait, then tries the configured fallback model once. This limits the delay caused by repeated overload retries. If both models remain unavailable, the browser keeps the selected file selected so the visitor can try again later.

Report analysis uses Gemini 3.8 Flash with `thinkingLevel: low` and a bounded JSON response. Large image uploads may be resized in the browser to reduce upload time; the website does not rewrite PDF uploads. Every visible laboratory test should still be checked against the original report.

This improves resilience but cannot guarantee Gemini availability. A 429 response is a quota/rate-limit issue and needs a quota check or a wait for the quota window to reset; retries do not remove a quota restriction.

## How to test before deployment

- [ ] Home page opens and looks correct on desktop and mobile.
- [ ] Public visitors can upload without signing in.
- [ ] Consent checkbox is required before analysis.
- [ ] PDF, JPG/JPEG, PNG, WEBP, TXT and CSV uploads are accepted.
- [ ] Unsupported formats and files over 15 MB show a clear error.
- [ ] With `GEMINI_API_KEY` configured, test one real report with personal identifiers hidden.
- [ ] Compare every extracted value and unit with the original document.
- [ ] Verify that high/low flags only appear when numeric reference limits are printed on the report.
- [ ] Change output language to Hindi and Marathi.
- [ ] Ask the report assistant about one value and test the general support assistant.
- [ ] Save the report result as PDF using the browser print dialogue.
- [ ] Sign in at `/admin`; confirm that the new analysis appears.
- [ ] Open the record in admin and delete a test record.
- [ ] Confirm no visitor login or signup is shown anywhere.

## Deploy to Render

This repository includes `render.yaml` for one full-stack Render Web Service. The same service hosts the public frontend and backend API, which avoids separate frontend/backend CORS configuration.

1. Create a GitHub repository and upload/push the contents of this folder (not the ZIP itself).
2. In Render, choose **New → Blueprint** and connect the GitHub repository, or choose **New → Web Service** and connect it.
3. If using the manual Web Service flow, choose:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
4. Use a paid Render Web Service plan if you need the persistent disk configured in `render.yaml`. Render documentation says persistent disks are available on paid web services; without a disk, the instance filesystem is ephemeral and report records may be lost on restarts/redeploys.
5. Add these environment variables in Render → your service → Environment:
   - `NODE_ENV` = `production`
   - `GEMINI_API_KEY` = your Google Gemini API key (secret)
   - `GEMINI_MODEL` = `gemini-3.8-flash`
   - `GEMINI_FALLBACK_MODEL` = `gemini-3.7-flash`
   - `ADMIN_EMAIL` = your chosen admin email
   - `ADMIN_PASSWORD` = a unique long password
   - `SESSION_SECRET` = a random secret of at least 32 characters
   - `DATA_DIR` = `/var/data`
   - `REPORT_RETENTION_DAYS` = `30`
6. Deploy and wait for the health check to pass.
7. Open the public `https://your-service.onrender.com` URL and test the full workflow.
8. Open `https://your-service.onrender.com/admin` and sign in with the admin credentials configured above.

**Important:** Render credits apply to Render hosting usage; they do not automatically cover Google Gemini API usage. Check each provider's billing and usage independently. Do not add secrets to frontend source files or commit them to Git.

## Where data is stored

- Local: `./data/reports.json` (created automatically).
- Render: `/var/data/reports.json` (the persistent disk mounted by `render.yaml`).
- The JSON file stores report type, source filename, selected language, summary, test values/ranges/status, doctor questions and AI confidence estimate. It does not store the original upload.
- The admin can see saved analysis records at `/admin`. Expired records are pruned when the server starts or the admin report list is opened.

## Project structure

```text
Med-Decoder/
├── public/
│   ├── index.html       # Public website
│   ├── styles.css       # Responsive visual design
│   ├── app.js           # Upload, results and chat interactions
│   ├── admin.html       # Protected admin interface shell
│   └── admin.js         # Admin dashboard interactions
├── data/                # Created automatically; report records
├── server.js            # Gemini API, upload, storage and admin auth
├── package.json
├── .env.example
├── render.yaml
└── README.md
```
