/* ------------------------------------------------------------------ *
 * A very small PDF writer — no dependencies, works offline.
 *
 * It covers exactly what the donation list needs: Helvetica text in
 * WinAnsi (so accents survive), rules, filled boxes, and baseline JPEG
 * images embedded straight through /DCTDecode — which is what both the
 * camera thumbnails and the Open Library covers already are, because
 * they go through a canvas on the way in.
 *
 * Coordinates handed to the drawing calls are TOP-LEFT based (y grows
 * downward); the writer flips them into PDF's bottom-left space.
 * ------------------------------------------------------------------ */

const PAGE = { w: 595.28, h: 841.89 }; // A4, in points

/* ---------- text encoding (WinAnsi / CP1252) ---------- */

const WIN_ANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

/* Returns a string whose char codes ARE the bytes to write. Helvetica has
   no glyphs outside Latin-1, so anything else (CJK, Cyrillic, Greek) is
   dropped rather than printed as a row of "?" — a title like
   "雪国 (Snow Country)" still reads, and a line that empties out falls back
   to the caller's placeholder. */
export function toWinAnsi(input) {
  let out = "";
  for (const ch of String(input == null ? "" : input)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) { out += " "; continue; }
    if (cp >= 32 && cp <= 126) { out += ch; continue; }
    if (WIN_ANSI_EXTRA[cp] != null) { out += String.fromCharCode(WIN_ANSI_EXTRA[cp]); continue; }
    if (cp >= 0xa0 && cp <= 0xff) { out += ch; continue; }
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/* ---------- Helvetica metrics (AFM widths, per 1000 em) ---------- */

const ASCII_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ASCII_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/* Latin-1 accented letters borrow their base letter's width. */
const LATIN1_BASE = {
  0xa1: "!", 0xbf: "?", 0xab: "<", 0xbb: ">", 0xb0: "o", 0xb7: ".", 0xa9: "@",
  0xc6: "A", 0xd0: "D", 0xd7: "x", 0xd8: "O", 0xde: "P", 0xdf: "B",
  0xe6: "a", 0xf0: "o", 0xf7: "x", 0xf8: "o", 0xfe: "p",
};
function baseChar(code) {
  if (LATIN1_BASE[code]) return LATIN1_BASE[code];
  if (code >= 0xc0 && code <= 0xc5) return "A";
  if (code === 0xc7) return "C";
  if (code >= 0xc8 && code <= 0xcb) return "E";
  if (code >= 0xcc && code <= 0xcf) return "I";
  if (code === 0xd1) return "N";
  if (code >= 0xd2 && code <= 0xd6) return "O";
  if (code >= 0xd9 && code <= 0xdc) return "U";
  if (code === 0xdd) return "Y";
  if (code >= 0xe0 && code <= 0xe5) return "a";
  if (code === 0xe7) return "c";
  if (code >= 0xe8 && code <= 0xeb) return "e";
  if (code >= 0xec && code <= 0xef) return "i";
  if (code === 0xf1) return "n";
  if (code >= 0xf2 && code <= 0xf6) return "o";
  if (code >= 0xf9 && code <= 0xfc) return "u";
  if (code === 0xfd || code === 0xff) return "y";
  return null;
}
function buildTable(ascii, fallback) {
  const table = new Array(256).fill(fallback);
  for (let c = 32; c <= 126; c++) table[c] = ascii[c - 32];
  for (let c = 0xa0; c <= 0xff; c++) {
    const b = baseChar(c);
    table[c] = b ? ascii[b.charCodeAt(0) - 32] : fallback;
  }
  return table;
}
const W_REG = buildTable(ASCII_REG, 556);
const W_BOLD = buildTable(ASCII_BOLD, 611);

/** Width of already-WinAnsi text, in points. */
export function textWidth(winAnsi, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (let i = 0; i < winAnsi.length; i++) w += table[winAnsi.charCodeAt(i) & 0xff];
  return (w * size) / 1000;
}

function truncate(winAnsi, size, bold, maxWidth) {
  if (textWidth(winAnsi, size, bold) <= maxWidth) return winAnsi;
  const dots = String.fromCharCode(0x85); // WinAnsi ellipsis
  let s = winAnsi;
  while (s.length > 1 && textWidth(s + dots, size, bold) > maxWidth) s = s.slice(0, -1);
  return s.replace(/[\s,;:.-]+$/, "") + dots;
}

/** Wrap WinAnsi text to at most `maxLines`, truncating the last one. */
export function wrapText(winAnsi, size, bold, maxWidth, maxLines = 2) {
  const parts = winAnsi.split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of parts) {
    const candidate = cur ? cur + " " + word : word;
    if (!cur || textWidth(candidate, size, bold) <= maxWidth) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === 0) return [""];
  const last = lines.length - 1;
  lines[last] = truncate(lines[last], size, bold, maxWidth);
  return lines;
}

