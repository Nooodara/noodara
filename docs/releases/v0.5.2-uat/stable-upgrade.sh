#!/bin/sh
# Executed root in the established noodara-uat VM. No env/backup contents are printed.
set -eu
umask 077
backup=${1:?private stable backup directory required}
compose() { docker compose -f /opt/noodara/docker-compose.yml --project-directory /opt/noodara "$@"; }
test -s "$backup/database.dump" && cmp "$backup/before.txt" "$backup/restored.txt"
ss -H -lnt | awk '{print $4}' | sort > "$backup/listeners-before.txt"
docker ps --format '{{.ID}} {{.Names}}' | grep -v ' noodara-' | sort > "$backup/unrelated-before.txt"
curl -fsSL --connect-timeout 10 --max-time 60 https://raw.githubusercontent.com/Nooodara/noodara/v0.5.2/install.sh -o "$backup/install-v052-stable.sh"
NOODARA_VERSION=0.5.2 sh "$backup/install-v052-stable.sh" > "$backup/installer.log" 2>&1
compose -f /opt/uat-pebble/uat-pebble.yml up -d > "$backup/overlay.log" 2>&1
compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{const h=await r.json();if(!r.ok||h.version!=='0.5.2'||Object.values(h.checks).some(v=>v!=='pass'))process.exit(1);console.log(JSON.stringify(h))})" > "$backup/health-after.json"
compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' < "$backup/compare.sql" > "$backup/after.txt"
cmp "$backup/before.txt" "$backup/after.txt"
ss -H -lnt | awk '{print $4}' | sort > "$backup/listeners-after.txt"
cmp "$backup/listeners-before.txt" "$backup/listeners-after.txt"
docker ps --format '{{.ID}} {{.Names}}' | grep -v ' noodara-' | sort > "$backup/unrelated-after.txt"
cmp "$backup/unrelated-before.txt" "$backup/unrelated-after.txt"
printf '%s\n' 'upgrade=PASS persistedCountsMigrationsEncryptedSecretCredentialBYOK=equal listeners=equal unrelatedContainers=equal existingACMEOverlay=preserved privateRecovery=retained'
grep '^NOODARA_VERSION=' /opt/noodara/.env
compose ps --format json
compose images --format json
