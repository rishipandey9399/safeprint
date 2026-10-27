# Is SafePrint ready for production? What still needs to be done

*Status as of October 2026, branch `claude/eloquent-franklin-f0gq8i`.*

## Verdict

**Ready for a pilot launch** (a handful of shops in one city, with you on hand) **once the
"Must do before the pilot" items below are done.** The core security, the print flow,
editing and the deployment are solid and tested.

**Not yet ready for a large public launch.** That needs:
- legal compliance
- shop verification and an admin console
- monitoring
- signed desktop installers
- real-world device testing

None of these is a rewrite. They are mostly additions around the edges.

---

## Part A — What is production-grade today

| Area | Status | Evidence |
|---|---|---|
| Core flow (upload → OTP → Allow → view → print → destroy) | ✅ Done | Unit + integration tests; browser end-to-end runs over HTTPS |
| Encryption and crypto-shredding | ✅ Done | AES-256-GCM per file; keys blanked on delete; tested |
| OTP security (hashing, constant-time compare, limits) | ✅ Done | Two security audits; scanning attack measured at chance (50.7%) after fixes |
| Rate limiting and anti-scanning brakes | ✅ Done | Per IP, per phone, per code, per counter, service-wide; forged `X-Forwarded-For` ignored (tested through Caddy) |
| Browser hardening (CSP with nonce, HSTS, no framing) | ✅ Done | Verified on the production stack |
| Shop-side editing (Word + photo tools) with customer consent and review | ✅ Done | End-to-end tested, including through the production stack |
| Data retention (file name scrubbed, 30-day sessions, 90-day audit) | ✅ Done | MongoDB TTL indexes |
| Desktop agent (silent physical printing, capture blocking) | ✅ Works | Self-test passes on Electron 44 — **but unsigned** (see B4) |
| Deployment (Oracle one-server, HTTPS, health checks) | ✅ Done | `deploy/oracle/`, full stack run locally |
| Backups (encrypted, off-server copy, restore) | ✅ Done | Backup → wipe → restore tested |
| Automated tests | ✅ 57 passing | `npm test`; CI in `.github/workflows/web-ci.yml` |

---

## Part B — What still needs to be built or done

Effort is a rough guide for one developer: **S** is up to 2 days, **M** is up to 1 week,
**L** is more than 1 week.

### 🔴 Must do before the pilot

#### B1. Legal compliance — India's DPDP Act 2023 · M (+ lawyer)

**Why.** SafePrint processes Aadhaar, PAN cards and bank statements, which is personal data
under the Digital Personal Data Protection Act. The current `app/privacy` and `app/terms`
pages don't mention the DPDP Act, and there is no grievance contact.

**What to do:**
- **Privacy notice** in DPDP terms: what is collected (the file, IP addresses, timestamps),
  why, for how long (minutes for files, 30/90 days for records), and the customer's rights.
- **Grievance officer.** Name and contact on the site, with a response process.
- **Consent wording** on the upload screen, plus a short notice in Hindi and English
  (links to B9).
- **Shop agreement**: the terms each shop accepts when registering. They are a data
  *processor* acting for the customer, they must not photograph screens, and so on.
  Record acceptance.
- **Breach-response plan**, including who notifies the Data Protection Board and users,
  and within what time.
- Have a lawyer review all of the above.

#### B2. Shop verification and an admin console · M–L

**Why.** Today **anyone can register a counter with any name**. A fraudster could register
as "Sharma Xerox, Andheri" and print a QR code saying so. There is also no way to block a
misbehaving shop, or to recover a counter whose device was lost.

**What to build:**
1. **Shop status** in `models/Shop.ts`: `pending` / `active` / `suspended`. New counters
   start `pending`, and the server refuses jobs for any counter that isn't `active`.
2. **Verification step.** Collect the shop owner's phone number (OTP-verified), the shop
   address and optionally GST. You approve each shop by hand during the pilot.
