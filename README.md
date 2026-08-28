# Stacks — installable book-triage PWA

Photograph your shelves, let a vision model read the titles, swipe **Keep** or **Donate**,
and file each book by room. Real cover art comes from Open Library, and the donation pile
exports as a PDF you can email to an organisation. Runs as a real app on your phone: live
camera, on-device storage, offline, installable to the home screen. No app store needed.

## What's in here

```
dist/                 ← the app, ready to host (this is what you deploy)
  index.html
  app.js              ← bundled React app (regenerate with `npm run build`)
  manifest.webmanifest
  service-worker.js
  icon*.png / icon.svg
src/                  ← source (edit these, then rebuild)
  App.jsx             ← the whole app: camera, deck, library, settings, export
  covers.js           ← Open Library cover lookup
  pdf.js              ← a tiny dependency-free PDF writer
  main.jsx
package.json
```

## Run it (two ways)

**A. Just use it — host the `dist/` folder.**
The camera (`getUserMedia`) only works over **HTTPS** or **localhost**, so opening the
file directly (`file://…`) won't grant camera access. Pick any static host:

- **Vercel / Netlify / Cloudflare Pages:** point it at this repo with build command
  `npm run build` and output directory `dist` (framework preset: *Other*). Letting the
  host build means editing `src/` and pushing is enough — no chance of shipping a stale
  `dist/app.js` because you forgot to rebuild. You get an HTTPS URL instantly.
- **GitHub Pages:** enable Pages on the `main` branch with folder `/dist`.
- **Local test on your phone:** `npm run serve` serves `dist/` at `http://localhost:5173`
  (localhost counts as secure). To reach it from your phone on the same Wi-Fi you'll need
  HTTPS — easiest is a quick tunnel like `npx localtunnel --port 5173` or `cloudflared tunnel`.

**No environment variables.** This is a pure client-side app, so anything configured on
the host would end up readable inside the JavaScript bundle. The Gemini key belongs in the
app's own settings, on the phone — see below.

**B. Rebuild after editing source.**
```
npm install
npm run build      # writes dist/app.js
```

Deploys need nothing else: the service worker fetches `index.html` and `app.js` fresh
first, so a new build lands on the next launch on its own. It falls back to the cache the
moment the network is slow or absent (3 s), which is what keeps the app opening instantly
offline, and other assets are served from cache and refreshed in the background.

## Install on your phone

Open the HTTPS URL in the phone browser, then:
- **iPhone (Safari):** Share → *Add to Home Screen*.
- **Android (Chrome):** menu → *Install app* / *Add to Home Screen*.

It launches full-screen with its own icon, works offline, and keeps every book in
on-device storage (IndexedDB).

## Reading titles from photos

Open **⚙** in the app and paste a **Gemini API key** from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Creating one is free and
there is a no-cost tier; the app calls Google straight from the browser, so there is no
server to run.

The key is stored in this browser's `localStorage` only — it is **never** part of the
bundled code, so hosting `dist/` publicly does not expose it, and other visitors get their
own empty settings. Anyone who can unlock the phone can read it, though, so:

- In the Google console, restrict the key to your app's address (HTTP referrer) so a
  copied key is useless elsewhere.
- Delete the key in AI Studio if you lose the device.

The app POSTs to the Gemini **Interactions API**:

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
x-goog-api-key: <your key>

{ "model": "gemini-3.7-flash",
  "input": [ { "type": "text",  "text": "<cataloguing prompt>" },
             { "type": "image", "mime_type": "image/jpeg", "data": "<base64>" } ] }
```

and reads the model's words out of the `model_output` step. The reply parser is tolerant:
markdown fences, stray prose and output truncated mid-shelf all still yield the books it
managed to name.

### Or keep the key on a server

If you'd rather not have a key on the phone at all, ⚙ → *Use my own proxy instead* takes
the URL of your own endpoint. It receives `{ "image": "<base64>", "mediaType": "image/jpeg" }`
and may answer with `[{ "title", "author" }]`, `{ "books": [...] }`, or a raw Anthropic
`{ "content": [...] }` message. A Cloudflare Worker holding an `ANTHROPIC_API_KEY` secret:

```js
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

    const { image, mediaType = "image/jpeg" } = await request.json();
    const prompt =
      "Catalogue books from this photo of covers or spines. Respond with ONLY a JSON array, " +
      'each item {"title": string, "author": string|null}. Exact printed titles. [] if none.';

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    const data = await r.json();               // pass Anthropic's message straight back;
    return new Response(JSON.stringify(data), { // the app knows how to read { content: [...] }
      headers: { "content-type": "application/json", ...cors },
    });
  },
};
```

The proxy is used only when the Gemini key is empty. Without either, Stacks is a fast
manual catalogue: every scan still captures the photo and makes a card you title yourself.

## Cover art

Once a book has a title, Stacks looks it up on
[Open Library](https://openlibrary.org) — free, keyless, no account — and, when the match
is confident, downloads the published cover and shows it instead of your shelf photo.
A title that doesn't clearly match keeps the photo rather than borrowing the wrong
artwork; the card then offers **Find cover** to try again after you fix the title.
Covers are re-encoded small and kept on the device beside the photo. Turn the whole thing
off under ⚙.

## Donation PDF

**⇩** in the header (or the link in the footer) turns everything marked *Donate* into a
PDF: grouped by room, with call numbers, publication years, an optional cover thumbnail
per book, and a header carrying who it's for, who it's from, your contact details and a
note. Pick **Español** or **English** — the built-in room names are translated too.

The writer is `src/pdf.js`, about 400 lines and no dependencies, so it works offline.
It embeds the JPEGs directly (`/DCTDecode`) and sets text in Helvetica with WinAnsi
encoding, so accents are fine. Titles in non-Latin scripts (Japanese, Russian, Greek)
have no glyphs in the built-in fonts: those characters are dropped rather than printed
as `????`, and a line that empties out falls back to a placeholder.

## Notes

- **Rooms** are chosen at capture time ("Shelving to …"); every book from that photo lands there.
- **Storage** is IndexedDB, per-browser and per-device. It is not synced across devices.
- **Privacy:** with nothing configured, photos never leave the phone. With a Gemini key,
  the captured frame goes to Google; with a proxy, only to yours. Cover lookups send the
  title and author to Open Library.
- **Reset:** clearing the site's data in browser settings wipes the catalogue, the covers
  and the saved key.
