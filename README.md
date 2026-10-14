# SafePrint — secure OTP-gated, zero-download print portal (MVP)

Let a citizen share a sensitive document (Aadhaar, PAN, marksheet, bank statement…) with a
neighborhood photocopy shop so the shop can **print it exactly once without ever being able to
download, save, forward, or retain a copy**.

## The core loop

The OTP works like a ride OTP in Rapido or Uber: it is generated fresh for every session, shown
**only in the citizen's app**, and said out loud at the counter. No SMS is involved.

1. **Shop, once** (`/shop` or the desktop agent): sets up the counter with a name and area → gets
   a **counter QR + 6-char counter code** to display. No password; the browser/agent keeps a
   private device key.
2. **Citizen** (phone browser): scans the counter QR (opens `/?shop=CODE` → "Printing at Sharma
   Xerox, Andheri") and uploads a PDF/JPG/PNG → gets a **6-digit OTP** valid for 10 minutes
   (Show/Hide toggle, Regenerate button, live status, 30-minute self-destruct countdown). A
   refresh keeps the OTP on screen.
3. The job appears in the counter's **Incoming jobs** list. The operator picks it and types the
   OTP the citizen reads out (max 5 wrong tries, then the file is destroyed; the citizen sees a
   live "⚠ 2 wrong attempts" warning). A paired job opens **only from that counter**.
4. On a correct OTP the citizen's phone asks **"Sharma Xerox wants to open your document —
   Allow / Deny"** (auto-denied after 2 minutes). Nothing is viewable until they tap Allow.
5. The document opens in a **locked, view-only viewer** — rendered onto `<canvas>` via PDF.js.
   Right-click, Ctrl+S, Ctrl+P, copy, drag, and text selection are blocked; there is no URL,
   `<img>`, `<embed>` or blob link in the DOM for "Save as" to grab.
6. Operator clicks **Print** (max 2 attempts) → native browser print dialog (or silent physical
   print in the agent) → confirms the print.
7. On confirmation — or when the window closes, or when the 30-minute TTL expires — the file is
   **permanently deleted** (blob removed + encryption keys blanked) and the citizen's screen
   updates live.

### Fixing a document at the counter

A real shop fixes a badly aligned file before printing it. SafePrint lets the operator do the
same without ever getting a downloadable or editable copy to keep:

- **Layout** (no permission needed, logged with the print): turn pages, nudge them by the
  millimetre, shrink / fit to paper, choose A4 / Letter / Legal, print in black & white, skip pages.
  Pages can't be enlarged past the paper; a layout that pushes content off the sheet is flagged on
  screen and recorded in the audit log (`offPaper`). Changing what a page says needs **Edit**.
  Mixed portrait/landscape documents print the way a printer handles them: one sheet orientation
  for the job, with pages running the other way turned 90° on the sheet instead of shrunk.
- **Edit** (customer consent required, twice):
  1. Operator taps **Edit** → the citizen's phone asks *"Sharma Xerox wants to EDIT your
     document — Allow / Deny"* (auto-denied after 2 minutes).
  2. After Allow, the operator edits either
     - **as Word** (uploaded `.docx`/`.doc` files): the real document opens in an embedded
       ONLYOFFICE editor — fonts, alignment, spacing, text — with *download, print and copy
       switched off* in the editor's signed permissions, or
     - **with photo tools** (any PDF/photo/scan): crop, rotate, straighten, perspective-fix a
       skewed phone photo, brightness/contrast/B&W, *scan cleanup* (whitens paper, removes
       shadows), whiteout, eraser, pen, text, boxes, lines and arrows — with undo/redo.
  3. **Send to customer for approval** → the edited version goes to the server (encrypted), never
     to the operator's disk. The citizen's phone shows exactly what will print → **Approve**
     makes it the print copy (the old version is shredded) or **Reject** discards it.
  - Printing is blocked while an edit is open or under review. Max 3 edit rounds per document;
    the session gets a one-time 15-minute extension when editing is allowed.

Citizens who didn't scan a QR (or shops that never set up a counter) use the fallback: the
citizen's screen shows a **share code + OTP**, and the operator types both at `/shop`. The Allow
step still applies.

## Run it locally

Prerequisites: **Node 20+** and **MongoDB running on `127.0.0.1:27017`**
(`brew install mongodb-community && brew services start mongodb-community`).

```bash
npm install
npm run dev
```

Open <http://localhost:3000/shop> (set up a counter) and the QR/`/?shop=CODE` link in a second
window (citizen page). The OTP appears **only** on the citizen's screen — it is never logged.

No env vars are required for local dev (MongoDB only; Word files are refused).

**Word uploads + Word editing** need the ONLYOFFICE Document Server: `docker compose up -d`
starts it (and MongoDB), then set `ONLYOFFICE_URL`, `ONLYOFFICE_JWT_SECRET` and
`SAFEPRINT_INTERNAL_URL` as shown in `docker-compose.yml`. The photo/page editor needs nothing
extra. To customize, copy `.env.example` to `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/safeprint` | Sessions + audit logs only — never file contents |
| `MASTER_KEY` | dev-derived constant | 64 hex chars; **required in production** (server refuses to start without it) |
| `STORAGE_DRIVER` | `local` | `local` or `gcs` |
| `LOCAL_STORE_DIR` | `.safeprint-store` | Encrypted blob dir for the local driver |
| `GCS_BUCKET` | — | Bucket name when `STORAGE_DRIVER=gcs` |
| `REDIS_URL` | — | Optional shared rate-limit store; in-memory when unset |
| `SESSION_TTL_SECONDS` | `1800` | Session/file lifetime |
| `OTP_TTL_SECONDS` | `600` | Lifetime of one OTP (citizen can regenerate up to 5 times) |
| `APPROVAL_TIMEOUT_SECONDS` | `120` | Time the citizen has to tap Allow |
| `SAFEPRINT_AUTO_APPROVE` | — | `1` skips the Allow tap — dev/tests only, ignored in production |
| `CLEANUP_INTERVAL_MS` | `60000` | Background sweep cadence |
| `ONLYOFFICE_URL` | — | ONLYOFFICE Document Server base URL (reachable by browsers **and** this server). Unset = Word uploads refused |
| `ONLYOFFICE_JWT_SECRET` | — | Shared secret; must equal the Document Server's `JWT_SECRET` |
| `SAFEPRINT_INTERNAL_URL` | request origin | How the Document Server reaches this app server-to-server |
| `EDIT_TTL_EXTENSION_SECONDS` | `900` | One-time session extension when the citizen allows an edit |
| `WORD_CONVERSION_CONCURRENCY` | `2` | Word conversions running at once (per app process) |
| `WORD_CONVERSION_QUEUE` | `10` | Further Word uploads allowed to wait; beyond that they get **503 "busy, try again"** |
| `WORD_CONVERSION_WAIT_MS` | `20000` | How long a waiting Word upload waits for a slot before getting 503 |
| `TRUST_PROXY_HOPS` | `1` | Proxies in front of the app that **append** to `X-Forwarded-For` (nginx `$proxy_add_x_forwarded_for`, a load balancer). The client IP is taken that many entries **from the right**; the client-supplied left part is never trusted. `2` for CDN → LB → app; `0` if nothing is in front (then all clients share one rate-limit bucket — don't expose `next start` directly) |
| `VERIFY_GLOBAL_MISS_LIMIT` | `300` | Failed OTP checks per minute, service-wide, before verification **without a counter key** pauses for a minute (registered counters are never braked) |
| `SESSION_RETENTION_DAYS` | `30` | Ended sessions keep a scrubbed record (no file name) this long, then MongoDB deletes it (TTL) |
| `AUDIT_RETENTION_DAYS` | `90` | Audit entries (they carry client IPs) expire after this. Changing it later needs a `collMod` on the `at_1` index |

## Security model

- **Encryption at rest**: every file is AES-256-GCM encrypted with a random per-file key (DEK);
  the DEK is wrapped with the master key and stored only in the session document. Deletion removes
  the blob **and** blanks the wrapped key — crypto-shredding, so even a leaked blob copy is
  unreadable. Storage never sees plaintext.
- **In-app OTP, three checks**: the counter pairing (device key) or share code locates the
  session; the OTP (fresh per session, 10-minute life, HMAC-hashed at rest, compared timing-safe,
  5 attempts, never logged) proves the citizen is at the counter; the citizen's **Allow** tap
  releases it. A correct OTP mints a viewer token that is useless until Allow — `render`/`print`
  accept it **only in the `Authorization` header** and only once approved. The citizen's owner
  token is also header-only (no tokens in any URL).
- **No recoverable local copy**: bytes are fetched with the header token and painted onto canvas.
  `Cache-Control: no-store` + `Content-Disposition: inline` on every API response; no
  `<a>/<img>/<embed>/<iframe>` elements; `user-select: none`; right-click/copy/drag/Ctrl+S/Ctrl+P
  suppressed. Print uses `@media print` CSS so only the canvases reach the print dialog.
- **Rate limits**: 10 uploads/hour/IP, 15 OTP checks/min/IP, 30 renders/min/IP, 5 counter
  registrations/hour/IP, 30 status streams/min/IP (max 3 open per session), plus per-session caps
  (5 OTP tries, 5 OTP regenerations, 2 print attempts, 20 render fetches). Client IPs come only
  from the hop our own proxy appended (`TRUST_PROXY_HOPS`), so a forged `X-Forwarded-For` can't
  dodge them. Redis-backed when `REDIS_URL` is set (in-memory limits are per process).
- **No share-code oracle**: `/api/verify-otp` answers every failure a stranger could probe
  (unknown code, another counter's session, wrong/expired OTP, lockout) with the same
  `401 "Wrong code or OTP."`; only the paired counter gets specific messages for its own sessions.
  Each share code allows 5 checks/minute whatever the IP, and once failed checks pass
  `VERIFY_GLOBAL_MISS_LIMIT`/minute service-wide, unpaired verification pauses — scanning for live
  codes (to lock other people's sessions) is impractical, and registered counters are unaffected.
- **Bounded uploads**: request bodies are refused on `Content-Length` and cut off while
  streaming once past the limit, before anything is parsed — an oversized upload can't exhaust
  server memory.
- **Browser hardening**: a nonce-based Content-Security-Policy on every page (`strict-dynamic`; the
  only third-party origin is your ONLYOFFICE server, when configured), `frame-ancestors 'none'`,
  HSTS in production, `Referrer-Policy: no-referrer`, a locked-down `Permissions-Policy`. In
  production `ONLYOFFICE_URL` must be `https://` (its script runs inside the shop's page). The
  unused Next.js image optimizer is disabled.
- **Audit log** per session: upload, OTP failures/success/regeneration, approval
  requested/granted/denied/timed out, renders, print attempts, confirmation, deletion, expiry —
  each with timestamp + IP (+ counter id) (`auditlogs` collection). Uploads are logged by file type
  and size, never file name.
- **Retention**: when a session ends its file name is replaced with `[deleted]` immediately; the
  scrubbed record is deleted after `SESSION_RETENTION_DAYS` and audit entries after
  `AUDIT_RETENTION_DAYS` (MongoDB TTL indexes). Older ended sessions are scrubbed by the cleanup
  sweep.
- **Key separation**: the OTP HMAC key is derived from `MASTER_KEY` with HKDF
  (`safeprint/otp/v1`), separate from the key that wraps file keys. (OTPs issued before this change
  stop matching; the customer taps Regenerate.)

- **Editing** never gives the shop a file: the image editor works on in-memory canvases and
  uploads its result straight to `/api/edit/pages`; the Word editor is ONLYOFFICE with download,
  print and copy disabled by permissions the server signs (the browser can't change them).
  The Document Server fetches the Word source through `/api/onlyoffice/file` with a sealed
  (AES-GCM, 5–10 min) reference **and** a JWT the Document Server signed for that exact URL —
  the editor config the shop's browser holds is signed with the same secret, so any other token
  (including that one) is refused. Saves arrive at `/api/onlyoffice/callback` (JWT-verified;
  results are fetched only from the configured Document Server host). Tokens without an expiry
  are rejected. While photo-editing, the operator's screen carries the same `SP-<code>` watermark
  as the viewer; the pages sent for review are clean and get watermarked when displayed. Every
  version — original, Word source, unreviewed edits — is encrypted like the upload and
  crypto-shredded when the session ends. Upload and edit rounds are audit-logged
  (`word_converted`, `edit_requested/granted/denied/timeout/cancelled/submitted/approved/rejected`),
  and print attempts record the layout used.

### Honest limitations (MVP, browser-only by design)

A browser cannot stop an operator from choosing **"Save as PDF" inside the native print dialog**,
photographing the screen, or extracting canvas pixels via devtools — the OS print dialog is not
scriptable from a web page. The mitigation implemented here is **session-coded watermarking**:
every canvas pixel (screen and print are the same pixels) carries a faint diagonal
`SAFEPRINT · SP-<code>` tile plus a footer with the share code, date/time, and "single authorised
copy — duplication prohibited". A copy that escapes via Save-as-PDF, photo, or devtools is a
visibly marked, audit-traceable copy — near-worthless for identity fraud — not a clean original.
Full prevention of the escape path needs the out-of-scope Windows print agent (or print-server
integration). What this MVP proves is the default-path guarantee: *nothing is downloaded, cached,
or left on disk in the normal flow*, and the file provably stops existing server-side after one
print or 30 minutes.

Editing widens what the operator sees, unavoidably: while editing as Word the document's text is
live in the operator's browser (copy is disabled, but devtools can read it), and the Document
Server holds a working copy in its cache until it expires — `deploy/onlyoffice/local-production-linux.json`
shortens that from 24 hours to 30 minutes (verified against ONLYOFFICE 8.3: the server loads this
file and deletes cached documents on schedule). Two more safeguards close the gaps the cache
expiry doesn't cover:
- When a Word edit round or the session ends, SafePrint tells the Document Server to disconnect
  the editor (`drop`) — an editor left open after the session expired goes read-only and can't
  reload the file — and the shop's screen closes itself.
- If a save callback ever fails, ONLYOFFICE keeps the document as a "forgotten" file that **never
  expires**. SafePrint deletes this session's forgotten copies when a round or the session ends,
  and the cleanup sweep removes any SafePrint forgotten copy (`sp…` keys only) every minute.

Run the Document Server on infrastructure you control.
That is why editing needs the citizen's Allow first and their approval of the result after.

## What's mocked vs production-ready

| Piece | Status |
|---|---|
| Encryption, session/OTP lifecycle, audit log, TTL cleanup | Real, working |
| Locked viewer (PDF.js on canvas) + print flow | Real, working |
| Session-coded watermark on every rendered/printed pixel (browser portal only) | Real, working |
| Local encrypted storage (`lib/storage/local.ts`) | Real — dev stand-in for GCS behind the same interface |
| GCS storage (`lib/storage/gcs.ts`) | Written but unexercised — needs `npm i @google-cloud/storage`, creds, bucket + 1-day lifecycle rule (deletion backstop); see file header |
| In-app OTP (per session, expiring, regenerable) + citizen Allow/Deny | Real, working — no SMS needed |
| Counter pairing (QR + device key, incoming jobs queue) | Real, working (browser portal + agent) |
| Rate limiting | Real — Redis when `REDIS_URL` is set, in-memory fallback otherwise |
| Tests | `npm test` — unit + full route flow against local MongoDB; runs in CI (`web-ci.yml`) |
| HTTPS | Terminate TLS at your proxy/host in production; dev is plain HTTP |
| Desktop agent (silent physical-only printing, capture blocking) | Real, working — verified end-to-end by `npm run selftest`; installers unsigned until signing keys are added |
| Word upload (→ PDF) and Word editing | Real, working with a self-hosted ONLYOFFICE Document Server (`docker-compose.yml`) |
| Photo/page editor, layout tools, edit consent + review | Real, working (browser portal). The agent has the layout tools; editing happens in the browser portal |

## SafePrint Agent (desktop app — closes the Save-as-PDF hole)

The browser portal cannot control the OS print dialog. The **SafePrint Agent** (`agent/`,
Electron, one codebase for **Windows / macOS / Linux**) removes the dialog from the flow
entirely:

- **Silent, direct-to-device printing** — the job goes straight to a chosen printer's spooler
  (`webContents.print({ silent: true, deviceName })`). The print dialog never opens, so
  "Save as PDF" and every other virtual destination simply never exists.
- **Physical printers only** — virtual/file printers (Microsoft Print to PDF, XPS, OneNote,
  CUPS-PDF, PDF24, CutePDF, Foxit…) are filtered by name *and* driver-model string
  (`agent/printer-filter.cjs`, unit-tested). The main process re-validates the chosen printer at
  print time, so a spoofed request from the UI is rejected too.
- **HTTPS-only servers** — the agent refuses `http://` server addresses (they would carry the
  counter's device key, the session token and document bytes in clear), except a server on the
  same machine (`localhost`/`127.0.0.1`) for testing. Built on Electron 44.
- **Screenshot/screen-capture blocking** — `setContentProtection(true)`: the window renders
  black in captures and screen shares on **Windows** (`SetWindowDisplayAffinity`) and **macOS**
  (`NSWindowSharingNone`). **Linux has no OS API for this** — documented gap.
- **Counter mode** — first launch sets up the counter (server, shop name, area): the agent shows
  the counter QR and the incoming jobs list, and the operator types only the OTP, then waits for
  the citizen's Allow. The device key is kept in the main process (`userData/counter.json`) and
  never reaches the renderer.
- **Token isolation** — the viewer token lives only in the Electron main process; the sandboxed
  renderer (contextIsolation, no Node, CSP, all navigation/permissions denied) receives document
  bytes and printer names, nothing else.
- **Audit attribution** — the server logs `client: agent/<version>` in the audit trail
  (`X-SafePrint-Client` header), so agent-verified prints are distinguishable from browser prints.
- **No watermark** — unlike the browser portal, the agent prints clean. The watermark is the
  browser's fallback for a print path it can't control; the agent removes that path outright
  (dialog-free, physical printers only), so the watermark is unnecessary.
- **Nothing on disk** — decrypted bytes exist only in memory; canvases are wiped on completion;
  closing the window fires a best-effort session-close so the server destroys the file.

Still not stoppable, agent or not: photographing the screen/paper, an admin who installs a
capture driver or a virtual printer masquerading with a physical driver's name (the filter is a
heuristic), and OS spooler artifacts (jobs are rasterized; direct-spool scrubbing would be a
production hardening step).

```bash
cd agent && npm install          # also vendors pdf.js into renderer/
npm start                        # run against any SafePrint server URL
npm run selftest -- --server=http://localhost:3000 --code=ABC123 --otp=123456
# (start the server with SAFEPRINT_AUTO_APPROVE=1, or tap Allow on the citizen page)
npm run dist                     # build installer for the current OS
```

Cross-platform installers (dmg/zip, nsis exe, AppImage/deb) build in CI on native runners —
push a tag like `agent-v0.1.0` or run the **Build SafePrint Agent** workflow manually; artifacts
attach to the GitHub release.

### Code signing / first-run

The macOS build is **ad-hoc signed** (`scripts/afterpack-sign.cjs`, `mac.identity: null`) so the
app bundle's resources are properly sealed — without this, an Apple Silicon Mac reports the app as
*"damaged and can't be opened"* rather than merely unverified. It is still **not notarized**
(that needs a paid Apple Developer ID), so first-run friction remains until real signing certs are
added as repo secrets:

- **macOS** — Gatekeeper blocks the download on first open. Clear the quarantine flag, then launch:
  `xattr -dr com.apple.quarantine "/Applications/SafePrint Agent.app"`
- **Windows** — SmartScreen: *More info → Run anyway* (add `CSC_LINK`/`CSC_KEY_PASSWORD` secrets to sign).
- **Linux** — `chmod +x` the AppImage, or `sudo apt install ./…deb`.

## Project structure

```
app/
  page.tsx              citizen: shop pairing, upload, in-app OTP, Allow/Deny, live status
  shop/page.tsx         shop portal: counter setup → QR + jobs → OTP → wait for Allow → viewer
  api/upload            encrypt + store + pair with counter + mint OTP
  api/verify-otp        5-attempt OTP check → viewer token (inactive until Allow)
  api/approve           citizen Allow / Deny
  api/approval-status   shop polls for the citizen's answer
  api/regenerate-otp    citizen requests a new OTP
  api/shops/*           register a counter, look up a code, list a counter's jobs
  api/render            decrypted bytes, header-auth only, no-store
  api/print-attempt     max-2 print counter
  api/confirm-print     delete file immediately on confirmation
  api/session-close     sendBeacon target for window-close deletion
  api/status(/stream)   citizen's live status (streamed; polling fallback)
  api/edit/*            edit consent + review: request, decision, status, cancel, pages
                        (photo-editor output → PDF), finish (Word force-save), preview, review
  api/onlyoffice/*      Document Server only: sealed file fetch + save callback
components/LockedViewer.tsx   canvas rendering + input locks + layout panel + edit flow + print
components/ImageEditor.tsx    photo tools (Fabric.js): crop, perspective, cleanup, whiteout, text…
components/WordEditor.tsx     embedded ONLYOFFICE editor (download/print/copy off)
components/EditReview.tsx     citizen's preview of the edited version → Approve / Reject
components/ShopCounter.tsx    counter QR + incoming jobs + OTP entry
lib/                    crypto, storage adapters, rate limit (Redis/memory), auth helpers,
                        lifecycle (OTP issue/approval/finalize), cleanup job
models/                 Session, Shop, AuditLog Mongoose schemas
tests/                  node:test suites (npm test)
instrumentation.ts      starts the background cleanup sweep on boot
```

## Verified end-to-end

Counter setup renders QR + code → `/?shop=CODE` shows "Printing at …" → upload → OTP shown only
on the citizen's screen (never in server logs) and survives a page refresh → job appears in the
counter's queue → wrong OTP shows a live warning on the phone → paired job refuses verification
without the counter's key or with another counter's key → correct OTP raises the Allow prompt;
the document stays unrenderable (403) until Allow → Deny voids the viewer token → Regenerate
invalidates the old OTP → Allow opens the locked viewer → close/print deletes the file and the
phone updates via the status stream → owner token in a URL query is refused. The agent selftest
passes the approval flow plus counter register/QR/jobs/forget. `npm test` covers the same flow,
OTP expiry (410, no attempt counted), approval timeout, regenerate cap and 5-strike lockout with
crypto-shredding.

Editing, verified in a browser (Playwright, shop window + phone viewport): layout panel → A4,
nudge, skip a page → print media shows only the included page on A4 with the watermark; photo
tools → whiteout over an old stamp, text, box, crop, straighten → customer Allow → review on the
phone → Approve → the edited version renders as the print copy. With a real ONLYOFFICE 8.3
Document Server: a `.docx` upload converts to PDF; **Edit as Word** opens the editor with no
Download/Print in its File menu; fixing the indentation/alignment and sending it → the phone shows
the corrected pages → Approve → the shop prints the corrected version. `npm test` covers the edit
consent/review state machine, round cap, render/print blocked mid-edit, shredding of every
version, the Word callback against a fake Document Server, JWT/sealed-reference checks and the
layout math. Not verified: a real Redis server (the unreachable-Redis fallback is), a real
30-minute wait, and real GCS.