/* ---------- JPEG probing (for /DCTDecode pass-through) ---------- */

function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(",");
  if (comma === -1) return null;
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) { i++; continue; }
    let marker = bytes[i + 1];
    while (marker === 0xff && i + 2 < bytes.length) { i++; marker = bytes[i + 1]; }
    i += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break; // hit the scan without an SOF
    if (i + 1 >= bytes.length) break;
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2) return null;
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (bytes[i + 2] !== 8) return null; // 8-bit samples only
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      const comps = bytes[i + 7];
      if (!width || !height || (comps !== 1 && comps !== 3)) return null;
      return { width, height, comps };
    }
    i += len;
  }
  return null;
}

/* ---------- the document ---------- */

const f2 = (n) => (Math.round(n * 100) / 100).toString();
const pdfString = (winAnsi) => "(" + winAnsi.replace(/[\\()]/g, "\\$&") + ")";

class PdfDoc {
  constructor() {
    this.objects = [null]; // 1-based, like PDF object numbers
    this.pages = [];
    this.images = new Map(); // dataUrl -> { name, objId }
  }

  alloc() { this.objects.push(null); return this.objects.length - 1; }
  set(id, body) { this.objects[id] = body; }

  newPage() {
    const ops = [];
    const page = {
      ops,
      text: (x, y, str, o = {}) => {
        const size = o.size || 10;
        const win = o.raw ? str : toWinAnsi(str);
        const [r, g, b] = o.color || [0, 0, 0];
        let tx = x;
        if (o.align === "right") tx = x - textWidth(win, size, o.bold);
        else if (o.align === "center") tx = x - textWidth(win, size, o.bold) / 2;
        ops.push(
          "BT /" + (o.bold ? "F2" : "F1") + " " + f2(size) + " Tf " +
            f2(o.tracking || 0) + " Tc " +
            f2(r) + " " + f2(g) + " " + f2(b) + " rg " +
            "1 0 0 1 " + f2(tx) + " " + f2(PAGE.h - y) + " Tm " +
            pdfString(win) + " Tj ET"
        );
      },
      line: (x1, y1, x2, y2, o = {}) => {
        const [r, g, b] = o.color || [0.8, 0.78, 0.72];
        ops.push(
          f2(o.width || 0.6) + " w " + f2(r) + " " + f2(g) + " " + f2(b) + " RG " +
            f2(x1) + " " + f2(PAGE.h - y1) + " m " +
            f2(x2) + " " + f2(PAGE.h - y2) + " l S"
        );
      },
      rect: (x, y, w, h, o = {}) => {
        const [r, g, b] = o.color || [0.93, 0.92, 0.88];
        ops.push(
          f2(r) + " " + f2(g) + " " + f2(b) + " rg " +
            f2(x) + " " + f2(PAGE.h - y - h) + " " + f2(w) + " " + f2(h) + " re f"
        );
      },
      image: (name, x, y, w, h) => {
        ops.push(
          "q " + f2(w) + " 0 0 " + f2(h) + " " + f2(x) + " " + f2(PAGE.h - y - h) +
            " cm /" + name + " Do Q"
        );
      },
    };
    this.pages.push(page);
    return page;
  }