3. **Admin console** (`/admin`, protected by your own login and second factor):
   - list shops, approve or suspend them
   - see per-shop activity counts, without document details
   - revoke a counter's device key
4. **Device re-pairing.** A lost or replaced shop PC gets a new device key; the old key is
   revoked.
5. **"Verified shop" badge** on the customer's screen, only for active, verified counters.

#### B3. Monitoring and alerting · S

**Why.** On a single server, you need to know within minutes when something breaks.

**What to set up:**
- **Uptime monitor** on `/api/health` (UptimeRobot free tier), with SMS or email alerts.
- **Error tracking:** GlitchTip (self-hosted, free) or the Sentry free tier, wired into
  Next.js, with documents and tokens kept out of reports.
- **Resource alerts:** disk above 80%, memory above 90%, container restarts. A small cron
  script plus email is enough.
- **Log retention:** set Docker log rotation (`max-size`, `max-file`) in the compose file,
  so logs can't fill the disk.
- **Weekly summary** from the audit log: sessions, prints, failed OTPs, denials.

#### B4. Desktop agent: code signing and auto-update · M (+ certificate cost)

**Why.**
- The installers are **unsigned**. Windows SmartScreen warns *"Windows protected your PC"*,
  and macOS refuses until the user overrides it. Shops will think it's a virus.
- There is **no auto-update**, so every security fix means reinstalling on every counter.

**What to do:**
- **Windows:** buy an Authenticode code-signing certificate (OV is about ₹15–25k/year; EV
  clears SmartScreen at once), and add it to the `agent-release.yml` CI secrets.
- **macOS** (if any shops use Macs): Apple Developer ID (US$99/year), plus notarization in
  CI.
- **Auto-update:** add `electron-updater`, using GitHub Releases as the update feed, with
  signature checks.

#### B5. Real-world testing · S–M

**Why.** The tests so far ran in automated browsers. Real shops use old Android phones,
cheap printers and slow mobile data.

**What to test:**
- **Customer phones:** Chrome on 3–4 common Android phones (including a low-end one), and
  Safari on an iPhone.
- **Agent printers:** Windows 10/11 with the printers your pilot shops actually own
  (HP/Canon/Epson laser and inkjet).
- **Network:** slow 3G/4G, and losing the network mid-upload or mid-approval.
- **Real documents:** large scanned PDFs, multi-page Word files with tables and Hindi
  text, and rotated phone photos.
- Shop operators doing the whole flow **without your help**. Note where they get stuck.

#### B6. Operations drill · S

**What to do:**
- On the real Oracle server, do a full **restore from backup** once, and time it.
- Write a one-page **incident runbook** covering:
  - the site is down
  - a certificate failed
  - the disk is full
  - the master key is suspected leaked (rotation plan)
  - a shop is reported for misuse
- Keep `.env`, especially `MASTER_KEY` and `BACKUP_PASSPHRASE`, in a password manager,
  with a second trusted person able to access it.

### 🟠 Soon after the pilot

| # | Item | Why | Effort |
|---|---|---|---|
| B7 | **Upgrade to Next.js 16**; update the agent's build tools | Clears the remaining moderate advisories (`postcss` at build time, electron-builder dependencies). Not exploitable at runtime today, but they should be cleared | S–M |
| B8 | **External penetration test**, plus `/.well-known/security.txt` and a disclosure email | Our audits were internal; an outside tester finds what we missed | M (+ cost) |
| B9 | **Hindi and regional languages** (Marathi, Tamil…) | Most customers will prefer them; the UI and `<html lang>` are English-only today | M |
| B10 | **Accessibility audit (WCAG 2.1 AA)** | Screen readers, contrast, large text for older customers | S–M |
| B11 | **Load test** | Find the real limits of one server, especially Word editing: ONLYOFFICE Community Edition allows **20 simultaneous editors** | S |
| B12 | **Redis for rate limits** | In-memory limit counters reset when the app restarts; Redis keeps them. Needed anyway before running more than one app instance | S |
| B13 | **Customer help and support** | An FAQ page, a "report a problem" contact, and what to tell a customer whose session expired | S |
| B14 | **Privacy-friendly analytics** | Count sessions, completed prints and drop-off points, with no tracking of people or documents (e.g. self-hosted Plausible or Umami) | S |

