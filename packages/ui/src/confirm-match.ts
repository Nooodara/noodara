// isConfirmationMatch is the client-side pre-check that gates a destructive confirm button
// (delete server, trust new fingerprint) until the operator has typed the exact resource name.
// It is a UX convenience only -- the API's own CONFIRMATION_MISMATCH error remains the enforced
// source of truth on every request; this function never substitutes for that server-side check.
// Exact equality, no trimming and no case-folding, so a misclick past a near-match (leading
// space, wrong case) never slips through client-side and lands on the same server check anyway.
export function isConfirmationMatch(required: string, typed: string): boolean {
  if (typed.length === 0) {
    return false;
  }

  return typed === required;
}