  /** Register a JPEG data URL. Returns its resource name, or null. */
  addImage(dataUrl) {
    if (!dataUrl) return null;
    const hit = this.images.get(dataUrl);
    if (hit) return hit.name;
    let bytes = null;
    let info = null;
    try {
      bytes = dataUrlToBytes(dataUrl);
      info = jpegInfo(bytes);
    } catch {
      return null;
    }
    if (!bytes || !info) return null; // not a baseline JPEG we can pass through
    const id = this.alloc();
    const name = "Im" + this.images.size;
    this.set(id, [
      "<< /Type /XObject /Subtype /Image /Width " + info.width +
        " /Height " + info.height +
        " /ColorSpace /Device" + (info.comps === 1 ? "Gray" : "RGB") +
        " /BitsPerComponent 8 /Filter /DCTDecode /Length " + bytes.length +
        " >>\nstream\n",
      bytes,
      "\nendstream",
    ]);
    this.images.set(dataUrl, { name, objId: id });
    return name;
  }

  build(meta = {}) {
    const catalogId = this.alloc();
    const pagesId = this.alloc();
    const fontRegId = this.alloc();
    const fontBoldId = this.alloc();
    const resId = this.alloc();
    const infoId = this.alloc();

    this.set(fontRegId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    this.set(fontBoldId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    const xobjects = [...this.images.values()]
      .map((im) => "/" + im.name + " " + im.objId + " 0 R")
      .join(" ");
    this.set(
      resId,
      "<< /Font << /F1 " + fontRegId + " 0 R /F2 " + fontBoldId + " 0 R >>" +
        (xobjects ? " /XObject << " + xobjects + " >>" : "") +
        " /ProcSet [/PDF /Text /ImageC /ImageB] >>"
    );

    const pageIds = [];
    for (const page of this.pages) {
      const contentId = this.alloc();
      const pageId = this.alloc();
      const body = page.ops.join("\n");
      this.set(contentId, "<< /Length " + body.length + " >>\nstream\n" + body + "\nendstream");
      this.set(
        pageId,
        "<< /Type /Page /Parent " + pagesId + " 0 R /MediaBox [0 0 " +
          f2(PAGE.w) + " " + f2(PAGE.h) + "] /Resources " + resId +
          " 0 R /Contents " + contentId + " 0 R >>"
      );
      pageIds.push(pageId);
    }

    this.set(
      pagesId,
      "<< /Type /Pages /Kids [" + pageIds.map((id) => id + " 0 R").join(" ") +
        "] /Count " + pageIds.length + " >>"
    );
    this.set(catalogId, "<< /Type /Catalog /Pages " + pagesId + " 0 R >>");

    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp =
      "D:" + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) +
      p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds());
    this.set(
      infoId,
      "<< /Title " + pdfString(toWinAnsi(meta.title || "Donation list")) +
        " /Producer " + pdfString("Stacks") +
        " /Creator " + pdfString("Stacks") +
        " /CreationDate (" + stamp + ") >>"
    );

    /* ---- serialise ---- */
    const chunks = [];
    let length = 0;
    const push = (part) => {
      const bytes =
        typeof part === "string"
          ? Uint8Array.from(part, (c) => c.charCodeAt(0) & 0xff)
          : part;
      chunks.push(bytes);
      length += bytes.length;
    };

    push("%PDF-1.4\n%âãÏÓ\n");
    const offsets = new Array(this.objects.length).fill(0);
    for (let id = 1; id < this.objects.length; id++) {
      const body = this.objects[id];
      if (body == null) continue;
      offsets[id] = length;
      push(id + " 0 obj\n");
      for (const part of Array.isArray(body) ? body : [body]) push(part);
      push("\nendobj\n");
    }

    const xrefStart = length;
    let xref = "xref\n0 " + this.objects.length + "\n0000000000 65535 f \n";
    for (let id = 1; id < this.objects.length; id++) {
      xref += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
    }
    push(xref);
    push(
      "trailer\n<< /Size " + this.objects.length + " /Root " + catalogId +
        " 0 R /Info " + infoId + " 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n"
    );

    return { blob: new Blob(chunks, { type: "application/pdf" }), chunks };
  }
}

/* ---------- the donation list itself ---------- */

