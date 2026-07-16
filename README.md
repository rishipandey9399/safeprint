# SafePrint — secure OTP-gated, zero-download print portal (MVP)

Let a citizen share a sensitive document (Aadhaar, PAN, marksheet, bank statement…) with a
neighborhood photocopy shop so the shop can **print it exactly once without ever being able to
download, save, forward, or retain a copy**.

## The core loop

1. **Citizen** (phone browser, `/`): uploads a PDF/JPG/PNG → gets a **6-char share code + 6-digit
   OTP** and a live status screen with a 30-minute self-destruct countdown.
2. Citizen tells the two codes to the shop operator **in person**.
3. **Shop** (desktop browser, `/shop`): enters share code + OTP (max 5 wrong tries, then the file
   is destroyed). No software install needed.
4. The document opens in a **locked, view-only viewer** — rendered onto `<canvas>` via PDF.js.
   Right-click, Ctrl+S, Ctrl+P, copy, drag, and text selection are blocked; there is no URL,
   `<img>`, `<embed>` or blob link in the DOM for "Save as" to grab.
5. Operator clicks **Print** (max 2 attempts) → native browser print dialog → confirms the print.
6. On confirmation — or when the window closes, or when the 30-minute TTL expires — the file is
   **permanently deleted** (blob removed + encryption keys blanked) and the citizen's screen /
   mock SMS confirms the outcome.

## Run it locally

Prerequisites: **Node 20+** and **MongoDB running on `127.0.0.1:27017`**
(`brew install mongodb-community && brew services start mongodb-community`).

```bash
npm install
npm run dev
```

Open <http://localhost:3000> (citizen upload page) and <http://localhost:3000/shop> (shop portal)
in two windows. The OTP appears on the citizen's screen and in the server console
(`[SafePrint SMS mock] OTP for …`).

No env vars are required for local dev. To customize, copy `.env.example` to `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/safeprint` | Sessions + audit logs only — never file contents |
| `MASTER_KEY` | dev-derived constant | 64 hex chars; **required in production** |
| `STORAGE_DRIVER` | `local` | `local` or `gcs` |
| `LOCAL_STORE_DIR` | `.safeprint-store` | Encrypted blob dir for the local driver |
| `GCS_BUCKET` | — | Bucket name when `STORAGE_DRIVER=gcs` |
| `SESSION_TTL_SECONDS` | `1800` | Session/file lifetime |
| `CLEANUP_INTERVAL_MS` | `60000` | Background sweep cadence |

## Security model

- **Encryption at rest**: every file is AES-256-GCM encrypted with a random per-file key (DEK);
  the DEK is wrapped with the master key and stored only in the session document. Deletion removes
  the blob **and** blanks the wrapped key — crypto-shredding, so even a leaked blob copy is
  unreadable. Storage never sees plaintext.
- **Two secrets, two channels**: the share code locates the session; the OTP (HMAC-hashed at
  rest, compared timing-safe, 5 attempts) proves in-person authorization. Success mints a one-time
  **viewer token**; `render`/`print` endpoints accept it **only in the `Authorization` header** —
  a token pasted into a URL does nothing, so no fetchable address ever exists.
- **No recoverable local copy**: bytes are fetched with the header token and painted onto canvas.
  `Cache-Control: no-store` + `Content-Disposition: inline` on every API response; no
  `<a>/<img>/<embed>/<iframe>` elements; `user-select: none`; right-click/copy/drag/Ctrl+S/Ctrl+P
  suppressed. Print uses `@media print` CSS so only the canvases reach the print dialog.
- **Rate limits**: 10 uploads/hour/IP, 15 OTP checks/min/IP, 30 renders/min/IP, plus per-session
  caps (5 OTP tries, 2 print attempts, 20 render fetches).
- **Audit log** per session: upload, OTP failures/success, renders, print attempts, confirmation,
  deletion, expiry — each with timestamp + IP (`auditlogs` collection).

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

## What's mocked vs production-ready

| Piece | Status |
|---|---|
| Encryption, session/OTP lifecycle, audit log, TTL cleanup | Real, working |
| Locked viewer (PDF.js on canvas) + print flow | Real, working |
| Session-coded watermark on every rendered/printed pixel (browser portal only) | Real, working |
| Local encrypted storage (`lib/storage/local.ts`) | Real — dev stand-in for GCS behind the same interface |
| GCS storage (`lib/storage/gcs.ts`) | Written but unexercised — needs `npm i @google-cloud/storage`, creds, bucket + 1-day lifecycle rule (deletion backstop); see file header |
| SMS/OTP delivery (`lib/otp.ts`) | Mocked — logs to console; swap in MSG91/Twilio behind `OtpProvider` |
| Rate limiting | Real but in-memory (single process); move to Redis for production |
| HTTPS | Terminate TLS at your proxy/host in production; dev is plain HTTP |
| Desktop agent (silent physical-only printing, capture blocking) | Real, working — verified end-to-end by `npm run selftest`; installers unsigned until signing keys are added |

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
- **Screenshot/screen-capture blocking** — `setContentProtection(true)`: the window renders
  black in captures and screen shares on **Windows** (`SetWindowDisplayAffinity`) and **macOS**
  (`NSWindowSharingNone`). **Linux has no OS API for this** — documented gap.
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
  page.tsx              citizen upload flow (mobile-first)
  shop/page.tsx         shop portal: code entry → locked viewer
  api/upload            encrypt + store + mint codes
  api/verify-otp        5-attempt OTP check → one-time viewer token
  api/render            decrypted bytes, header-auth only, no-store
  api/print-attempt     max-2 print counter
  api/confirm-print     delete file immediately on confirmation
  api/session-close     sendBeacon target for window-close deletion
  api/status            polled by the citizen's page
components/LockedViewer.tsx   canvas rendering + input locks + print flow
lib/                    crypto, storage adapters, OTP provider, rate limit,
                        lifecycle (single finalize/delete path), cleanup job
models/                 Session + AuditLog Mongoose schemas
instrumentation.ts      starts the background cleanup sweep on boot
```

## Verified end-to-end

Upload → OTP on console + uploader screen → wrong OTP counted (and 5-strike lockout deletes the
file) → locked viewer renders PDF on canvas with right-click/Ctrl+S/Ctrl+P/copy blocked (checked
via dispatched events: all `defaultPrevented`) → render endpoint refuses missing/URL-param tokens
and sets `no-store` → Print button opens the native dialog, confirmation deletes the blob within
~1s → uploader's page flips to "Printed & permanently deleted" and mock SMS fires → window-close
beacon deletes unprinted sessions → 10-second-TTL test instance auto-swept an untouched session.
Not verified: a real 30-minute wait (tested with `SESSION_TTL_SECONDS=10` instead) and real GCS.
