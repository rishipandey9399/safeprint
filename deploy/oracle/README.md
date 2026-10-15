# Launch SafePrint for free on Oracle Cloud (India)

This runs SafePrint on **one Oracle Cloud "Always Free" server** in Hyderabad or Mumbai.
All of it runs there: the app, MongoDB, the Word editor (ONLYOFFICE), automatic HTTPS
(Caddy) and nightly backups. Always Free has no end date. The only optional cost is a
domain name (about ₹800/year).

```
 phones / shop counters ──HTTPS──▶ Caddy :443 ─┬─▶ app (Next.js) ──▶ MongoDB
                                               └─▶ ONLYOFFICE ◀──(private network)── app
                                    backup ──▶ encrypted DB dump ──▶ Oracle Object Storage
```

**Memory.** Measured idle use is about 1.8 GB (ONLYOFFICE ~1.3 GB, MongoDB ~0.4 GB,
the rest under 100 MB each). ONLYOFFICE grows to 3–4 GB while documents are being edited.
The Always Free Ampere allowance (2 OCPU / 12 GB at the time of writing; check Oracle's
current numbers) is plenty.

**Word editor limit.** ONLYOFFICE Community Edition allows **20 simultaneous editing
connections**. That is far more than a launch needs. Word *conversion* (uploading a
.docx) does not count towards the limit.

---

## 1. Before you start

- **A credit card.** Oracle verifies with a small refundable charge. Indian debit and
  RuPay cards are often rejected, so use a Visa or Mastercard credit card.
- **A domain.** You need two names pointing at the server, for example
  `print.yourshop.in` (the site) and `docs.yourshop.in` (the Word editor).
  - Buy a domain (~₹800/year at any registrar), or
  - use a free DuckDNS name: `yourname.duckdns.org` also gives you
    `print.yourname.duckdns.org` and `docs.yourname.duckdns.org`.

  Customers see this address on the page and in the QR code, so a real domain looks
  more trustworthy.

## 2. Create the Oracle account

1. Sign up at <https://www.oracle.com/cloud/free/>.
2. **Home region: India South (Hyderabad)**, or India West (Mumbai). This **cannot be
   changed later**. Always Free servers only run in the home region. Hyderabad usually
   has more free Ampere capacity than Mumbai.
3. **Set a budget alert.** Go to *Billing & Cost Management → Budgets → Create budget*
   and set a ₹1 monthly budget with an email alert at 100%. Always Free resources never
   bill, so if this alert ever fires, something non-free was created by mistake.

## 3. Create the server

*Compute → Instances → Create instance*:

| Setting | Value |
|---|---|
| Image | **Canonical Ubuntu 24.04** (the aarch64 build is picked automatically for Ampere) |
| Shape | *Change shape → Ampere → **VM.Standard.A1.Flex***. Use the full Always Free allowance of OCPUs and memory. Look for the "Always Free-eligible" label |
| Networking | Create a new VCN with a **public subnet**, and tick **Assign a public IPv4 address** |
| SSH keys | Upload your public key (or download the generated pair, and keep it safe) |
| Boot volume | 100 GB (Always Free covers 200 GB in total) |

If you get **"Out of host capacity"**, there are two ways out:
- **Retry later**, or try another availability domain if the region shows one.
- **Upgrade to Pay As You Go** (*Billing → Upgrade*). Always Free resources stay free,
  and capacity is much easier to get. Keep the budget alert from step 2.

**Open the web ports.** Go to *Networking → Virtual cloud networks → your VCN → Security
lists → Default security list → Add ingress rules*, with source `0.0.0.0/0`:
- TCP destination port **80**
- TCP destination port **443**
- UDP destination port **443** (HTTP/3, optional)

Note the server's **public IP address** from the instance page.

## 4. Point your domain at the server

Create two **A records**: `print` and `docs`. Both point to the server's public IP.

If you use Cloudflare for DNS, set both to **DNS only** (grey cloud), not proxied.
Caddy needs to see visitors' real addresses for rate limiting, and it gets its own
certificates.

## 5. Prepare the server

SSH in (`ssh ubuntu@<public-ip>`) and run:

```bash
# Oracle's Ubuntu image blocks everything except SSH in its own firewall: open 80/443.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Swap as a safety net against memory spikes.
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Docker.
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit   # log in again so the docker group applies
```

Ubuntu installs security updates automatically (unattended-upgrades). Leave that on.

## 6. Configure and start SafePrint

```bash
git clone https://github.com/rishipandey9399/safeprint.git
cd safeprint/deploy/oracle
cp env.example .env && chmod 600 .env

# Fill in the secrets: run this, then paste each value into .env.
for v in MASTER_KEY ONLYOFFICE_JWT_SECRET MONGO_ROOT_PASSWORD MONGO_APP_PASSWORD BACKUP_PASSPHRASE; do
  echo "$v=$(openssl rand -hex 32)"
done
nano .env          # also set APP_DOMAIN, DOCS_DOMAIN, ACME_EMAIL

docker compose up -d --build     # first build takes ~5–10 minutes on ARM
docker compose ps                # all services "Up"; app and mongo "(healthy)"
```

**Save a copy of `.env` in your password manager.**
- Without `MASTER_KEY`, nothing in the database can be decrypted.
- Without `BACKUP_PASSPHRASE`, backups can't be restored.

