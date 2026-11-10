#!/bin/sh
# Run as root in noodara-uat. Prints sanitized comparisons only; never backup contents.
set -eu
umask 077
compose() { docker compose -f /opt/noodara/docker-compose.yml --project-directory /opt/noodara "$@"; }
sql() { compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -At' sh "$1"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/opt/noodara-backup/v052-$stamp
rehearsal=noodara_v052_restore_$(date +%s)_$$
mkdir -m 700 "$backup"
created=false
cleanup() {
  if [ "$created" = true ]; then
    compose exec -T postgres sh -c 'dropdb --if-exists -U "$POSTGRES_USER" "$1"' sh "$rehearsal" >/dev/null
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
cat > "$backup/compare.sql" <<'SQL'
select 'users='||count(*) from users;
select 'servers='||count(*) from servers;
select 'projects='||count(*) from projects;
select 'environments='||count(*) from environments;
select 'services='||count(*) from services;
select 'deployments='||count(*) from deployments;
select 'secrets='||count(*) from secrets;
select 'domains='||count(*) from domains;
select 'migrations='||count(*) from drizzle.__drizzle_migrations;
select 'migration_state='||coalesce(md5(string_agg(row_to_json(s)::text, ',' order by s.id)),'empty') from drizzle.__drizzle_migrations s;
select 'secret_state='||coalesce(md5(string_agg(id::text||encrypted_value||key_version::text, ',' order by id)),'empty') from secrets;
select 'credential_state='||coalesce(md5(string_agg(id::text||encrypted_value||key_version::text, ',' order by id)),'empty') from credentials;
select 'ai_settings='||coalesce(md5(string_agg(row_to_json(s)::text, ',' order by s.id)),'empty') from ai_provider_settings s;
SQL
database=$(compose exec -T postgres sh -c 'printf %s "$POSTGRES_DB"')
sql "$database" < "$backup/compare.sql" > "$backup/before.txt"
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
tar -C / -czf "$backup/recovery-config.tgz" opt/noodara/.env opt/noodara/docker-compose.yml opt/uat-pebble
chmod 600 "$backup"/*
test -s "$backup/database.dump"
test -s "$backup/recovery-config.tgz"
mkdir -m 700 "$backup/config-check"
tar -xzf "$backup/recovery-config.tgz" -C "$backup/config-check"
cmp /opt/noodara/.env "$backup/config-check/opt/noodara/.env"
grep -Eq '^NOODARA_MASTER_KEY=.+$' "$backup/config-check/opt/noodara/.env"
grep -Eq '^BETTER_AUTH_SECRET=.+$' "$backup/config-check/opt/noodara/.env"
cmp /opt/uat-pebble/uat-pebble.yml "$backup/config-check/opt/uat-pebble/uat-pebble.yml"
cmp /opt/uat-pebble/pebble.minica.pem "$backup/config-check/opt/uat-pebble/pebble.minica.pem"
compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$rehearsal"
created=true
compose exec -T postgres sh -c 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$1"' sh "$rehearsal" < "$backup/database.dump" >/dev/null
sql "$rehearsal" < "$backup/compare.sql" > "$backup/restored.txt"
cmp "$backup/before.txt" "$backup/restored.txt"
cleanup
created=false
test "$(sql "$database" <<SQL
select count(*) from pg_database where datname='$rehearsal';
SQL
)" = 0
printf 'backupPath=%s\n' "$backup"
printf '%s\n' 'backupDirectoryMode=700 backupFilesMode=600 databaseRestore=PASS migrationDataEncryptedCredentialsBYOK=equal masterKeyAndAuthRecovery=present configAndACMERecovery=equal rehearsalDatabaseRemoved=true'
cat "$backup/before.txt"
