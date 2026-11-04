import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import {
  AI_CONVERSATION_TITLE_MAX_LENGTH,
  AI_ENTITY_KINDS,
  AI_MESSAGE_MAX_LENGTH,
  AI_MESSAGE_ROLES,
  AI_MESSAGE_STATUSES,
  AI_PROVIDERS,
  AI_TOOL_CALL_STATUSES,
  AI_TOOL_NAME_PATTERN,
  V05_SERVICE_ERROR_CODES,
  type AiStructuredAnswer,
} from "@noodara/domain/api-contract";
import { users } from "./auth.js";
import { credentials } from "./credentials.js";
import { sqlInList } from "./v04-owner.js";

// v0.5 (26-05, migration 0019). BYOK provider settings and the read-only AI conversations.

declare const redactedBrand: unique symbol;
/** A value that went through a `Redactor`. Minted only by `redactForStorage`
 *  (schema/repositories/ai-message-repository.ts); every AI text column requires it. */
export type Redacted<T> = T & { readonly [redactedBrand]: true };

/** At most 8 mask characters plus the last 4 of the key (AI_KEY_HINT_PATTERN): never a whole key,
 *  which is at least AI_PROVIDER_KEY_MIN_LENGTH long. */
const AI_KEY_HINT_MAX_LENGTH = 12;
const ERROR_CODE_LIST = sqlInList(V05_SERVICE_ERROR_CODES);

// One row per install (the `singleton` unique index). The key itself lives encrypted in
// `credentials` (type ai_provider_key); this row holds only its id. A trigger in 0019 deletes that
// credential when the row is deleted or its credential_id is replaced, in the same transaction.
export const aiProviderSettings = pgTable(
  "ai_provider_settings",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    singleton: boolean("singleton").notNull().default(true),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => credentials.id),
    keyHint: text("key_hint").notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_provider_settings_singleton_idx").on(table.singleton),
    uniqueIndex("ai_provider_settings_credential_id_idx").on(table.credentialId),
    check(
      "ai_provider_settings_shape_check",
      sql.raw(
        `"singleton" AND "provider" IN (${sqlInList(AI_PROVIDERS)}) AND char_length("model") BETWEEN 1 AND 128 AND char_length("key_hint") <= ${String(AI_KEY_HINT_MAX_LENGTH)}`,
      ),
    ),
  ],
);

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").$type<Redacted<string>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_conversations_user_updated_at_idx").on(table.userId, table.updatedAt.desc()),
    check(
      "ai_conversations_title_check",
      sql.raw(`char_length("title") <= ${String(AI_CONVERSATION_TITLE_MAX_LENGTH)}`),
    ),
  ],
);

// `content` and `answer` hold redacted text only: their insert types require the Redacted brand.
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull(),
    content: text("content").$type<Redacted<string>>().notNull(),
    answer: jsonb("answer").$type<Redacted<AiStructuredAnswer>>(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_messages_conversation_created_at_idx").on(table.conversationId, table.createdAt),
    check(
      "ai_messages_shape_check",
      sql.raw(
        `"role" IN (${sqlInList(AI_MESSAGE_ROLES)}) AND "status" IN (${sqlInList(AI_MESSAGE_STATUSES)}) AND char_length("content") <= ${String(AI_MESSAGE_MAX_LENGTH)} AND ("error_code" IS NULL OR "error_code" IN (${ERROR_CODE_LIST})) AND ("answer" IS NULL OR jsonb_typeof("answer") = 'object')`,
      ),
    ),
  ],
);

// What the model consulted: tool name, scope and outcome. Tool inputs and results are not stored.
export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    messageId: uuid("message_id")
      .notNull()
      .references(() => aiMessages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scopeKind: text("scope_kind"),
    scopeId: uuid("scope_id"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_tool_calls_message_created_at_idx").on(table.messageId, table.createdAt),
    check(
      "ai_tool_calls_shape_check",
      sql.raw(
        `"name" ~ '${AI_TOOL_NAME_PATTERN.source}' AND "status" IN (${sqlInList(AI_TOOL_CALL_STATUSES)}) AND ("error_code" IS NULL OR "error_code" IN (${ERROR_CODE_LIST})) AND "duration_ms" >= 0 AND (("scope_kind" IS NULL AND "scope_id" IS NULL) OR ("scope_kind" IN (${sqlInList(AI_ENTITY_KINDS)}) AND "scope_id" IS NOT NULL))`,
      ),
    ),
  ],
);
