import { describe, expect, it } from "vitest";
import { CERT_STATUSES, DNS_OUTCOMES } from "../domain/index.js";
import { ENV_SCOPES, MAX_ENV_VALUE_BYTES } from "../env/index.js";
import { PROXY_ERROR_CODES, PROXY_STATUSES } from "../proxy/index.js";
import * as contract from "./index.js";

const UUID = "0192f1a4-7b3c-7d2e-8f00-00000000aaaa";
const NOW = "2026-10-30T10:00:00.000Z";

const V04_STATUSES: readonly (readonly [contract.ServiceErrorCode, number])[] = [
  ["DOMAIN_ALREADY_ASSIGNED", 409],
  ["DOMAIN_RESERVED", 422],
  ["DOMAIN_LIMIT_REACHED", 422],
  ["PROXY_PORT_IN_USE", 409],
  ["PROXY_INSTALL_FAILED", 502],
  ["PROXY_UNAVAILABLE", 503],
  ["PROXY_IN_USE", 409],
  ["PROXY_ROUTE_FAILED", 502],
  ["ENV_KEY_DUPLICATE", 409],
  ["ENV_VALUE_MULTILINE", 422],
  ["ENV_LIMIT_REACHED", 422],
  ["SECRET_NOT_FOUND", 422],
  ["SECRET_IN_USE", 409],
  ["SECRET_NAME_DUPLICATE", 409],
  ["SECRET_LIMIT_REACHED", 422],
];

describe("v0.4 HTTP codes", () => {
  it.each(V04_STATUSES)("maps %s to %d", (code, status) => {
    expect(contract.mapServiceCodeToStatus(code)).toBe(status);
  });

  it("lists exactly the v0.4 codes in V04_SERVICE_ERROR_CODES, all mapped", () => {
    expect([...contract.V04_SERVICE_ERROR_CODES]).toEqual(V04_STATUSES.map(([code]) => code));
    expect(Object.isFrozen(contract.V04_SERVICE_ERROR_CODES)).toBe(true);
  });

  it("covers every proxy error code of the domain", () => {
    for (const code of PROXY_ERROR_CODES) {
      expect(contract.V04_SERVICE_ERROR_CODES).toContain(code);
    }
  });
});

describe("unique-violation mapper (H1)", () => {
  const pgError = (constraint: string, code = "23505") => ({ code, constraint });
  const drizzleError = (constraint: string, code = "23505") =>
    Object.assign(new Error("Failed query: insert ..."), { cause: pgError(constraint, code) });

  it("exports distinct constraint names", () => {
    const names = [
      contract.DOMAINS_HOSTNAME_UNIQUE_INDEX,
      contract.ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX,
      contract.SECRETS_OWNER_NAME_UNIQUE_INDEX,
    ];
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^[a-z_]{1,63}$/);
  });

  it.each([
    [contract.DOMAINS_HOSTNAME_UNIQUE_INDEX, "DOMAIN_ALREADY_ASSIGNED"],
    [contract.ENVIRONMENT_VARIABLES_OWNER_KEY_UNIQUE_INDEX, "ENV_KEY_DUPLICATE"],
    [contract.SECRETS_OWNER_NAME_UNIQUE_INDEX, "SECRET_NAME_DUPLICATE"],
  ] as const)("maps %s to %s, a 409, wrapped by drizzle or raw", (constraint, code) => {
    expect(contract.mapUniqueViolation(drizzleError(constraint))).toBe(code);
    expect(contract.mapUniqueViolation(pgError(constraint))).toBe(code);
    expect(contract.mapServiceCodeToStatus(code)).toBe(409);
    expect(contract.UNIQUE_CONSTRAINT_ERROR_CODES[constraint]).toBe(code);
  });

  it("returns null for another constraint, another pg code or a non-error", () => {
    expect(contract.mapUniqueViolation(drizzleError("projects_name_lower_unique_idx"))).toBeNull();
    expect(contract.mapUniqueViolation(drizzleError(contract.DOMAINS_HOSTNAME_UNIQUE_INDEX, "23503"))).toBeNull();
    expect(contract.mapUniqueViolation({ code: "23505" })).toBeNull();
    expect(contract.mapUniqueViolation({ cause: { code: "23505", constraint: 5 } })).toBeNull();
    expect(contract.mapUniqueViolation({ code: "23505", constraint: "__proto__" })).toBeNull();
    expect(contract.mapUniqueViolation({ code: "23505", constraint: "toString" })).toBeNull();
    for (const value of [null, undefined, "23505", 42, new Error("x")]) {
      expect(contract.mapUniqueViolation(value)).toBeNull();
    }
  });

  it("freezes the constraint table", () => {
    expect(Object.isFrozen(contract.UNIQUE_CONSTRAINT_ERROR_CODES)).toBe(true);
  });
});

