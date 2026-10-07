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