const STRINGS = {
  en: {
    title: "Donation list",
    kicker: "STACKS · HOME LIBRARY",
    books: (n) => n + (n === 1 ? " book offered for donation" : " books offered for donation"),
    to: "To", from: "From", contact: "Contact",
    unshelved: "Unshelved",
    author: "author unknown",
    page: (a, b) => "Page " + a + " of " + b,
    made: (d) => "Prepared " + d + " with Stacks",
    empty: "Nothing marked for donation yet.",
    total: "Total",
    cont: " (cont.)",
  },
  es: {
    title: "Lista de donación",
    kicker: "STACKS · BIBLIOTECA DE CASA",
    books: (n) => n + (n === 1 ? " libro disponible para donar" : " libros disponibles para donar"),
    to: "Para", from: "De", contact: "Contacto",
    unshelved: "Sin ubicar",
    author: "autor desconocido",
    page: (a, b) => "Página " + a + " de " + b,
    made: (d) => "Preparada el " + d + " con Stacks",
    empty: "Todavía no hay libros marcados para donar.",
    total: "Total",
    cont: " (cont.)",
  },
};

const MARGIN = 46;
const CONTENT_W = PAGE.w - MARGIN * 2;
const FOOTER_Y = PAGE.h - 38;
const INK = [0.14, 0.12, 0.09];
const SOFT = [0.42, 0.39, 0.33];
const RULE = [0.78, 0.75, 0.68];
const HAIRLINE = [0.87, 0.85, 0.8];
const ACCENT = [0.42, 0.33, 0.16];

/**
 * Build the donation list.
 *   books: [{ callNo, title, author, roomLabel, year, cover }]
 *   meta:  { org, from, contact, note, lang, includeCovers }
 * Returns a Blob (application/pdf).
 */
