import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * Stacks — home library triage
 * Photograph books, let Claude read the spines, then swipe each one
 * Keep or Donate (Tinder-style) and shelve it by room. Persists locally.
 * ------------------------------------------------------------------ */

const ROOMS = [
  { id: "downstairs", label: "Downstairs", code: "DN" },
  { id: "living", label: "Living room", code: "LR" },
  { id: "bedroom", label: "Bedroom", code: "BR" },
  { id: "office", label: "Office", code: "OF" },
];
const ROOM_MAP = Object.fromEntries(ROOMS.map((r) => [r.id, r]));

const BOOKS_KEY = "books";
const thumbKey = (id) => `thumb:${id}`;
const SWIPE_THRESHOLD = 88;

const prefersReduced =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- storage helpers (best-effort, never throw) ---------- */

async function loadBooks() {
  try {
    const res = await window.storage.get(BOOKS_KEY);
    return res ? JSON.parse(res.value) : [];
  } catch {
    return [];
  }
}
async function saveBooks(books) {
  try {
    await window.storage.set(BOOKS_KEY, JSON.stringify(books));
  } catch (e) {
    console.error("Could not save library", e);
  }
}
async function saveThumb(id, dataUrl) {
  try {
    await window.storage.set(thumbKey(id), dataUrl);
  } catch (e) {
    console.error("Could not save thumbnail", e);
  }
}
async function loadThumb(id) {
  try {
    const res = await window.storage.get(thumbKey(id));
    return res ? res.value : null;
  } catch {
    return null;
  }
}
async function deleteThumb(id) {
  try {
    await window.storage.delete(thumbKey(id));
  } catch {
    /* ignore */
  }
}

/* ---------- image handling ---------- */

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });
}

const API_MIME = /^image\/(jpeg|png|gif|webp)$/;

function resizeToJpeg(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/* ---------- book identification via Claude vision ---------- */

const VISION_MODELS = ["claude-sonnet-4-6", "claude-sonnet-5", "claude-3-5-sonnet-latest"];

function normalizeBooks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((b) => b && typeof b.title === "string" && b.title.trim())
    .map((b) => ({
      title: b.title.trim(),
      author: b.author && String(b.author).trim() ? String(b.author).trim() : null,
    }));
}

/* Tolerant parser: handles clean arrays, stray prose, and TRUNCATED output
   (a big shelf can exceed the token budget) by salvaging complete objects. */
function parseBookList(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    const p = JSON.parse(clean);
    if (Array.isArray(p)) return normalizeBooks(p);
  } catch {}
  const s = clean.indexOf("[");
  const e = clean.lastIndexOf("]");
  if (s !== -1 && e !== -1 && e > s) {
    try {
      const p = JSON.parse(clean.slice(s, e + 1));
      if (Array.isArray(p)) return normalizeBooks(p);
    } catch {}
  }
  const objs = clean.match(/\{[^{}]*\}/g) || [];
  const out = [];
  for (const o of objs) {
    try { out.push(JSON.parse(o)); } catch {}
  }
  return normalizeBooks(out);
}

async function identifyBooks(base64, mediaType = "image/jpeg") {
  const prompt =
    "You are cataloguing books from a photo of a cover, a stack, or a shelf of spines. " +
    "Identify every distinct book you can read, reading spines top-to-bottom and left-to-right. " +
    "Respond with ONLY a JSON array, no prose and no markdown fences. " +
    'Each element must be {"title": string, "author": string|null}. ' +
    "Use the exact title as printed. If the author is not legible, use null. " +
    "If you cannot read any book, return [].";

  const payload = (model) => ({
    model,
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  let lastErr = null;
  for (const model of VISION_MODELS) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(model)),
      });
      if (!response.ok) {
        lastErr = new Error(`Vision request failed (${response.status})`);
        continue; // try the next model
      }
      const data = await response.json();
      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return parseBookList(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Vision unavailable");
}

const newId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ================================================================== */