Check it:
- `https://print.yourshop.in/api/health` shows `{"ok":true}`.
- `https://docs.yourshop.in/healthcheck` shows `true`. ONLYOFFICE needs 1–2 minutes
  after the first start.
- The certificate is issued automatically on the first visit. If it isn't, see
  *Troubleshooting*.

**Optional settings** go in `app.env` next to `.env`, then run `docker compose up -d`.
You can use any setting from the main `.env.example`, for example
`SESSION_TTL_SECONDS=1800` or `LIMIT_UPLOAD_PER_IP_HOUR=60`.

## 7. Start using it

- **Shop counter:** open `https://print.yourshop.in/shop` and register the counter.
  Print the QR code it shows.
- **Desktop agent:** at first launch, enter `https://print.yourshop.in` as the server.
- **Check that visitors' real IPs are logged:** do one upload from your phone on mobile
  data, then run:

  ```bash
  docker compose exec mongo mongosh -u root -p "$(grep ^MONGO_ROOT_PASSWORD .env | cut -d= -f2)" \
    --authenticationDatabase admin safeprint --quiet --eval 'db.auditlogs.find({},{ip:1}).sort({at:-1}).limit(3)'
  ```

  The newest entries should show your phone's public IP, not a `172.x` Docker address.

## 8. Backups

**What is backed up.** The `backup` service writes an **encrypted** dump of the database
every night (default 21:00 UTC = 02:30 IST) and keeps 7 days on the server. The dump
holds counter registrations, session records and the audit log.

**What is not backed up, on purpose: uploaded documents.** They live for minutes and are
destroyed by deleting their keys. A copy elsewhere would bring "deleted" documents back.
For the same reason, **don't schedule Oracle volume backups** of this server's disk.

**Copy backups off the server** (recommended, free up to 20 GB):

1. *Storage → Buckets → Create bucket*: name it `safeprint-backups`, keep it private.
2. On the bucket, go to *Lifecycle policy rules* and add a rule to delete objects older
   than 30 days.
3. *Profile (top right) → Customer secret keys → Generate secret key.* Copy the access
   key and the secret.
4. Find your **namespace** under *Profile → Tenancy*.
5. In `.env`, set:

   ```
   BACKUP_S3_ENDPOINT=https://<namespace>.compat.objectstorage.ap-hyderabad-1.oraclecloud.com
   BACKUP_S3_REGION=ap-hyderabad-1          # ap-mumbai-1 for Mumbai
   BACKUP_S3_BUCKET=safeprint-backups
   BACKUP_S3_ACCESS_KEY=...
   BACKUP_S3_SECRET_KEY=...
   ```

6. Run `docker compose up -d`, then `docker compose exec backup backup.sh now`. It
   should print "uploaded to bucket".

**Restore**, which replaces the current SafePrint data:

```bash
docker compose exec backup ls /backups
docker compose exec backup restore.sh /backups/safeprint-<timestamp>.archive.gz.enc
```

**Restore from the bucket:** download the file, then copy it in with
`docker compose cp file.enc backup:/backups/` and run the restore.

## 9. Keeping it running

| Task | How |
|---|---|
| Update SafePrint | `cd ~/safeprint && git pull && cd deploy/oracle && docker compose up -d --build` |
| Logs | `docker compose logs -f app` (or `onlyoffice`, `caddy`, `backup`) |
| Restart everything | `docker compose restart` (everything also restarts after a reboot) |
| Uptime alerts (free) | Add an HTTP monitor for `https://print.yourshop.in/api/health` at uptimerobot.com |
| Disk space | `df -h /` and `docker system df`; clean old images with `docker image prune` |

**Oracle's idle rule.** Oracle reclaims an Always Free VM only if CPU, network **and**
memory all stay under 20% for 7 days. ONLYOFFICE alone keeps memory above that, so
SafePrint's server isn't treated as idle.

## Troubleshooting

- **The certificate isn't issued** (the browser shows a TLS error). Run
  `docker compose logs caddy` and check:
  - both DNS records point at this server (`dig print.yourshop.in`);
  - ports 80/443 are open in **both** the security list (step 3) and iptables (step 5).
- **Word uploads say "busy" or fail.**
  - Run `docker compose logs onlyoffice` and check `https://docs.yourshop.in/healthcheck`.
  - Right after a restart, ONLYOFFICE needs 1–2 minutes.
- **Every visitor seems to share one IP**, so rate limits trip for everyone. Something
  is proxying in front of Caddy (for example Cloudflare's orange cloud). Switch DNS to
  "DNS only".
- **The app restarts in a loop.** Run `docker compose logs app`. A missing or malformed
  `MASTER_KEY` (it must be 64 hex characters) stops it on purpose.

## What was tested

The stack in this folder was run end to end, with a local test certificate in place of
Let's Encrypt:
- upload → code → customer Allow → print;
- Word conversion, editing and customer approval through the ONLYOFFICE editor, with
  the editor's download and print turned off;
- the strict security headers (CSP, HSTS) served through Caddy;
- a forged `X-Forwarded-For` header ignored;
- backup → wipe → restore, with a wrong passphrase refused;
- the signed upload to an S3-compatible bucket.

All images used have ARM64 builds. The ARM64 build of the app image itself is first
built on your server.
