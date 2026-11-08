set -eu
umask 077
compose() { docker compose -f /opt/noodara/docker-compose.yml --project-directory /opt/noodara "$@"; }
counts() {
compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
select 'users='||count(*) from users;
select 'servers='||count(*) from servers;
select 'projects='||count(*) from projects;
select 'environments='||count(*) from environments;
select 'services='||count(*) from services;
select 'deployments='||count(*) from deployments;
select 'secrets='||count(*) from secrets;
select 'domains='||count(*) from domains;
select 'migrations='||count(*) from drizzle.__drizzle_migrations;
select 'secret_state='||md5(string_agg(id::text||encrypted_value||key_version::text, ',' order by id)) from secrets;
select 'credential_state='||md5(string_agg(id::text||encrypted_value||key_version::text, ',' order by id)) from credentials;
select 'ai_settings='||md5(string_agg(row_to_json(s)::text, ',' order by s.id)) from ai_provider_settings s;
SQL
}
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /opt/noodara-backup
chmod 700 /opt/noodara-backup
counts > /tmp/noodara-v051-before.txt
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "/opt/noodara-backup/pre-v051-$ts.dump"
cp /opt/noodara/.env "/opt/noodara-backup/env-pre-v051-$ts"
chmod 600 "/opt/noodara-backup/pre-v051-$ts.dump" "/opt/noodara-backup/env-pre-v051-$ts"
echo '# verified backup files mode 600'
grep '^NOODARA_VERSION=' /opt/noodara/.env
curl -fsSL https://raw.githubusercontent.com/Nooodara/noodara/v0.5.1-rc.1/install.sh -o /tmp/noodara-v051-install.sh
NOODARA_VERSION=0.5.1-rc.1 sh /tmp/noodara-v051-install.sh
# Retain the existing UAT ACME configuration, as in the v0.5.0 smoke.
compose -f /opt/uat-pebble/uat-pebble.yml up -d
sleep 15
counts > /tmp/noodara-v051-after.txt
diff -u /tmp/noodara-v051-before.txt /tmp/noodara-v051-after.txt
echo '# preserved users/servers/projects/environments/services/deployments/secrets/domains/migrations and encrypted secret/BYOK state'
grep '^NOODARA_VERSION=' /opt/noodara/.env
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