const domainView = {
  id: UUID,
  projectId: UUID,
  serviceId: UUID,
  hostname: "app.example.com",
  httpsRedirect: true,
  certStatus: "PENDING",
  certNotAfter: null,
  certErrorCode: null,
  dnsStatus: null,
  dnsCheckedAt: null,
  applyStatus: "PENDING",
  createdAt: NOW,
  updatedAt: NOW,
};

describe("domain and proxy schemas", () => {
  it("bounds the create and update bodies and rejects unknown keys", () => {
    expect(contract.CreateDomainBodySchema.safeParse({ hostname: "app.example.com", acmeEmail: "x@y.dev" }).success).toBe(
      false,
    );
    expect(contract.UpdateDomainBodySchema.safeParse({ httpsRedirect: true, hostname: "b.example.com" }).success).toBe(
      false,
    );
    expect(contract.CreateDomainBodySchema.safeParse({ hostname: "app.example.com" }).success).toBe(true);
    expect(
      contract.CreateDomainBodySchema.safeParse({ hostname: "app.example.com", httpsRedirect: false }).success,
    ).toBe(true);
    expect(contract.CreateDomainBodySchema.safeParse({ hostname: "a".repeat(254) }).success).toBe(false);
    expect(contract.CreateDomainBodySchema.safeParse({}).success).toBe(false);
    expect(contract.UpdateDomainBodySchema.safeParse({ httpsRedirect: true }).success).toBe(true);
    expect(contract.UpdateDomainBodySchema.safeParse({ httpsRedirect: "yes" }).success).toBe(false);
    expect(contract.DomainParamsSchema.safeParse({ projectId: UUID, serviceId: UUID, domainId: UUID }).success).toBe(
      true,
    );
    expect(contract.DomainParamsSchema.safeParse({ projectId: UUID, serviceId: UUID, domainId: "x" }).success).toBe(
      false,
    );
  });

  it("validates the domain view against the domain tuples", () => {
    expect(contract.DomainViewSchema.safeParse(domainView).success).toBe(true);
    for (const certStatus of CERT_STATUSES) {
      expect(contract.DomainViewSchema.safeParse({ ...domainView, certStatus }).success).toBe(true);
    }
    for (const dnsStatus of DNS_OUTCOMES) {
      expect(contract.DomainViewSchema.safeParse({ ...domainView, dnsStatus, dnsCheckedAt: NOW }).success).toBe(true);
    }
    expect(
      contract.DomainViewSchema.safeParse({ ...domainView, certStatus: "FAILED", certErrorCode: "CERT_DNS_MISMATCH" })
        .success,
    ).toBe(true);
    expect(contract.DomainViewSchema.safeParse({ ...domainView, certStatus: "BOGUS" }).success).toBe(false);
    expect(contract.DomainViewSchema.safeParse({ ...domainView, applyStatus: "FAILED" }).success).toBe(true);
    expect(contract.DomainViewSchema.safeParse({ ...domainView, extra: 1 }).success).toBe(false);
    expect([...contract.DOMAIN_APPLY_STATUSES]).toEqual(["PENDING", "APPLIED", "FAILED"]);
    expect(contract.ListDomainsResponseSchema.safeParse({ items: [domainView] }).success).toBe(true);
  });

  it("validates the DNS instructions view", () => {
    const view = {
      hostname: "app.example.com",
      records: [{ type: "A", name: "app.example.com", value: "203.0.113.10" }],
      cnameAlternative: { type: "CNAME", name: "app.example.com", target: null },
    };
    expect(contract.DnsInstructionsViewSchema.safeParse(view).success).toBe(true);
    expect(
      contract.DnsInstructionsViewSchema.safeParse({ ...view, records: [{ type: "MX", name: "x", value: "y" }] })
        .success,
    ).toBe(false);
  });

  it("validates the proxy view and install body", () => {
    const proxy = { serverId: UUID, status: "RUNNING", errorCode: null, acmeEmail: "ops@example.com", installedAt: NOW };
    for (const status of PROXY_STATUSES) {
      expect(contract.ProxyViewSchema.safeParse({ ...proxy, status }).success).toBe(true);
    }
    for (const errorCode of contract.SERVER_PROXY_ERROR_CODES) {
      expect(contract.ProxyViewSchema.safeParse({ ...proxy, status: "FAILED", errorCode }).success).toBe(true);
    }
    // Route and in-use failures belong to a domain or a request, never to the server's proxy row.
    expect(contract.ProxyViewSchema.safeParse({ ...proxy, errorCode: "PROXY_ROUTE_FAILED" }).success).toBe(false);
    expect(contract.ProxyViewSchema.safeParse({ ...proxy, extra: 1 }).success).toBe(false);
    expect(contract.InstallProxyBodySchema.safeParse({ acmeEmail: "ops@example.com" }).success).toBe(true);
    expect(contract.InstallProxyBodySchema.safeParse({ acmeEmail: "not-an-email" }).success).toBe(false);
    expect(
      contract.InstallProxyBodySchema.safeParse({ acmeEmail: `${"a".repeat(250)}@example.com` }).success,
    ).toBe(false);
    expect(contract.InstallProxyBodySchema.safeParse({ acmeEmail: "ops@example.com", x: 1 }).success).toBe(false);
  });
});

