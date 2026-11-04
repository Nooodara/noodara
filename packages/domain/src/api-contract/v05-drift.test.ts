import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTIVITY_ACTOR_TYPES } from "../activity/index.js";
import { CREDENTIAL_SECRET_KINDS, SECRET_KINDS } from "../security/index.js";
import { ActivityActorTypeSchema } from "./v05-schemas.js";

// A3 (H2-style, as in deployment-state.test.ts): no drift between the domain tuples, the
// api-contract enum and the DB enums. The DB enum list is the cumulative result of the versioned
// migrations (CREATE TYPE + ADD VALUE).
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/control-plane/src/db/migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function dbEnumValues(typeName: string): Set<string> {
  const values = new Set<string>();
  const create = new RegExp(`CREATE TYPE "public"\\."${typeName}" AS ENUM\\(([^)]*)\\)`, "g");
  const add = new RegExp(`ALTER TYPE "public"\\."${typeName}" ADD VALUE (?:IF NOT EXISTS )?'([^']+)'`, "g");
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const match of sql.matchAll(create)) {
      for (const literal of (match[1] ?? "").matchAll(/'([^']+)'/g)) {
        if (literal[1] !== undefined) values.add(literal[1]);
      }
    }
    for (const match of sql.matchAll(add)) {
      if (match[1] !== undefined) values.add(match[1]);
    }
  }
  return values;
}

function missingFrom(domain: readonly string[], present: ReadonlySet<string>): string[] {
  return domain.filter((value) => !present.has(value));
}

// The values 26-04 adds to the domain land in the DB with migration 0018 (task 26-05, which owns
// the migrations). The exemption ends on its own: once a 0018_*.sql file exists, every domain
// value must be in the DB enum. Until then only these exact values may be missing.
const AWAITING_MIGRATION = "0018_";
const AWAITING_VALUES: Readonly<Record<string, readonly string[]>> = {
  activity_actor_type: ["ai"],
  credential_type: ["ai_provider_key"],
};

function expectedMissing(typeName: string): readonly string[] {
  const migrated = migrationFiles().some((file) => file.startsWith(AWAITING_MIGRATION));
  return migrated ? [] : (AWAITING_VALUES[typeName] ?? []);
}

describe("A3: activity actor and secret kind drift", () => {
  it("the tuples carry the v0.5 values", () => {
    expect(ACTIVITY_ACTOR_TYPES).toContain("ai");
    expect(SECRET_KINDS).toContain("ai_provider_key");
    for (const kind of CREDENTIAL_SECRET_KINDS) expect(SECRET_KINDS).toContain(kind);
  });

  it("the api-contract actor enum is exactly the domain tuple", () => {
    expect([...ActivityActorTypeSchema.options]).toEqual([...ACTIVITY_ACTOR_TYPES]);
  });

  it("activity_actor_type in the DB holds exactly the domain actor types", () => {
    const db = dbEnumValues("activity_actor_type");
    expect(db.size).toBeGreaterThan(0);
    expect(missingFrom(ACTIVITY_ACTOR_TYPES, db)).toEqual(expectedMissing("activity_actor_type"));
    const domain: ReadonlySet<string> = new Set(ACTIVITY_ACTOR_TYPES);
    expect([...db].filter((value) => !domain.has(value))).toEqual([]);
  });

  it("credential_type in the DB holds every secret kind stored as a credential", () => {
    const db = dbEnumValues("credential_type");
    expect(db.size).toBeGreaterThan(0);
    expect(missingFrom(CREDENTIAL_SECRET_KINDS, db)).toEqual(expectedMissing("credential_type"));
  });

  it("the check fails when a domain value is missing from the DB enum or the api-contract", () => {
    const db = dbEnumValues("activity_actor_type");
    expect(missingFrom([...ACTIVITY_ACTOR_TYPES, "robot"], db)).toContain("robot");
    const staleApi = z.enum(["user", "system"]);
    expect(missingFrom(ACTIVITY_ACTOR_TYPES, new Set(staleApi.options))).toEqual(["ai"]);
    expect(missingFrom(CREDENTIAL_SECRET_KINDS, new Set(["ssh_password"]))).toContain("ssh_private_key");
  });
});
