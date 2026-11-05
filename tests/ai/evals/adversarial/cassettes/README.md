# Adversarial cassettes

Recorded provider turns for the adversarial set (`../cases.yaml`), replayed in CI by
`pnpm exec vitest run --config vitest.ai-evals.config.ts tests/ai/evals/adversarial`.
A missing or mismatched turn is a failure, never a skip.

- Layout: `<provider>/scenarios/<case-id>.json` plus `<provider>/report.json` (model, date, set version,
  cassette digest, verdicts). Replay requires the report date to match `../../baseline.json`.
- Recorded only by a live run, together with the baseline run. Hand-written cassettes are forbidden.

```bash
NOODARA_AI_EVAL_LIVE=1 ANTHROPIC_API_KEY=... pnpm test:ai-evals   # baseline + adversarial
```
