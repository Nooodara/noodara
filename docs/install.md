# Install Noodara

The full installation guide lives at
[https://noodara.com/docs/getting-started/install](https://noodara.com/docs/getting-started/install).

```sh
curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh
```

- [Firewall](https://noodara.com/docs/getting-started/install#firewall)
- [Plain HTTP warning](https://noodara.com/docs/getting-started/install#plain-http-warning)
- [Supported variables](https://noodara.com/docs/reference/variables)
- [Troubleshooting](https://noodara.com/docs/operate/troubleshooting)

**Logs**: All services use the `json-file` driver with automatic rotation: 50 MB max per file, 3 files retained (150 MB per service total). Location: `/var/lib/docker/containers/*/` on the host.

## .env backups

Each upgrade that changes `.env` first writes a mode-600 backup next to it as `.env.bak-<YYYYmmddHHMMSS>`. The installer keeps the newest 5 (ordered by the timestamp in the name) and deletes older ones. Override with `NOODARA_ENV_BACKUPS_KEEP=<positive integer>`; an invalid value falls back to 5 with a warning. Only regular files named exactly `.env.bak-` plus 14 digits are ever pruned.
