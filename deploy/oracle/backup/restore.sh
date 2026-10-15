#!/bin/bash
# Restore one backup file into the database (replaces the current safeprint
# collections). Usage, from deploy/oracle:
#   docker compose exec backup restore.sh /backups/safeprint-<timestamp>.archive.gz.enc
set -euo pipefail
file="${1:?usage: restore.sh /backups/safeprint-<timestamp>.archive.gz.enc}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$file" \
  | mongorestore --quiet --uri "$MONGO_URI" --archive --gzip --drop --nsInclude 'safeprint.*'
echo "[restore] restored $file"