export function donationListPdf(books, meta = {}) {
  const lang = meta.lang === "es" ? "es" : "en";
  const t = STRINGS[lang];
  const withCovers = !!meta.includeCovers;
  const doc = new PdfDoc();
  const dateText = new Date().toLocaleDateString(lang === "es" ? "es-AR" : "en-GB", {
    year: "numeric", month: "long", day: "numeric",
  });

  let page = doc.newPage();
  let y = MARGIN;
  const newPage = () => { page = doc.newPage(); y = MARGIN; };

  /* ---- masthead ---- */
  page.text(MARGIN, y + 9, t.kicker, { size: 8, bold: true, tracking: 1.6, color: ACCENT });
  y += 26;
  page.text(MARGIN, y + 16, t.title, { size: 24, bold: true, color: INK });
  page.text(PAGE.w - MARGIN, y + 16, dateText, { size: 9.5, color: SOFT, align: "right" });
  y += 30;
  page.line(MARGIN, y, PAGE.w - MARGIN, y, { width: 1.1, color: ACCENT });
  y += 20;

  page.text(MARGIN, y + 11, t.books(books.length), { size: 13, bold: true, color: INK });
  y += 26;

  const detail = (label, value) => {
    if (!value) return;
    page.text(MARGIN, y + 9, label.toUpperCase(), { size: 7.5, bold: true, tracking: 1, color: SOFT });
    page.text(MARGIN + 66, y + 9, value, { size: 10, color: INK });
    y += 15;
  };
  detail(t.to, meta.org);
  detail(t.from, meta.from);
  detail(t.contact, meta.contact);

  if (meta.note) {
    y += 6;
    for (const line of wrapText(toWinAnsi(meta.note), 9.5, false, CONTENT_W, 4)) {
      page.text(MARGIN, y + 9, line, { size: 9.5, color: SOFT, raw: true });
      y += 13;
    }
  }
  y += 14;

  if (books.length === 0) {
    page.text(MARGIN, y + 10, t.empty, { size: 11, color: SOFT });
  }

  /* ---- rows, grouped by room ---- */
  const groups = new Map();
  for (const b of books) {
    const key = b.roomLabel || t.unshelved;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const rowH = withCovers ? 56 : 25;
  const coverW = 34;
  const coverH = 46;
  const textX = MARGIN + (withCovers ? coverW + 12 : 0);
  const yearW = 34;
  const noW = 50;
  const titleW = PAGE.w - MARGIN - textX - yearW - noW - 18;

  for (const [roomLabel, list] of groups) {
    if (y + rowH + 30 > FOOTER_Y) newPage();
    const heading = (suffix) => {
      page.text(MARGIN, y + 9, roomLabel.toUpperCase() + suffix, {
        size: 8.5, bold: true, tracking: 1.2, color: ACCENT,
      });
      page.text(PAGE.w - MARGIN, y + 9, String(list.length), {
        size: 8.5, bold: true, color: ACCENT, align: "right",
      });
      y += 14;
      page.line(MARGIN, y, PAGE.w - MARGIN, y, { width: 0.8, color: RULE });
      y += 8;
    };
    y += 6;
    heading("");

    for (const b of list) {
      if (y + rowH > FOOTER_Y) { newPage(); heading(t.cont); }

      const top = y;
      if (withCovers) {
        const name = doc.addImage(b.cover);
        if (name) {
          page.image(name, MARGIN, top, coverW, coverH);
        } else {
          page.rect(MARGIN, top, coverW, coverH, { color: [0.93, 0.92, 0.88] });
          page.text(MARGIN + coverW / 2, top + coverH / 2 + 4, "?", {
            size: 12, bold: true, color: [0.72, 0.7, 0.64], align: "center",
          });
        }
      }

      /* toWinAnsi can empty a line out entirely (a title in kanji, say),
         so fall back rather than printing nothing. */
      const titleText = toWinAnsi(b.title) || toWinAnsi("—");
      const authorText = toWinAnsi(b.author) || toWinAnsi(t.author);

      if (withCovers) {
        /* Stacked: the cover gives the row enough height for two lines. */
        let ty = top + 12;
        for (const line of wrapText(titleText, 10.5, true, titleW, 2)) {
          page.text(textX, ty, line, { size: 10.5, bold: true, color: INK, raw: true });
          ty += 13;
        }
        page.text(textX, ty + 1, truncate(authorText, 9.5, false, titleW), {
          size: 9.5, color: SOFT, raw: true,
        });
      } else {
        /* Compact: title and author as two columns of one line each. */
        const titleCol = titleW * 0.58;
        const authorX = textX + titleW * 0.62;
        page.text(textX, top + 13, truncate(titleText, 10.5, true, titleCol), {
          size: 10.5, bold: true, color: INK, raw: true,
        });
        page.text(authorX, top + 13, truncate(authorText, 9.5, false, titleW * 0.38), {
          size: 9.5, color: SOFT, raw: true,
        });
      }

      const metaY = top + (withCovers ? 10 : 13);
      if (b.year) {
        page.text(PAGE.w - MARGIN - noW - 12, metaY, String(b.year), {
          size: 9, color: SOFT, align: "right",
        });
      }
      page.text(PAGE.w - MARGIN, metaY, b.callNo || "", {
        size: 8.5, color: [0.6, 0.57, 0.5], align: "right",
      });

      y = top + rowH;
      page.line(MARGIN, y - 7, PAGE.w - MARGIN, y - 7, { width: 0.4, color: HAIRLINE });
    }
    y += 10;
  }

  /* ---- total ---- */
  if (books.length > 0) {
    if (y + 30 > FOOTER_Y) newPage();
    page.line(MARGIN, y, PAGE.w - MARGIN, y, { width: 1, color: ACCENT });
    y += 16;
    page.text(MARGIN, y, t.total.toUpperCase(), { size: 9, bold: true, tracking: 1, color: INK });
    page.text(PAGE.w - MARGIN, y, t.books(books.length), {
      size: 9.5, bold: true, color: INK, align: "right",
    });
  }

  /* ---- footers (page count is only known now) ---- */
  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    p.line(MARGIN, FOOTER_Y + 10, PAGE.w - MARGIN, FOOTER_Y + 10, { width: 0.5, color: RULE });
    p.text(MARGIN, FOOTER_Y + 24, t.made(dateText), { size: 8, color: SOFT });
    p.text(PAGE.w - MARGIN, FOOTER_Y + 24, t.page(i + 1, total), {
      size: 8, color: SOFT, align: "right",
    });
  });

  return doc.build({ title: t.title }).blob;
}