export default function Stacks() {
  const [books, setBooks] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("sort"); // 'sort' | 'library'
  const [filterRoom, setFilterRoom] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [scanState, setScanState] = useState({ busy: false, note: "" });
  const [activeRoom, setActiveRoom] = useState(null); // room chosen at upload time
  const [frontQueue, setFrontQueue] = useState([]); // ids to surface first in the deck
  const [history, setHistory] = useState([]); // decided ids, for undo
  const [editingId, setEditingId] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      const list = await loadBooks();
      setBooks(list);
      setLoaded(true);
      for (const b of list) {
        const t = await loadThumb(b.id);
        if (t) setThumbs((prev) => ({ ...prev, [b.id]: t }));
      }
    })();
  }, []);

  useEffect(() => {
    if (loaded) saveBooks(books);
  }, [books, loaded]);

  const updateBook = useCallback((id, patch) => {
    setBooks((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const removeBook = useCallback((id) => {
    setBooks((prev) => prev.filter((b) => b.id !== id));
    setThumbs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setHistory((prev) => prev.filter((x) => x !== id));
    deleteThumb(id);
  }, []);

  /* ---------- scan ---------- */
  const onPickFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;

    setScanState({ busy: true, note: "Reading the photo…" });

    // Produce a display thumbnail + an API-ready image, as resiliently as
    // possible. Canvas may be blocked in some sandboxes, so we fall back to
    // sending the raw file bytes, and finally to a manual card.
    let thumb = null; // dataURL for display / storage
    let apiB64 = null; // base64 (no prefix) for the vision call
    let apiMime = "image/jpeg";
    let degraded = false;

    // Attempt 1 — decode and canvas-resize (smallest, most reliable format)
    try {
      let src = null;
      try {
        src = await createImageBitmap(file);
      } catch {
        src = null;
      }
      if (!src) src = await fileToImage(file);
      try {
        thumb = resizeToJpeg(src, 320, 0.62);
        apiB64 = resizeToJpeg(src, 1024, 0.72).split(",")[1] || null;
        apiMime = "image/jpeg";
      } catch {
        /* canvas blocked — handled below */
      }
      if (src && typeof src.close === "function") src.close();
    } catch {
      /* decode failed — handled below */
    }

    // Attempt 2 — send the raw file bytes (no canvas needed)
    if (!apiB64) {
      degraded = true;
      try {
        const raw = await readFileAsDataURL(file); // data:<mime>;base64,...
        const comma = raw.indexOf(",");
        const header = raw.slice(0, comma);
        const bytes = raw.slice(comma + 1) || null;
        const m = header.match(/data:([^;]+)/);
        const type = (m && m[1]) || file.type || "image/jpeg";
        if (bytes && API_MIME.test(type)) {
          apiB64 = bytes;
          apiMime = type;
        }
        if (!thumb) thumb = raw; // display the original even if we can't send it
      } catch {
        /* couldn't read bytes at all */
      }
    }

    // Identify (only if we have something the API can read)
    let found = [];
    if (apiB64) {
      try {
        setScanState({ busy: true, note: "Looking up the titles…" });
        found = await identifyBooks(apiB64, apiMime);
      } catch (err) {
        console.error(err);
        found = [];
      }
    }

    const stamp = Date.now();
    const created =
      found.length > 0
        ? found.map((b, i) => ({
            id: newId(),
            title: b.title,
            author: b.author,
            room: activeRoom,
            status: null,
            createdAt: stamp + i,
          }))
        : [
            {
              id: newId(),
              title: "",
              author: null,
              room: activeRoom,
              status: null,
              createdAt: stamp,
              needsTitle: true,
            },
          ];

    for (const b of created) {
      if (thumb) {
        setThumbs((prev) => ({ ...prev, [b.id]: thumb }));
        saveThumb(b.id, thumb);
      }
    }

    setBooks((prev) => [...created, ...prev]);
    setFrontQueue((prev) => [...created.map((b) => b.id), ...prev]);

    if (found.length > 0) {
      setView("sort");
      setScanState({
        busy: false,
        note: `Added ${found.length} ${found.length === 1 ? "book" : "books"} — swipe to sort.`,
      });
    } else {
      setView("library");
      setEditingId(created[0].id);
      setScanState({
        busy: false,
        note: apiB64
          ? "Couldn't read a title on that one — type it on the new card."
          : degraded
          ? "This device blocked automatic reading — the card's ready, just type the title."
          : "Couldn't read that image — the card's ready, add the title by hand.",
      });
    }
  }, [activeRoom]);

  /* ---------- decisions ---------- */
  const decide = useCallback((id, status) => {
    setBooks((prev) => prev.map((b) => (b.id === id ? { ...b, status } : b)));
    setHistory((prev) => [...prev, id]);
  }, []);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const id = prev[prev.length - 1];
      setBooks((bs) => bs.map((b) => (b.id === id ? { ...b, status: null } : b)));
      setFrontQueue((q) => [id, ...q.filter((x) => x !== id)]);
      return prev.slice(0, -1);
    });
  }, []);

  /* ---------- derived ---------- */
  const counts = useMemo(() => {
    let keep = 0, donate = 0, undecided = 0;
    for (const b of books) {
      if (b.status === "keep") keep++;
      else if (b.status === "donate") donate++;
      else undecided++;
    }
    return { total: books.length, keep, donate, undecided };
  }, [books]);

  const roomCounts = useMemo(() => {
    const m = {};
    for (const r of ROOMS) m[r.id] = 0;
    m.unassigned = 0;
    for (const b of books) m[b.room || "unassigned"]++;
    return m;
  }, [books]);

  const callNumbers = useMemo(() => {
    const perRoom = {};
    const map = {};
    const ordered = [...books].sort((a, b) => a.createdAt - b.createdAt);
    for (const b of ordered) {
      const code = b.room ? ROOM_MAP[b.room].code : "··";
      perRoom[code] = (perRoom[code] || 0) + 1;
      map[b.id] = `${code}·${String(perRoom[code]).padStart(3, "0")}`;
    }
    return map;
  }, [books]);

  /* deck = undecided, front-queued ids first, then newest */
  const deck = useMemo(() => {
    const undecided = books.filter((b) => !b.status);
    const rank = new Map(frontQueue.map((id, i) => [id, i]));
    return [...undecided].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      if (ra !== rb) return ra - rb;
      return b.createdAt - a.createdAt;
    });
  }, [books, frontQueue]);

  const visible = useMemo(() => {
    return books
      .filter((b) => {
        if (filterRoom === "unassigned" && b.room) return false;
        if (filterRoom !== "all" && filterRoom !== "unassigned" && b.room !== filterRoom)
          return false;
        if (filterStatus === "undecided" && b.status) return false;
        if ((filterStatus === "keep" || filterStatus === "donate") && b.status !== filterStatus)
          return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [books, filterRoom, filterStatus]);

  return (
    <div className="stacks-root">
      <style>{CSS}</style>

      <header className="masthead">
        <div className="wordmark">
          <h1>STACKS</h1>
          <p className="tagline">home library triage — photograph, swipe, shelve</p>
        </div>
        <div className="tally" role="status">
          <Tally n={counts.total} label="catalogued" />
          <Tally n={counts.keep} label="keeping" tone="keep" />
          <Tally n={counts.donate} label="to donate" tone="donate" />
          <Tally n={counts.undecided} label="undecided" tone="mute" />
        </div>
      </header>

      <div className="shelf-picker">
        <span className="shelf-label">Shelving to</span>
        {ROOMS.map((r) => (
          <button
            key={r.id}
            className={`chip ${activeRoom === r.id ? "on" : ""}`}
            onClick={() => setActiveRoom((cur) => (cur === r.id ? null : r.id))}
          >
            {r.label}
          </button>
        ))}
        <button
          className={`chip ${activeRoom === null ? "on" : ""}`}
          onClick={() => setActiveRoom(null)}
        >
          Unshelved
        </button>
      </div>

      <div className="scanbar">
        <button
          className="scan-btn"
          onClick={() => fileRef.current && fileRef.current.click()}
          disabled={scanState.busy}
        >
          {scanState.busy
            ? "Working…"
            : activeRoom
            ? `Scan into ${ROOM_MAP[activeRoom].label}`
            : "Scan a book"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPickFile}
          hidden
        />
        <span className={`scan-note ${scanState.busy ? "pulsing" : ""}`}>
          {scanState.note ||
            (activeRoom
              ? `Photograph the ${ROOM_MAP[activeRoom].label.toLowerCase()} shelf — every book lands there, ready to swipe.`
              : "Pick a room above, then snap a cover, a stack, or a whole shelf of spines.")}
        </span>
      </div>

      <div className="segmented" role="tablist">
        <button
          role="tab"
          className={`seg ${view === "sort" ? "on" : ""}`}
          onClick={() => setView("sort")}
        >
          Sort <em>{counts.undecided}</em>
        </button>
        <button
          role="tab"
          className={`seg ${view === "library" ? "on" : ""}`}
          onClick={() => setView("library")}
        >
          Library <em>{counts.total}</em>
        </button>
      </div>

      {view === "sort" ? (
        <SortDeck
          deck={deck}
          thumbs={thumbs}
          callNumbers={callNumbers}
          onDecide={decide}
          onUndo={undo}
          canUndo={history.length > 0}
          total={counts.total}
          decided={counts.keep + counts.donate}
          hasBooks={books.length > 0}
          onGoLibrary={() => setView("library")}
        />
      ) : (
        <>
          <div className="filters">
            <div className="filter-line">
              <span className="filter-label">Room</span>
              <Chip active={filterRoom === "all"} onClick={() => setFilterRoom("all")}>All</Chip>
              {ROOMS.map((r) => (
                <Chip key={r.id} active={filterRoom === r.id} onClick={() => setFilterRoom(r.id)}>
                  {r.label}<em>{roomCounts[r.id]}</em>
                </Chip>
              ))}
              <Chip active={filterRoom === "unassigned"} onClick={() => setFilterRoom("unassigned")}>
                Unshelved<em>{roomCounts.unassigned}</em>
              </Chip>
            </div>
            <div className="filter-line">
              <span className="filter-label">Fate</span>
              {[["all", "All"], ["keep", "Keeping"], ["donate", "To donate"], ["undecided", "Undecided"]].map(
                ([id, label]) => (
                  <Chip
                    key={id}
                    active={filterStatus === id}
                    onClick={() => setFilterStatus(id)}
                    tone={id}
                  >
                    {label}
                  </Chip>
                )
              )}
            </div>
          </div>

          <main className="drawer">
            {!loaded ? (
              <p className="empty">Opening the drawer…</p>
            ) : visible.length === 0 ? (
              <p className="empty">
                {books.length === 0
                  ? "The catalog is empty. Scan your first book to begin the cull."
                  : "No cards match this drawer. Loosen the filters above."}
              </p>
            ) : (
              <div className="cards">
                {visible.map((b) => (
                  <Card
                    key={b.id}
                    book={b}
                    thumb={thumbs[b.id]}
                    callNo={callNumbers[b.id]}
                    editing={editingId === b.id}
                    onEdit={() => setEditingId(b.id)}
                    onStopEdit={() => setEditingId(null)}
                    onChange={(patch) => updateBook(b.id, patch)}
                    onRemove={() => removeBook(b.id)}
                  />
                ))}
              </div>
            )}
          </main>
        </>
      )}

      <footer className="colophon">
        Kept locally on this device.{" "}
        {counts.donate > 0 && (
          <>
            Donation pile: <strong>{counts.donate}</strong>{" "}
            {counts.donate === 1 ? "book" : "books"} — see it under Library → “To donate”.
          </>
        )}
      </footer>
    </div>
  );
}

/* ================================================================== */

function SortDeck({
  deck, thumbs, callNumbers, onDecide, onUndo, canUndo,
  total, decided, hasBooks, onGoLibrary,
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [flying, setFlying] = useState(null); // { id, dir }
  const startRef = useRef(null);
  const top = deck[0];

  const commit = useCallback(
    (dir) => {
      if (!top || flying) return;
      const status = dir === "right" ? "keep" : "donate";
      if (prefersReduced) {
        setDrag({ x: 0, y: 0, active: false });
        onDecide(top.id, status);
        return;
      }
      setFlying({ id: top.id, dir });
      window.setTimeout(() => {
        onDecide(top.id, status);
        setFlying(null);
        setDrag({ x: 0, y: 0, active: false });
      }, 300);
    },
    [top, flying, onDecide]
  );

  /* keyboard sorting */
  useEffect(() => {
    const onKey = (e) => {
      if (!top || flying) return;
      if (e.key === "ArrowRight") commit("right");
      else if (e.key === "ArrowLeft") commit("left");
      else if (e.key === "Backspace" || e.key.toLowerCase() === "u") {
        if (canUndo) { e.preventDefault(); onUndo(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, flying, commit, canUndo, onUndo]);

  const onPointerDown = (e) => {
    if (!top || flying) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ x: 0, y: 0, active: true });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onPointerMove = (e) => {
    if (!drag.active || !startRef.current) return;
    setDrag({
      x: e.clientX - startRef.current.x,
      y: e.clientY - startRef.current.y,
      active: true,
    });
  };
  const onPointerUp = () => {
    if (!drag.active) return;
    if (drag.x > SWIPE_THRESHOLD) commit("right");
    else if (drag.x < -SWIPE_THRESHOLD) commit("left");
    else setDrag({ x: 0, y: 0, active: false });
  };

  if (!top) {
    return (
      <div className="deck-empty">
        <div className="deck-empty-mark">✦</div>
        <p className="deck-empty-title">
          {hasBooks ? "Every book is sorted." : "Nothing to sort yet."}
        </p>
        <p className="deck-empty-sub">
          {hasBooks
            ? "Head to the Library to shelve your keepers by room, or scan another stack."
            : "Tap “Scan a book” above and the deck fills up here."}
        </p>
        {hasBooks && (
          <button className="ghost-btn" onClick={onGoLibrary}>Go to Library</button>
        )}
      </div>
    );
  }

  const progress = Math.min(Math.abs(drag.x) / SWIPE_THRESHOLD, 1);
  const dir = flying ? flying.dir : drag.x > 0 ? "right" : "left";
  const keepOp = flying ? (flying.dir === "right" ? 1 : 0) : Math.max(0, Math.min(drag.x / SWIPE_THRESHOLD, 1));
  const donateOp = flying ? (flying.dir === "left" ? 1 : 0) : Math.max(0, Math.min(-drag.x / SWIPE_THRESHOLD, 1));

  return (
    <div className="sortwrap">
      <div className="progress">
        <span className="progress-text">{decided} of {total} sorted</span>
        <span className="progress-bar">
          <span className="progress-fill" style={{ width: total ? `${(decided / total) * 100}%` : "0%" }} />
        </span>
        <span className="progress-left">{deck.length} to go</span>
      </div>

      <div className="deck">
        {deck.slice(0, 3).map((b, i) => {
          const isTop = i === 0;
          let transform, transition, opacity = 1;
          if (isTop) {
            let tx = drag.x, ty = drag.y, rot = drag.x / 18;
            if (flying) {
              tx = flying.dir === "right" ? 820 : -820;
              rot = flying.dir === "right" ? 26 : -26;
              opacity = 0;
            }
            transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
            transition = drag.active && !flying ? "none" : "transform .3s ease, opacity .3s ease";
          } else {
            const grow = i === 1 ? progress * 0.05 : 0;
            const rise = i === 1 ? progress * 12 : 0;
            transform = `translateY(${i * 12 - rise}px) scale(${1 - i * 0.05 + grow})`;
            transition = "transform .2s ease";
          }
          return (
            <article
              key={b.id}
              className={`deck-card ${isTop ? "top" : ""}`}
              style={{ transform, transition, opacity, zIndex: 10 - i }}
              onPointerDown={isTop ? onPointerDown : undefined}
              onPointerMove={isTop ? onPointerMove : undefined}
              onPointerUp={isTop ? onPointerUp : undefined}
              onPointerCancel={isTop ? onPointerUp : undefined}
            >
              {isTop && (
                <>
                  <span className="deck-stamp keep" style={{ opacity: keepOp }}>KEEP</span>
                  <span className="deck-stamp donate" style={{ opacity: donateOp }}>DONATE</span>
                  <span
                    className="tilt-hint"
                    style={{ opacity: drag.active ? 0.0 : 0.0 }}
                    aria-hidden="true"
                  />
                </>
              )}
              <div className="deck-callno">{callNumbers[b.id]}</div>
              <div className="deck-cover">
                {thumbs[b.id] ? (
                  <img src={thumbs[b.id]} alt="" draggable="false" />
                ) : (
                  <div className="deck-cover-blank">📖</div>
                )}
              </div>
              <div className="deck-meta">
                <div className="deck-title">{b.title || "Untitled"}</div>
                <div className="deck-author">{b.author || "author unknown"}</div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="deck-controls">
        <button className="round donate" onClick={() => commit("left")} aria-label="Donate">
          <span className="round-glyph">←</span>
          <span className="round-label">Donate</span>
        </button>
        <button className="round undo" onClick={onUndo} disabled={!canUndo} aria-label="Undo">
          <span className="round-glyph">↺</span>
          <span className="round-label">Undo</span>
        </button>
        <button className="round keep" onClick={() => commit("right")} aria-label="Keep">
          <span className="round-glyph">→</span>
          <span className="round-label">Keep</span>
        </button>
      </div>
      <p className="deck-hint">Swipe or drag the card · ← donate · → keep · already shelved by room</p>
    </div>
  );
}

/* ================================================================== */

function Tally({ n, label, tone }) {
  return (
    <div className={`tally-item ${tone ? "t-" + tone : ""}`}>
      <span className="tally-n">{n}</span>
      <span className="tally-l">{label}</span>
    </div>
  );
}

function Chip({ active, onClick, children, tone }) {
  return (
    <button className={`chip ${active ? "on" : ""} ${tone ? "chip-" + tone : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Card({ book, thumb, callNo, editing, onEdit, onStopEdit, onChange, onRemove }) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author || "");

  useEffect(() => {
    setTitle(book.title);
    setAuthor(book.author || "");
  }, [book.title, book.author]);

  const commit = () => {
    onChange({ title: title.trim(), author: author.trim() || null, needsTitle: false });
    onStopEdit();
  };
  const toggle = (status) => onChange({ status: book.status === status ? null : status });

  return (
    <article className={`card status-${book.status || "none"}`}>
      <div className="card-head">
        <span className="callno">{callNo}</span>
        <button className="remove" onClick={onRemove} aria-label="Remove this card">✕</button>
      </div>

      <div className="card-body">
        <div className="thumb-wrap">
          {thumb ? (
            <img className="thumb" src={thumb} alt="" />
          ) : (
            <div className="thumb thumb-blank" aria-hidden="true">📖</div>
          )}
          {book.status && (
            <span className={`stamp stamp-${book.status}`}>
              {book.status === "keep" ? "KEEP" : "DONATE"}
            </span>
          )}
        </div>

        <div className="meta">
          {editing ? (
            <div className="edit">
              <input
                className="edit-title" value={title} autoFocus placeholder="Title"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commit()}
              />
              <input
                className="edit-author" value={author} placeholder="Author"
                onChange={(e) => setAuthor(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commit()}
              />
              <button className="save" onClick={commit}>Save card</button>
            </div>
          ) : (
            <button className="meta-read" onClick={onEdit} title="Tap to edit">
              <span className="title">
                {book.title || <em className="ghost">Untitled — tap to name</em>}
              </span>
              <span className="author">{book.author || "author unknown"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="card-controls">
        <div className="fate">
          <button className={`fate-btn keep ${book.status === "keep" ? "on" : ""}`} onClick={() => toggle("keep")}>Keep</button>
          <button className={`fate-btn donate ${book.status === "donate" ? "on" : ""}`} onClick={() => toggle("donate")}>Donate</button>
        </div>
        <div className="rooms">
          {ROOMS.map((r) => (
            <button
              key={r.id}
              className={`room-chip ${book.room === r.id ? "on" : ""}`}
              onClick={() => onChange({ room: book.room === r.id ? null : r.id })}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

/* ================================================================== */

const CSS = `
.stacks-root{
  --desk:#22271f; --desk-2:#1b201a;
  --card:#efe9d8; --card-edge:#d8cfb6;
  --ink:#241f17; --ink-soft:#6b6151;
  --brass:#a9884f; --brass-dim:#8a7141;
  --keep:#3c6e57; --keep-ink:#2b5140;
  --donate:#8a2b2b; --donate-ink:#6e2020;
  --rule:rgba(169,136,79,.35);
  min-height:100vh;
  background:radial-gradient(120% 90% at 50% -10%, #2b3128 0%, var(--desk) 46%, var(--desk-2) 100%);
  color:var(--card);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  padding:20px 16px 60px;box-sizing:border-box;
}
.stacks-root *{box-sizing:border-box;}

.masthead{display:flex;flex-wrap:wrap;gap:18px 28px;align-items:flex-end;justify-content:space-between;
  border-bottom:1px solid var(--rule);padding-bottom:16px;margin-bottom:18px;}
.wordmark h1{margin:0;font-size:34px;letter-spacing:.22em;font-weight:800;color:#f3ecda;text-shadow:0 1px 0 rgba(0,0,0,.35);}
.tagline{margin:2px 0 0;font-size:12.5px;letter-spacing:.02em;color:#b9b09a;font-style:italic;}
.tally{display:flex;gap:16px;flex-wrap:wrap;}
.tally-item{display:flex;flex-direction:column;align-items:flex-start;line-height:1;}
.tally-n{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:22px;color:#f0e9d6;}
.tally-l{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#9d947f;margin-top:4px;}
.t-keep .tally-n{color:#8fd0b5;}
.t-donate .tally-n{color:#e79a9a;}
.t-mute .tally-n{color:#c8bfa8;}

.shelf-picker{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
.shelf-label{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#8f8672;margin-right:2px;}
.scanbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px;}
.scan-btn{appearance:none;border:none;cursor:pointer;background:linear-gradient(#c9a86a,#a9884f);color:#241c0e;
  font-weight:700;font-size:15px;letter-spacing:.02em;padding:12px 22px;border-radius:2px;
  box-shadow:0 2px 0 #6f5a30,0 6px 14px rgba(0,0,0,.35);transition:transform .08s ease, box-shadow .08s ease;}
.scan-btn:hover{transform:translateY(-1px);}
.scan-btn:active{transform:translateY(1px);box-shadow:0 1px 0 #6f5a30,0 3px 8px rgba(0,0,0,.35);}
.scan-btn:disabled{opacity:.55;cursor:progress;}
.scan-note{font-size:13px;color:#c3baa4;max-width:52ch;}
.scan-note.pulsing{animation:pulse 1.1s ease-in-out infinite;color:#e9dfc6;}
@keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}

/* segmented tabs */
.segmented{display:inline-flex;border:1px solid var(--rule);border-radius:999px;padding:3px;margin-bottom:22px;background:rgba(0,0,0,.14);}
.seg{appearance:none;border:none;cursor:pointer;background:transparent;color:#c7bea8;font-size:13.5px;font-weight:600;
  padding:7px 18px;border-radius:999px;display:inline-flex;align-items:center;gap:7px;transition:all .12s ease;}
.seg em{font-style:normal;font-family:ui-monospace,monospace;font-size:11px;color:#9a9079;}
.seg.on{background:#efe9d8;color:#241f17;}
.seg.on em{color:#6b6151;}

/* ---------- sort deck ---------- */
.sortwrap{display:flex;flex-direction:column;align-items:center;}
.progress{width:100%;max-width:360px;display:flex;align-items:center;gap:10px;margin:0 auto 14px;font-size:11.5px;color:#a89f89;}
.progress-text{font-family:ui-monospace,monospace;white-space:nowrap;}
.progress-left{font-family:ui-monospace,monospace;white-space:nowrap;color:#8f8672;}
.progress-bar{flex:1;height:4px;background:rgba(169,136,79,.2);border-radius:999px;overflow:hidden;}
.progress-fill{display:block;height:100%;background:linear-gradient(90deg,var(--keep),#5c9179);transition:width .3s ease;}

.deck{position:relative;width:100%;max-width:360px;height:452px;margin:0 auto;touch-action:none;user-select:none;}
.deck-card{position:absolute;inset:0;background:
    repeating-linear-gradient(0deg,transparent 0 27px,rgba(151,120,60,.10) 27px 28px),var(--card);
  color:var(--ink);border:1px solid var(--card-edge);border-radius:4px;
  box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 16px 30px rgba(0,0,0,.34);
  padding:16px;display:flex;flex-direction:column;gap:12px;will-change:transform;}
.deck-card.top{cursor:grab;}
.deck-card.top:active{cursor:grabbing;}
.deck-callno{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.06em;color:var(--brass-dim);
  border:1px solid var(--rule);padding:2px 7px;border-radius:2px;background:rgba(169,136,79,.08);align-self:flex-start;}
.deck-cover{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:3px;background:#ded4bd;
  border:1px solid rgba(0,0,0,.12);}
.deck-cover img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;}
.deck-cover-blank{font-size:64px;color:#b7ac93;}
.deck-meta{display:flex;flex-direction:column;gap:5px;}
.deck-title{font-family:Georgia,"Iowan Old Style","Times New Roman",serif;font-size:22px;line-height:1.15;color:var(--ink);}
.deck-author{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:var(--ink-soft);}
.deck-stamp{position:absolute;top:30px;font-weight:800;font-size:30px;letter-spacing:.1em;padding:6px 14px;
  border:4px solid currentColor;border-radius:6px;text-transform:uppercase;mix-blend-mode:multiply;pointer-events:none;
  box-shadow:0 0 0 1.5px currentColor inset;}
.deck-stamp.keep{right:22px;color:var(--keep-ink);transform:rotate(11deg);}
.deck-stamp.donate{left:22px;color:var(--donate-ink);transform:rotate(-11deg);}

.deck-controls{display:flex;align-items:center;justify-content:center;gap:22px;margin-top:22px;}
.round{appearance:none;cursor:pointer;background:transparent;border:none;display:flex;flex-direction:column;align-items:center;gap:6px;color:#c7bea8;}
.round-glyph{width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;
  border:2px solid;background:rgba(239,233,216,.05);transition:transform .1s ease, background .12s ease;}
.round-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9d947f;}
.round.keep .round-glyph{color:#8fd0b5;border-color:var(--keep);}
.round.donate .round-glyph{color:#e79a9a;border-color:var(--donate);}
.round.undo .round-glyph{color:#c8bfa8;border-color:var(--rule);width:48px;height:48px;font-size:20px;}
.round:not(:disabled):hover .round-glyph{transform:translateY(-2px);}
.round.keep:not(:disabled):active .round-glyph{background:var(--keep);color:#eafff5;}
.round.donate:not(:disabled):active .round-glyph{background:var(--donate);color:#ffeaea;}
.round:disabled{opacity:.35;cursor:default;}
.deck-hint{margin-top:16px;font-size:11.5px;color:#8f8672;text-align:center;letter-spacing:.02em;}

.deck-empty{max-width:360px;margin:30px auto;text-align:center;padding:40px 20px;border:1px dashed var(--rule);border-radius:6px;}
.deck-empty-mark{font-size:28px;color:var(--brass);margin-bottom:8px;}
.deck-empty-title{font-family:Georgia,serif;font-size:20px;color:#f0e9d6;margin:0 0 6px;}
.deck-empty-sub{font-size:13px;color:#a89f89;margin:0 0 18px;line-height:1.5;}
.ghost-btn{appearance:none;cursor:pointer;background:transparent;border:1px solid var(--brass);color:#e9dfc6;
  font-size:13px;padding:9px 18px;border-radius:2px;}
.ghost-btn:hover{background:rgba(169,136,79,.14);}

/* ---------- library grid ---------- */
.filters{display:flex;flex-direction:column;gap:10px;margin-bottom:22px;}
.filter-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.filter-label{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#8f8672;width:44px;flex:none;}
.chip{appearance:none;cursor:pointer;font-size:12.5px;background:transparent;color:#c7bea8;border:1px solid var(--rule);
  padding:6px 11px;border-radius:999px;display:inline-flex;align-items:center;gap:7px;transition:all .12s ease;}
.chip em{font-style:normal;font-family:ui-monospace,monospace;font-size:11px;color:#9a9079;}
.chip:hover{border-color:var(--brass);color:#efe8d5;}
.chip.on{background:#efe9d8;color:#241f17;border-color:#efe9d8;}
.chip.on em{color:#6b6151;}
.chip.chip-keep.on{background:var(--keep);border-color:var(--keep);color:#eafff5;}
.chip.chip-donate.on{background:var(--donate);border-color:var(--donate);color:#ffeaea;}

.empty{color:#a89f89;font-style:italic;text-align:center;padding:48px 12px;font-size:15px;}
.cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));}
.card{background:repeating-linear-gradient(0deg,transparent 0 27px,rgba(151,120,60,.10) 27px 28px),var(--card);
  color:var(--ink);border:1px solid var(--card-edge);border-radius:2px;
  box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 10px 20px rgba(0,0,0,.28);
  padding:12px 14px 14px;position:relative;display:flex;flex-direction:column;gap:10px;}
.card-head{display:flex;justify-content:space-between;align-items:center;}
.callno{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.06em;color:var(--brass-dim);
  border:1px solid var(--rule);padding:2px 7px;border-radius:2px;background:rgba(169,136,79,.08);}
.remove{appearance:none;border:none;background:transparent;cursor:pointer;font-size:13px;color:#b0a68e;padding:2px 4px;line-height:1;border-radius:3px;}
.remove:hover{color:var(--donate);}
.card-body{display:flex;gap:12px;}
.thumb-wrap{position:relative;flex:none;width:74px;}
.thumb{width:74px;height:100px;object-fit:cover;border-radius:2px;border:1px solid rgba(0,0,0,.18);
  box-shadow:0 2px 5px rgba(0,0,0,.25);background:#ded4bd;display:block;}
.thumb-blank{display:flex;align-items:center;justify-content:center;font-size:26px;color:#b7ac93;}
.stamp{position:absolute;top:34px;left:-8px;font-weight:800;font-size:15px;letter-spacing:.14em;padding:3px 8px;
  border:2.5px solid currentColor;border-radius:3px;transform:rotate(-11deg);mix-blend-mode:multiply;opacity:.82;
  text-transform:uppercase;pointer-events:none;box-shadow:0 0 0 1px currentColor inset;}
.stamp-keep{color:var(--keep-ink);}
.stamp-donate{color:var(--donate-ink);}
.meta{flex:1;min-width:0;display:flex;}
.meta-read{text-align:left;appearance:none;border:none;background:transparent;cursor:text;padding:0;width:100%;
  display:flex;flex-direction:column;gap:4px;color:inherit;}
.title{font-family:Georgia,"Iowan Old Style","Times New Roman",serif;font-size:18px;line-height:1.18;color:var(--ink);}
.ghost{color:#9c927c;font-size:15px;}
.author{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--ink-soft);letter-spacing:.01em;}
.meta-read:hover .title{text-decoration:underline dotted rgba(0,0,0,.25);}
.edit{display:flex;flex-direction:column;gap:7px;width:100%;}
.edit input{font:inherit;padding:7px 9px;border:1px solid var(--card-edge);border-radius:2px;background:#fbf7ec;color:var(--ink);}
.edit-title{font-family:Georgia,serif;font-size:16px;}
.edit-author{font-family:ui-monospace,monospace;font-size:12.5px;}
.save{appearance:none;border:none;cursor:pointer;align-self:flex-start;background:var(--ink);color:var(--card);font-size:12.5px;padding:7px 13px;border-radius:2px;}
.card-controls{border-top:1px dashed var(--rule);padding-top:10px;display:flex;flex-direction:column;gap:9px;}
.fate{display:flex;gap:8px;}
.fate-btn{flex:1;appearance:none;cursor:pointer;font-weight:700;font-size:13px;letter-spacing:.04em;padding:8px 0;border-radius:2px;
  border:1.5px solid;background:transparent;text-transform:uppercase;transition:all .1s ease;}
.fate-btn.keep{color:var(--keep-ink);border-color:var(--keep);}
.fate-btn.keep.on{background:var(--keep);color:#f0fff8;}
.fate-btn.donate{color:var(--donate-ink);border-color:var(--donate);}
.fate-btn.donate.on{background:var(--donate);color:#fff0f0;}
.rooms{display:flex;flex-wrap:wrap;gap:6px;}
.room-chip{appearance:none;cursor:pointer;font-size:11.5px;background:#e5dcc4;color:#5f5642;border:1px solid var(--card-edge);
  padding:5px 9px;border-radius:999px;transition:all .1s ease;}
.room-chip:hover{border-color:var(--brass);}
.room-chip.on{background:var(--ink);color:var(--card);border-color:var(--ink);}

.colophon{margin-top:30px;text-align:center;font-size:12px;color:#8f8672;letter-spacing:.02em;}
.colophon strong{color:#e79a9a;}

.stacks-root button:focus-visible,.stacks-root input:focus-visible{outline:2px solid var(--brass);outline-offset:2px;}
@media (prefers-reduced-motion:reduce){.scan-note.pulsing{animation:none;}}
@media (max-width:520px){
  .wordmark h1{font-size:28px;}
  .cards{grid-template-columns:1fr;}
  .tally{gap:12px;}
  .deck{height:60vh;min-height:400px;}
}
`;
