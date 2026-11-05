# AI eval cassettes

Recorded provider turns that `pnpm test:ai-evals` replays through the real agent loop, tools,
redaction and scorer. A missing or mismatched turn is a failure, never a skip.

- Layout: `<provider>/scenarios/<scenario-id>.json`, plus `<provider>/report.json` from the last live run.
- Key: SHA-256 of the canonicalized, redacted request (sorted keys; model id, system prompt,
  messages, tools, output cap). Headers, API key, timestamps and request ids are not part of it.
  An entry recorded with a model other than the pinned one never answers.
- Only a live run writes these files and `../baseline.json`. Hand-written cassettes are forbidden.

```bash
NOODARA_AI_EVAL_LIVE=1 ANTHROPIC_API_KEY=... pnpm test:ai-evals          # anthropic (default)
NOODARA_AI_EVAL_LIVE=1 NOODARA_AI_EVAL_PROVIDER=openai OPENAI_API_KEY=... pnpm test:ai-evals
```

A live run asks for temperature 0; when the pinned model only samples at its default it records
`"temperature": null` instead. Writing refuses any file holding the key, a canary or an auth header.
