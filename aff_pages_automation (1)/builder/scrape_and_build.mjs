// builder/scrape_and_build.mjs
// Build script for GitHub Actions (or local):
// - Reads Google Sheet CSV with column "Link"
// - Scrapes title/description/image for each link
// - Uploads image to Cloudinary
// - Writes dist/index.html (2-col gallery), dist/data.json, dist/products.csv

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { v2 as cloudinary } from 'cloudinary';

const SHEET_CSV_URL = process.env.SHEET_CSV_URL; // e.g. "https://docs.google.com/spreadsheets/d/e/.../pub?gid=0&single=true&output=csv"
const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!SHEET_CSV_URL) throw new Error('Missing SHEET_CSV_URL (Google Sheet published CSV).');
if (!CLOUDINARY_CLOUD || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error('Missing Cloudinary config (CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).');
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true
});

const DIST = path.resolve('dist');
fs.mkdirSync(DIST, { recursive: true });

function shorten(text, limit = 120) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const cutoff = Math.max(0, limit - 1);
  let slice = clean.slice(0, cutoff);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 60) slice = slice.slice(0, lastSpace);
  return slice.replace(/[.,;:!?-]+$/, '') + '…';
}

async function fetchSheetCsv(url) {
  const res = await axios.get(url, { timeout: 30000 });
  return res.data;
}

function parseLinks(csv) {
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const links = rows
    .map(r => (r['Link'] || r['link'] || r['URL'] || r['url'] || '').trim())
    .filter(Boolean);
  // dedupe
  return Array.from(new Set(links));
}

async function scrapeWithCheerio(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36' }
    });
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim()
      || $('meta[property="og:title"]').attr('content')
      || $('title').text().trim()
      || '';
    const desc = $('h2:contains("About")').first().nextUntil('h1,h2,h3,h4').text().replace(/\s+/g,' ').trim()
      || $('meta[name="description"]').attr('content')
      || $('meta[property="og:description"]').attr('content')
      || '';
    let image = $('meta[property="og:image"]').attr('content')
      || $('link[rel="image_src"]').attr('href')
      || $('img').map((_, el) => $(el).attr('src') || $(el).attr('data-src')).get().find(u => /wp-content\/uploads|^https?:\/\//.test(u))
      || '';
    if (image && image.startsWith('//')) image = 'https:' + image;
    return { title, description: shorten(desc || 'Professional presentation template with modern, editable slides.'), image };
  } catch (e) {
    return { title: '', description: 'Professional presentation template with modern, editable slides.', image: '' };
  }
}

async function scrapeWithPuppeteer(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36');
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(1200);
    const title = (await page.$eval('h1', el => el.textContent.trim()).catch(() => ''))
      || (await page.$eval('meta[property="og:title"]', el => el.content).catch(() => ''))
      || (await page.title());
    const ogDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
    const ogDesc2 = await page.$eval('meta[property="og:description"]', el => el.content).catch(() => '');
    let description = ogDesc || ogDesc2 || '';
    if (!description) {
      // try collect paragraph text near an "About" heading
      const about = await page.$x("//h2[contains(., 'About')]");
      if (about.length) {
        const handle = about[0];
        const nextHtml = await page.evaluate(h => {
          let cur = h.nextElementSibling;
          let txt = '';
          let guard = 0;
          while (cur && guard++ < 20) {
            if (/H[1-4]/.test(cur.tagName)) break;
            txt += ' ' + (cur.textContent || '');
            cur = cur.nextElementSibling;
          }
          return txt;
        }, handle);
        description = nextHtml.replace(/\s+/g,' ').trim();
      }
    }
    description = shorten(description || 'Professional presentation template with modern, editable slides.');
    let image = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => '');
    if (!image) {
      image = await page.$$eval('img', els => {
        const srcs = els.map(el => el.getAttribute('src') || el.getAttribute('data-src') || '');
        const cf = srcs.find(u => /wp-content\/uploads/.test(u));
        return cf || srcs.find(u => /^https?:\/\//.test(u)) || '';
      }).catch(() => '');
    }
    if (image && image.startsWith('//')) image = 'https:' + image;
    await page.close();
    return { title, description, image };
  } catch (e) {
    await page.close();
    return { title: '', description: 'Professional presentation template with modern, editable slides.', image: '' };
  }
}

