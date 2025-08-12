# Affiliate Pages — Auto Builder (Google Sheets → GitHub Pages)

This repo builds a static gallery site from a public Google Sheet (CSV) of links.
It scrapes title/description/image for each link, uploads images to Cloudinary,
and publishes a 2‑column gallery with a blue “Download for Free” button.

## Quick Start (Cheapest & Automated)
1) **Google Sheet**
   - Create columns: `Link` (only this is required).
   - File → Publish to the web → select the sheet → CSV. Copy the CSV URL.

2) **Create GitHub repo**
   - Push this folder as a new repo.

3) **Repo Secrets (Settings → Secrets and variables → Actions → New repository secret)**
   - `SHEET_CSV_URL` — your published CSV URL from step 1.
   - `CLOUDINARY_CLOUD` — e.g. `dhl7vyibn`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`

4) **Enable GitHub Pages**
   - Settings → Pages → Build and deployment: Source = GitHub Actions.
   - The provided workflow will handle deploys.

5) **Trigger a build**
   - Push to `main`, or run the workflow manually (Actions → Run workflow), or wait for the schedule.

Result: your site will be available at `https://<username>.github.io/<repo>/`.
To use a custom domain, add it in Pages settings and create a CNAME at your registrar.

## Local build (optional)
```bash
npm install
SHEET_CSV_URL=... CLOUDINARY_CLOUD=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... npm run build
```

## Notes
- Descriptions are soft‑shortened to ~120 chars.
- Images are transformed to 1200×800 via Cloudinary for consistent sharpness.
- If a page blocks scraping, the builder falls back to headless Chrome (Puppeteer).
- The final files are in `dist/`: `index.html`, `data.json`, `products.csv` (also deployed).
