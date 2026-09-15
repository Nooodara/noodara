// TOFU host verifier factory (SEC-03, SERV-07, D-07, T-2-21). No bypass path exists — no
// `insecure`, no `allowMismatch`, no `strict: false`, no environment check — guarding directly
// against 02-RESEARCH.md's Pitfall 1: a `hostVerifier` that returns `true`, or is simply absent,
// while everything else appears to work. `HostVerifierInput`'s only field is `trusted`; there is
// no other constructor option this module could ever grow a silent downgrade into.
import { computeFingerprint, fingerprintsEqual } from './fingerprint.js';
import type { HostFingerprint } from './ssh-port.js';

/** The only configuration this factory accepts. `null` means "no fingerprint trusted yet" (D-07's
 *  first-connection capture case) — there is no other member. */
export interface HostVerifierInput {
  readonly trusted: HostFingerprint | null;
}

export interface HostVerifier {
  /** Synchronous `ssh2` `hostVerifier` callback shape (`SyncHostVerifier`): one parameter, the
   *  raw host key `Buffer`. Never throws — see `verify`'s own doc comment below. */
  verify(rawHostKey: Buffer): boolean;
  /** The most recently observed fingerprint, or `null` if `verify` has never been called (or its
   *  most recent call could not compute one at all). */
  observed(): HostFingerprint | null;
  /** True once a first-connection capture (`trusted === null`) has occurred. */
  captured(): boolean;
  /**
   * True when the most recent `verify()` call could not parse the host key blob at all (IN-01) —
   * distinct from a blob that parsed cleanly but simply didn't match the trusted fingerprint.
   * Reset at the start of every `verify()` call, so only the latest call's outcome is reported.
   */
  parseFailed(): boolean;
}

/**
 * Builds a `ssh2` host verifier around a single trust decision (D-07): with no pinned fingerprint,
 * the first key observed is accepted and marked captured, for the caller (phase 3) to persist.
 * With a pinned fingerprint, only an exact type+digest match (D-05) is accepted — every other key,
 * including a same-digest/different-type or same-type/different-digest pair, is rejected.
 */
export function createHostVerifier(input: HostVerifierInput): HostVerifier {
  const { trusted } = input;
  let lastObserved: HostFingerprint | null = null;
  let didCapture = false;
  let lastParseFailed = false;

  /**
   * Returns `false` (never throws) for anything short of an accepted match — including a host key
   * blob `computeFingerprint` itself cannot process. `ssh2` turns a `false` return into a
   * `handshake`-level `'error'` event (ADR 0004 row 7, `"Host denied (verification failed)"`)
   * that plan 02-07's classifier maps to `HOST_KEY_CHANGED`; throwing from inside this callback
   * would escape `ssh2`'s own error channel entirely and violate SERV-07's "connect never throws".
   * IN-01: `lastParseFailed` records the unparseable case separately, so a caller (the adapter)
   * can tell it apart from a blob that parsed but simply didn't match.
   */
  function verify(rawHostKey: Buffer): boolean {
    let candidate: HostFingerprint;
    try {
      candidate = computeFingerprint(rawHostKey);
    } catch {
      lastObserved = null;
      lastParseFailed = true;
      return false;
    }
    lastParseFailed = false;
    lastObserved = candidate;

    if (trusted === null) {
      didCapture = true;
      return true;
    }

    return fingerprintsEqual(trusted, candidate);
  }

  return {
    verify,
    observed: () => lastObserved,
    captured: () => didCapture,
    parseFailed: () => lastParseFailed,
  };
}