async function uploadToCloudinary(imageUrl) {
  if (!imageUrl) return '';
  try {
    const res = await cloudinary.uploader.upload(imageUrl, {
      folder: 'products',
      overwrite: true,
      resource_type: 'image',
      transformation: [
        { width: 1200, height: 800, crop: 'fill' },
        { fetch_format: 'auto', quality: 'auto' }
      ]
    });
    return res.secure_url;
  } catch (e) {
    // Fallback: try downloading and streaming upload (handles referer issues)
    try {
      const resp = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
      const buffer = Buffer.from(resp.data);
      const streamRes = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'products', overwrite: true, resource_type: 'image' },
          (err, r) => (err ? reject(err) : resolve(r))
        );
        stream.end(buffer);
      });
      return streamRes.secure_url;
    } catch (e2) {
      return '';
    }
  }
}

function htmlTemplate(items) {
  const css = `
  :root { --gap: 16px; --radius: 14px; --shadow: 0 6px 20px rgba(0,0,0,0.08); --blue: #0B5FFF; --blue-dark: #0A4EE0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 20px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial, sans-serif; color: #111; background: #fafafa; }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 44px; line-height: 1.12; margin: 0 0 8px; letter-spacing: -0.02em; }
  .subtitle { font-size: 18px; color: #444; margin-bottom: 28px; }
  hr { border: none; border-top: 1px solid #e9e9e9; margin: 16px 0 28px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--gap); }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1px solid #eee; border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); display: flex; flex-direction: column; transition: transform .12s ease, box-shadow .12s ease; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(0,0,0,0.10); }
  .cover { position: relative; width: 100%; padding-top: 66.66%; overflow: hidden; background: #f2f2f2; }
  .cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .content { padding: 14px 14px 18px; display: flex; flex-direction: column; gap: 8px; }
  .title { font-weight: 650; font-size: 16px; line-height: 1.3; }
  .desc { font-size: 14px; color: #555; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { margin-top: 6px; }
  .btn { display: inline-block; text-decoration: none; border: 1px solid var(--blue); background: var(--blue); color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 14px; font-weight: 600; transition: background .12s ease, color .12s ease, border-color .12s ease; }
  .btn:hover { background: var(--blue-dark); border-color: var(--blue-dark); color: #fff; }`;

  const head = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Free Digital Products</title><style>${css}</style></head><body><div class="wrap"><h1>Free Digital Products</h1><div class="subtitle">Curated resources for creators, designers, and marketers. Download and use them in your next project.</div><hr/><div class="grid">`;
  const tail = `</div><div class="footer" style="margin-top:36px;font-size:13px;color:#666;">Images hosted on Cloudinary • Auto-built from Google Sheets.</div></div></body></html>`;

  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const cards = items.map(it => `
    <article class="card">
      <div class="cover"><img src="${esc(it.image)}" alt="${esc(it.title)} cover" /></div>
      <div class="content">
        <div class="title">${esc(it.title)}</div>
        <div class="desc">${esc(it.description)}</div>
        <div class="actions"><a class="btn" href="${esc(it.url)}" target="_blank" rel="noopener">Download for Free</a></div>
      </div>
    </article>
  `).join('\n');

  return head + cards + tail;
}

function writeArtifacts(items) {
  // JSON
  fs.writeFileSync(path.join(DIST, 'data.json'), JSON.stringify(items, null, 2), 'utf-8');
  // CSV
  const header = 'Name,Description,Image URL,Download Link\n';
  const esc = s => '"' + String(s || '').replace(/"/g, '""') + '"';
  const body = items.map(p => [p.title, p.description, p.image, p.url].map(esc).join(',')).join('\n');
  fs.writeFileSync(path.join(DIST, 'products.csv'), header + body, 'utf-8');
  // HTML
  const html = htmlTemplate(items);
  fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf-8');
}

async function main() {
  console.log('Fetching sheet CSV...');
  const csv = await fetchSheetCsv(SHEET_CSV_URL);
  const links = parseLinks(csv);
  if (!links.length) throw new Error('No links found in sheet.');
  console.log(`Found ${links.length} links.`);

  // Try fast path (cheerio), then fall back to Puppeteer if image missing
  const items = [];
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  for (const url of links) {
    console.log('Parsing:', url);
    let meta = await scrapeWithCheerio(url);
    if (!meta.image) {
      console.log('  -> Fallback to Puppeteer');
      meta = await scrapeWithPuppeteer(browser, url);
    }
    // upload image
    let img = await uploadToCloudinary(meta.image);
    if (!img) {
      console.log('  -> Image upload failed, using placeholder');
      img = `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/image/upload/c_fill,w_1200,h_800,f_auto,q_auto/v1/https://placehold.co/1200x800/jpg`;
    }
    const title = meta.title || url.split('/').pop().replace(/[-_]/g, ' ');
    items.push({ title, description: meta.description, image: img, url });
  }
  await browser.close();

  writeArtifacts(items);
  console.log('Build complete: dist/index.html, dist/data.json, dist/products.csv');
}

main().catch(err => { console.error(err); process.exit(1); });