describe("variable schemas", () => {
  it("bounds key and value and rejects unknown keys", () => {
    expect(contract.CreateVariableBodySchema.safeParse({ key: "NODE_ENV", value: "production" }).success).toBe(true);
    expect(contract.CreateVariableBodySchema.safeParse({ key: "A".repeat(129), value: "x" }).success).toBe(false);
    expect(
      contract.CreateVariableBodySchema.safeParse({ key: "A", value: "x".repeat(MAX_ENV_VALUE_BYTES + 1) }).success,
    ).toBe(false);
    expect(contract.CreateVariableBodySchema.safeParse({ key: "A", value: "x", scope: "service" }).success).toBe(false);
    expect(contract.UpdateVariableBodySchema.safeParse({ value: "x" }).success).toBe(true);
    expect(contract.UpdateVariableBodySchema.safeParse({ value: "x", key: "B" }).success).toBe(false);
    for (const scope of ENV_SCOPES) {
      expect(contract.EnvScopeSchema.safeParse(scope).success).toBe(true);
    }
    expect(contract.EnvScopeSchema.safeParse("global").success).toBe(false);
  });

  it("validates the stored variable view", () => {
    const view = { id: UUID, scope: "service", key: "NODE_ENV", value: "production", createdAt: NOW, updatedAt: NOW };
    expect(contract.VariableViewSchema.safeParse(view).success).toBe(true);
    expect(contract.ListVariablesResponseSchema.safeParse({ items: [view] }).success).toBe(true);
    expect(contract.VariableViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
  });

  it("validates the effective view with origin and shadowed definitions", () => {
    const entry = {
      key: "DATABASE_URL",
      origin: "service",
      value: { kind: "secret_ref", name: "database_url" },
      shadowed: [
        { origin: "environment", value: { kind: "plain", value: "postgres://staging" } },
        { origin: "project", value: { kind: "plain", value: "postgres://local" } },
      ],
    };
    expect(contract.EffectiveVariableViewSchema.safeParse(entry).success).toBe(true);
    expect(contract.EffectiveVariablesResponseSchema.safeParse({ items: [entry] }).success).toBe(true);
    expect(contract.EffectiveVariableViewSchema.safeParse({ ...entry, origin: "global" }).success).toBe(false);
    expect(contract.EffectiveVariableViewSchema.safeParse({ ...entry, shadowed: undefined }).success).toBe(false);
    // A secret reference never carries the secret's value.
    expect(
      contract.EffectiveVariableViewSchema.safeParse({
        ...entry,
        value: { kind: "secret_ref", name: "database_url", value: "hunter2" },
      }).success,
    ).toBe(false);
  });
});

describe("secret schemas", () => {
  const view = {
    id: UUID,
    scope: "project",
    name: "database_url",
    version: 2,
    hint: "••••••••abcd",
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("bounds name and value in the request bodies", () => {
    expect(contract.CreateSecretBodySchema.safeParse({ name: "database_url", value: "s3cr3t" }).success).toBe(true);
    expect(contract.CreateSecretBodySchema.safeParse({ name: "a".repeat(65), value: "x" }).success).toBe(false);
    expect(
      contract.CreateSecretBodySchema.safeParse({ name: "a", value: "x".repeat(contract.MAX_SECRET_VALUE_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(contract.CreateSecretBodySchema.safeParse({ name: "a", value: "x", hint: "y" }).success).toBe(false);
    expect(contract.UpdateSecretBodySchema.safeParse({ value: "rotated" }).success).toBe(true);
    expect(contract.UpdateSecretBodySchema.safeParse({ value: "rotated", name: "b" }).success).toBe(false);
  });

  it("is strict and rejects any value key (H1)", () => {
    expect(contract.SecretViewSchema.safeParse(view).success).toBe(true);
    for (const key of ["value", "encryptedValue", "plaintext", "secret"]) {
      expect(contract.SecretViewSchema.safeParse({ ...view, [key]: "hunter2" }).success).toBe(false);
    }
    expect(Object.keys(contract.SecretViewSchema.shape).some((key) => /value|plain|secret/i.test(key))).toBe(false);
    expect(contract.ListSecretsResponseSchema.safeParse({ items: [{ ...view, value: "hunter2" }] }).success).toBe(
      false,
    );
    expect(contract.ListSecretsResponseSchema.safeParse({ items: [view] }).success).toBe(true);
  });

  it("rejects a non-positive version or unknown scope", () => {
    expect(contract.SecretViewSchema.safeParse({ ...view, version: 0 }).success).toBe(false);
    expect(contract.SecretViewSchema.safeParse({ ...view, scope: "global" }).success).toBe(false);
  });
});
