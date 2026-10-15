#!/bin/bash
# Encrypted backup of the safeprint database: shop/counter registrations,
# session records and the audit log.
#
# Uploaded documents are deliberately NOT backed up. They live for minutes and
# are destroyed by deleting their keys; a copy elsewhere would bring "deleted"
# documents back.
#
#   backup.sh        run forever, once a day at BACKUP_HOUR_UTC
#   backup.sh now    one backup immediately
set -uo pipefail

KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
HOUR_UTC="${BACKUP_HOUR_UTC:-21}"

run_backup() {
  local ts out
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="/backups/safeprint-$ts.archive.gz.enc"
  mongodump --quiet --uri "$MONGO_URI" --db safeprint --archive --gzip \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$out.tmp" \
    || { rm -f "$out.tmp"; echo "[backup] FAILED: mongodump/encrypt" >&2; return 1; }
  mv "$out.tmp" "$out"
  echo "[backup] wrote $out ($(stat -c %s "$out") bytes)"

  find /backups -name 'safeprint-*.enc' -mtime +"$((KEEP_DAYS - 1))" -print -delete

  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    curl --fail --silent --show-error --max-time 300 \
      --aws-sigv4 "aws:amz:${BACKUP_S3_REGION}:s3" \
      --user "${BACKUP_S3_ACCESS_KEY}:${BACKUP_S3_SECRET_KEY}" \
      --upload-file "$out" \
      "${BACKUP_S3_ENDPOINT%/}/${BACKUP_S3_BUCKET}/$(basename "$out")" \
      && echo "[backup] uploaded to bucket ${BACKUP_S3_BUCKET}" \
      || { echo "[backup] FAILED: upload to object storage" >&2; return 1; }
  fi
}

if [ "${1:-}" = "now" ]; then
  run_backup
  exit $?
fi

while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "today ${HOUR_UTC}:00" +%s)"
  [ "$next" -le "$now" ] && next=$((next + 86400))
  echo "[backup] next backup at $(date -u -d "@$next" '+%F %H:%M UTC')"
  sleep $((next - now))
  run_backup || true
done