### 🟢 For scale (later)

| # | Item | When you need it |
|---|---|---|
| B15 | **More than one server**, with a load balancer | When downtime starts costing you shops. Removes the single point of failure |
| B16 | **Managed database** (MongoDB Atlas, Mumbai) and **object storage** | With multiple servers. The GCS storage adapter is written but untested; an S3/Oracle Object Storage adapter would be needed for Oracle |
| B17 | **ONLYOFFICE commercial licence** | Beyond 20 people editing Word files at the same moment |
| B18 | **Shop billing / subscriptions** | If you charge shops per print or per month |
| B19 | **Shop dashboard** | The shop sees its own print counts and history (without documents) |
| B20 | **Masked-Aadhaar suggestion** | UIDAI recommends masked Aadhaar for most uses. Detect an Aadhaar card and suggest the masked version |
| B21 | **Master-key rotation tool** | Re-wrap stored keys under a new master key without downtime |

---

## Part C — Known limits, by design

Tell shops and customers about these honestly. They can't be fully solved in software.

1. **Photographing the screen or the printout** is always possible. The browser watermark
   makes such copies traceable to the session. The agent prints clean, physical copies
   only.
2. **In the browser portal, "Save as PDF" in the print dialog cannot be blocked.** The copy
   is watermarked. For full protection, require shops to use the **desktop agent** (you
   could make this the rule for verified shops; see B2).
3. **Linux has no screen-capture blocking** for the agent. Recommend Windows for shop
   counters.
4. **While editing a Word file, its text is in the shop's browser.** Copy is disabled, but
   browser developer tools could read it. This is why editing needs the customer's
   Allow, and why the customer reviews the result.
5. **Someone who already knows an unpaired session's share code** can use up its 5 OTP
   guesses and lock it. The fix is to only say the share code to the shop; paired (QR)
   sessions can't be locked this way.
6. **One server** (in the free setup) means the site is down while that server is down.
   Backups protect the data; B15 removes the downtime.

---

## Part D — Launch checklist

Copy this list and tick items off as you go.

**Before the pilot**
- [ ] B1 DPDP-compliant privacy notice, terms, shop agreement, grievance officer — lawyer-reviewed
- [ ] B2 Shop verification (pending → active), admin console, device revocation
- [ ] B3 Uptime monitor, error tracking, disk/memory alerts, Docker log rotation
- [ ] B4 Signed Windows agent installer; auto-update
- [ ] B5 Tested on real phones, real shop printers, slow networks, real documents
- [ ] B6 Restore drill done on the real server; incident runbook written; secrets stored safely
- [ ] Oracle server set up per [`deploy/oracle/README.md`](../deploy/oracle/README.md)
- [ ] Domain + HTTPS working; budget alert set
- [ ] Off-server backups to Object Storage confirmed
- [ ] Pilot shops trained (15 minutes each); counter QR printed and displayed

**In the first months**
- [ ] B7 Next.js 16 upgrade
- [ ] B8 External pen test + `security.txt`
- [ ] B9 Hindi (+ one regional language)
- [ ] B10 Accessibility pass
- [ ] B11 Load test
- [ ] B12 Redis
- [ ] B13 FAQ + support contact
- [ ] B14 Privacy-friendly usage analytics

**Suggested order:**
1. Do B1 and B2 first, because they need outside parties (lawyer, shop owners).
2. Do B3 and B6 next; they take about a day.
3. Start B4 early, because certificates take time to be issued.
4. Do B5 last, with the pilot shops themselves.

See also: [How SafePrint works](HOW-IT-WORKS.md).
