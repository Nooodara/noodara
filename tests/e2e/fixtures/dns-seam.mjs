// 24-04: e2e-only preload for the API process (`node --import`), wired by fixtures/stack.ts and
// never shipped in the control-plane image or compose files (H1). It points every
// `node:dns/promises` Resolver at the run's challtestsrv: before each lookup it reads the
// `127.0.0.1:<port>` the `acme` fixture wrote to $E2E_DNS_SERVER_FILE. Until that file exists the
// system resolvers stay in place. setServers is called only when the value changes (it throws while
// queries are in flight).
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const file = process.env.E2E_DNS_SERVER_FILE;
const LOOPBACK_SERVER = /^127\.0\.0\.1:\d{1,5}$/;

if (file !== undefined && file !== '') {
  const dnsPromises = createRequire(import.meta.url)('node:dns/promises');
  const Base = dnsPromises.Resolver;

  class E2eResolver extends Base {
    #applied = '';

    #sync() {
      let server = '';
      try {
        server = readFileSync(file, 'utf8').trim();
      } catch {
        return;
      }
      if (server === this.#applied || !LOOPBACK_SERVER.test(server)) return;
      try {
        this.setServers([server]);
        this.#applied = server;
      } catch {
        // A query is still pending; the next lookup retries.
      }
    }

    resolve4(hostname, options) {
      this.#sync();
      return options === undefined ? super.resolve4(hostname) : super.resolve4(hostname, options);
    }

    resolve6(hostname, options) {
      this.#sync();
      return options === undefined ? super.resolve6(hostname) : super.resolve6(hostname, options);
    }
  }

  dnsPromises.Resolver = E2eResolver;
  syncBuiltinESMExports();
}
