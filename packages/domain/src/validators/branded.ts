// Nominal ("branded") types for validated values (SVC-08). A `RepositoryUrl` is a `string` at
// runtime, but the type checker only produces one through its validator, so a command template
// that accepts `RepositoryUrl` can never receive a raw, unvalidated string.

export type Brand<T, B extends string> = T & { readonly __brand: B };
