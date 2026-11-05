# AI evals: replay, live y política de baseline

La suite (`tests/ai/evals`) corre el agent loop real, las tools read-only, la redacción y el scorer
sobre fixtures en memoria. Tiene dos partes: 65 escenarios (`scenarios/`) y el set adversarial
(`adversarial/cases.yaml`). Ambas se ejecutan con `pnpm test:ai-evals`.

## Replay vs live

| | Replay (default) | Live (`NOODARA_AI_EVAL_LIVE=1`) |
|---|---|---|
| Provider | Ninguno: cada turno sale de un cassette commiteado | El modelo fijado, con la key del provider |
| Key | No se lee ni se necesita | `ANTHROPIC_API_KEY` (o `OPENAI_API_KEY` con `NOODARA_AI_EVAL_PROVIDER=openai`) |
| Escribe | Nada | Cassettes, `report.json` y `baseline.json` |
| Dónde corre | Cada PR y push a main (`ci.yml`, job `ai-evals`) | Nightly (`nightly.yml`, job `ai-evals-live`) y a mano |
| Falla si | Miss de cassette, crash, umbral del roadmap §10.7, métrica peor que `baseline.json` | Umbral, o métricas por debajo del `baseline.json` commiteado |

Un miss de cassette es un fallo, nunca un skip: si cambia el prompt, las tools o el modelo, hay que
re-grabar.

## CI (`ci.yml`, job `ai-evals`, requerido para merge)

1. `node scripts/ai-baseline-check.mjs guard`: `NOODARA_AI_EVAL_LIVE` sin definir, ninguna key de
   provider en el entorno, directorios de cassettes presentes y commiteados.
2. `pnpm test:ai-evals`: escenarios + adversarial en replay.
3. `node scripts/ai-baseline-check.mjs replay`: 50+ escenarios y ninguna métrica peor que `baseline.json`.
4. `node scripts/ai-baseline-check.mjs update --base <sha>`: política de baseline (abajo).
5. `guard` otra vez: replay no modificó ningún archivo.

El job no referencia ningún secret, así que corre igual en PRs de forks. Solo `nightly.yml` recibe
`ANTHROPIC_API_KEY`, y solo en el step live. Sin el secret, el nightly deja un skip explícito con el
motivo. El token del nightly es read-only y sin credenciales persistidas: un live run nunca hace push
ni abre un PR; el resultado queda como artifact `ai-evals-live`.

## Re-grabar

```bash
NOODARA_AI_EVAL_LIVE=1 ANTHROPIC_API_KEY=... pnpm test:ai-evals
node scripts/ai-baseline-check.mjs update --base origin/main
```

Commitear juntos cassettes (`cassettes/`, `adversarial/cassettes/`) y `baseline.json` en un PR.
Nunca editar cassettes ni el baseline a mano.

## Política de baseline

Un `baseline.json` que empeora una métrica respecto del commit base se rechaza, salvo que el mismo
cambio agregue `tests/ai/evals/baseline-justifications/<cassetteDigest>.md` (el digest del nuevo
baseline) que nombre cada métrica empeorada y explique por qué (20+ palabras).

- Mayor es mejor: `scenarios`, `entitySelection`, `evidenceGrounding`, `diagnosisAccuracy`.
- Menor es mejor: `hallucinatedResources`, `secretLeakage`, `unauthorizedWrites`.
- Quitar una métrica cuenta como empeorarla. Volver a `{"source":"none"}` se rechaza siempre.
- Una métrica nueva necesita su dirección en `METRIC_DIRECTIONS` del script.
- Los umbrales del roadmap no se negocian con una justificación: el replay los sigue exigiendo.
