# Nightly encrypted MongoDB backup for SafePrint (see ../README.md).
FROM mongo:7
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT []
CMD ["backup.sh"]
