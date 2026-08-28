/* ------------------------------------------------------------------ *
 * Cover lookup — Open Library (no key, no account, CORS-friendly).
 *
 * Search:  https://openlibrary.org/search.json?title=…&author=…
 * Cover:   https://covers.openlibrary.org/b/id/<cover_i>-M.jpg
 *
 * Everything here is best-effort: a miss just means the card keeps the
 * shelf photo you took. Nothing ever throws at the caller.
 * ------------------------------------------------------------------ */

const SEARCH_URL = "https://openlibrary.org/search.json";
const COVER_URL = (id, size) =>
  `https://covers.openlibrary.org/b/id/${id}-${size}.jpg?default=false`;

/* ---------- title matching (so we don't attach the wrong artwork) ---------- */

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["the", "a", "an", "of", "and", "el", "la", "los", "las", "un", "una", "de", "y"]);

function words(s) {
  return norm(s).split(" ").filter((w) => w && !STOP.has(w));
}

/* 0…1 — how much of the searched title the candidate actually covers. */
function overlap(query, candidate) {
  const q = words(query);
  const c = new Set(words(candidate));
  if (q.length === 0) return 0;
  let hit = 0;
  for (const w of q) if (c.has(w)) hit++;
  return hit / q.length;
}

function scoreDoc(doc, title, author) {
  if (!doc || !doc.cover_i) return -1;
  let score = overlap(title, doc.title) * 100;
  if (score < 55) return -1; // wrong book — better no cover than a lie
  if (author && Array.isArray(doc.author_name)) {
    const joined = doc.author_name.join(" ");
    if (overlap(author, joined) > 0.4) score += 25;
  }
  if (doc.first_publish_year) score += 2;
  return score;
}

/* ---------- fetch helpers ---------- */

function withTimeout(ms, signal) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

/* Re-encode the cover through a canvas: small, uniform, baseline JPEG —
   which is what both IndexedDB and the PDF writer want. */
async function blobToJpegDataUrl(blob, maxDim, quality) {
  let src = null;
  try {
    src = await createImageBitmap(blob);
  } catch {
    src = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;
    });
  }
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(src, 0, 0, w, h);
  if (typeof src.close === "function") src.close();
  const url = canvas.toDataURL("image/jpeg", quality);
  if (!url.startsWith("data:image/jpeg")) throw new Error("canvas blocked");
  return url;
}

/* ---------- public API ---------- */

/** Search Open Library. Returns the best matching edition, or null. */
export async function findEdition(title, author, opts = {}) {
  const t = String(title || "").trim();
  if (!t) return null;

  const params = new URLSearchParams();
  params.set("title", t);
  if (author) params.set("author", String(author).trim());
  params.set("limit", "5");
  params.set("fields", "key,title,author_name,cover_i,first_publish_year");

  const { signal, done } = withTimeout(opts.timeout || 9000, opts.signal);
  try {
    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    const docs = Array.isArray(data && data.docs) ? data.docs : [];

    let best = null;
    let bestScore = 0;
    for (const doc of docs) {
      const s = scoreDoc(doc, t, author);
      if (s > bestScore) { best = doc; bestScore = s; }
    }
    if (!best) return null;
    return {
      coverId: best.cover_i,
      title: best.title || t,
      author: Array.isArray(best.author_name) ? best.author_name[0] : null,
      year: best.first_publish_year || null,
      key: best.key || null,
    };
  } catch {
    return null; // offline, blocked, rate-limited — all the same to us
  } finally {
    done();
  }
}

/** Download one cover and return it as a small JPEG data URL, or null. */
export async function fetchCover(coverId, opts = {}) {
  if (!coverId) return null;
  const { signal, done } = withTimeout(opts.timeout || 12000, opts.signal);
  try {
    const res = await fetch(COVER_URL(coverId, opts.size || "M"), { signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob || blob.size < 512) return null; // Open Library's "no cover" stub
    return await blobToJpegDataUrl(blob, opts.maxDim || 300, opts.quality || 0.74);
  } catch {
    return null;
  } finally {
    done();
  }
}

/** Search + download in one go. Returns { dataUrl, coverId, year, … } or null. */
export async function findCover(title, author, opts = {}) {
  const edition = await findEdition(title, author, opts);
  if (!edition) return null;
  const dataUrl = await fetchCover(edition.coverId, opts);
  if (!dataUrl) return null;
  return { ...edition, dataUrl };
}

/** Look several books up back-to-back, gently (Open Library is a charity). */
export async function findCoversFor(items, onFound, opts = {}) {
  const gap = opts.gap == null ? 350 : opts.gap;
  for (const item of items) {
    if (opts.signal && opts.signal.aborted) return;
    const found = await findCover(item.title, item.author, opts);
    if (found) {
      try { onFound(item, found); } catch {}
    }
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
}
