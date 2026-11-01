# UX Review — DeploymentSteps, configure row (23-04 A4)

Fecha: 2026-11-01 · Commit: eeef4a6d · Modo: solo código (stack no levantado; sin screenshots)
Veredicto global: PASS (tras corregir el único FLAG)

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| Tokens | PASS | Solo clases del preset (`text-ink-secondary`, `text-caption`); sin hex ni acento nuevo |
| Superficie y elevación | PASS | Reutiliza `StepRow`; sin sombras ni superficies nuevas |
| Tipografía y jerarquía | FLAG → corregido | `DeploymentSteps.tsx:165` usaba `text-callout` (13px); el resto de detalles de paso usan `text-caption` (`DiscoveryStep.tsx:217`). Ahora `text-caption` |
| Layout y espaciado | PASS | `pl-6` alinea con el texto del label, igual que los detalles de `DiscoveryStep` |
| Componentes | PASS | `StepRow` compartido, children para el detalle; dot + palabra de estado heredados |
| Estados | PASS | Skipped se oculta (timeline v0.3 intacta sin env); failed muestra copy clasificada de `SECRET_UNRESOLVED` / `ENV_INJECTION_FAILED` (`deploy-error-copy.ts:133-140`), sin counts |
| Progressive disclosure | PASS | Solo conteos en la fila; las claves y referencias quedan en el panel de variables |
| Copy | PASS | "Configure", "3 variables, 1 secret": sentence case, plural correcto |
| Accesibilidad y temas | PASS | Estado por palabra + dot, tokens con variante light/dark; ningún nombre de clave, referencia ni valor de secret en la fila (test `DeploymentSteps.test.tsx:109`) |

## Bloqueantes
- Ninguno.

## Correcciones sugeridas
1. (Aplicada) Detalle de configure en `text-caption`, como los demás detalles de paso.
2. (Opcional) Con 0 variables o 0 secrets se lee "0 variables, 1 secret"; omitir la parte en cero sería más limpio. No es regla del sistema.
3. Verificar con screenshots dark/light a 1440 y 900 px cuando se levante el stack.

## Lo que está bien
- El paso no aparece si no hay variables, así que los servicios sin env no cambian.
- Los conteos nunca filtran nombres ni referencias.
