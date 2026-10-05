// Service create/edit inputs (SVC-05, D10, D13). The source reuses `validateServiceSource`; there
// is no build-arg or env field anywhere, and any extra key is rejected by name. The server is
// fixed at creation: moving a service is a delete plus a create.

import type { Brand } from '../validators/branded.js';
import {
  type ContainerPort,
  type ResourceId,
  validateResourceId,
} from '../validators/docker-naming.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import { type ServiceSource, validateServiceSource } from '../validators/service-source.js';
import { ENTITY_SLUG_PATTERN, type InputRecord, hasKey, parseInputRecord } from './input.js';

export type ServiceName = Brand<string, 'ServiceName'>;
/** Host port the container is published on; `null` means not published (the D10 default). */
export type PublishedPort = Brand<number, 'PublishedPort'>;

/** Host ports a service may never take: SSH (Noodara's control channel) and the Docker daemon. */
export const RESERVED_PUBLISHED_PORTS: readonly number[] = [22, 2375, 2376];

export interface ServiceCreateInput {
  readonly name: ServiceName;
  readonly serverId: ResourceId;
  readonly source: ServiceSource;
  readonly internalPort: ContainerPort;
  readonly publishedPort: PublishedPort | null;
}

export interface ServiceEditInput {
  readonly name?: ServiceName;
  readonly source?: ServiceSource;
  readonly internalPort?: ContainerPort;
  /** Present and `null` stops publishing; absent leaves it unchanged. */
  readonly publishedPort?: PublishedPort | null;
}

export type ServiceEditableFields = Omit<ServiceCreateInput, 'serverId'>;
export type ServiceEditField = keyof ServiceEditableFields;

/**
 * `redeploy`: the source or a port changed, which only takes effect in a new container.
 * `metadata`: only the name changed. `none`: the edit matches the current values.
 */
export interface ServiceEditClassification {
  readonly kind: 'none' | 'metadata' | 'redeploy';
  readonly changedFields: readonly ServiceEditField[];
}

const EDIT_FIELDS: readonly ServiceEditField[] = [
  'name',
  'source',
  'internalPort',
  'publishedPort',
];
const CREATE_FIELDS: readonly string[] = ['serverId', ...EDIT_FIELDS];
const MAX_PORT = 65535;

function isPortNumber(input: unknown): input is number {
  return typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= MAX_PORT;
}

export function validateServiceName(input: unknown): ValidationResult<ServiceName> {
  if (typeof input !== 'string' || !ENTITY_SLUG_PATTERN.test(input)) {
    return fail(
      'SERVICE_NAME_INVALID',
      'Service name must be a lowercase slug matching [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?',
    );
  }
  return ok(input as ServiceName);
}

/** The port the app listens on inside the container. */
export function validateInternalPort(input: unknown): ValidationResult<ContainerPort> {
  if (!isPortNumber(input)) {
    return fail('INTERNAL_PORT_INVALID', 'Internal port must be an integer from 1 to 65535');
  }
  return ok(input as ContainerPort);
}

export function validatePublishedPort(input: unknown): ValidationResult<PublishedPort | null> {
  if (input === undefined || input === null) return ok(null);
  if (!isPortNumber(input)) {
    return fail('PUBLISHED_PORT_INVALID', 'Published port must be an integer from 1 to 65535');
  }
  if (RESERVED_PUBLISHED_PORTS.includes(input)) {
    return fail(
      'PUBLISHED_PORT_RESERVED',
      `Published port ${input.toString()} is reserved for SSH or the Docker daemon`,
    );
  }
  return ok(input as PublishedPort);
}

function validateServiceId(input: unknown): ValidationResult<ResourceId> {
  return validateResourceId(typeof input === 'string' ? input : '');
}

/** Validates the fields of `record` that are present; returns the first failure. */
function validateEditFields(record: InputRecord): ValidationResult<ServiceEditInput> {
  let edit: ServiceEditInput = {};
  if (hasKey(record, 'name')) {
    const name = validateServiceName(record.name);
    if (!name.ok) return name;
    edit = { ...edit, name: name.value };
  }
  if (hasKey(record, 'source')) {
    const source = validateServiceSource(record.source);
    if (!source.ok) return source;
    edit = { ...edit, source: source.value };
  }
  if (hasKey(record, 'internalPort')) {
    const internalPort = validateInternalPort(record.internalPort);
    if (!internalPort.ok) return internalPort;
    edit = { ...edit, internalPort: internalPort.value };
  }
  if (hasKey(record, 'publishedPort')) {
    const publishedPort = validatePublishedPort(record.publishedPort);
    if (!publishedPort.ok) return publishedPort;
    edit = { ...edit, publishedPort: publishedPort.value };
  }
  return ok(edit);
}

export function validateServiceCreateInput(input: unknown): ValidationResult<ServiceCreateInput> {
  const parsed = parseInputRecord(input, CREATE_FIELDS, 'SERVICE_INPUT', 'Service');
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const name = validateServiceName(record.name);
  if (!name.ok) return name;
  const serverId = validateServiceId(record.serverId);
  if (!serverId.ok) return serverId;
  const source = validateServiceSource(record.source);
  if (!source.ok) return source;
  const internalPort = validateInternalPort(record.internalPort);
  if (!internalPort.ok) return internalPort;
  const publishedPort = validatePublishedPort(record.publishedPort);
  if (!publishedPort.ok) return publishedPort;
  return ok({
    name: name.value,
    serverId: serverId.value,
    source: source.value,
    internalPort: internalPort.value,
    publishedPort: publishedPort.value,
  });
}

export function validateServiceEditInput(input: unknown): ValidationResult<ServiceEditInput> {
  const parsed = parseInputRecord(input, EDIT_FIELDS, 'SERVICE_INPUT', 'Service');
  if (!parsed.ok) return parsed;
  if (Object.keys(parsed.value).length === 0) {
    return fail('SERVICE_INPUT_EMPTY_EDIT', 'Service edit must change at least one field');
  }
  return validateEditFields(parsed.value);
}

function sameSource(a: ServiceSource, b: ServiceSource): boolean {
  if (a.kind === 'image') return b.kind === 'image' && a.imageRef === b.imageRef;
  if (b.kind === 'image') return false;
  return (
    a.repositoryUrl === b.repositoryUrl &&
    a.branch === b.branch &&
    a.buildContext === b.buildContext &&
    a.dockerfilePath === b.dockerfilePath &&
    a.target === b.target
  );
}

/** Pure: compares a validated edit with the current values; never applies it. */
export function classifyServiceEdit(
  current: ServiceEditableFields,
  edit: ServiceEditInput,
): ServiceEditClassification {
  const changed: Record<ServiceEditField, boolean> = {
    name: edit.name !== undefined && edit.name !== current.name,
    source: edit.source !== undefined && !sameSource(current.source, edit.source),
    internalPort: edit.internalPort !== undefined && edit.internalPort !== current.internalPort,
    publishedPort: edit.publishedPort !== undefined && edit.publishedPort !== current.publishedPort,
  };
  const changedFields = EDIT_FIELDS.filter((field) => changed[field]);
  if (changedFields.length === 0) return { kind: 'none', changedFields };
  const kind = changedFields.every((field) => field === 'name') ? 'metadata' : 'redeploy';
  return { kind, changedFields };
}
