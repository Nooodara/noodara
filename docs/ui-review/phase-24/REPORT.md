# UX Review — Fase 24: dominios, variables y secrets

Fecha: 2026-11-01 · Commit base: 4e65935c · Modo: screenshots + código
Veredicto global: **FLAG** (sin BLOCK)
Aprobación humana (A3): **aprobada** por el orquestador bajo la delegación del usuario (2026-10-29,
`.planning/DECISIONS.md`), registrada como en 19-08 A7 (2026-11-01)

Alcance: panel de dominios (DNS, certificado, redirect, detalles del fallo), variables del servicio con
vista efectiva y referencia `<secret:name>`, variables y secrets del environment y del proyecto, card de
reverse proxy en el detalle del servidor. Capturas en este directorio (375 y 1280 px, dark y light),
generadas con datos reales del deploy host e2e con Pebble (un dominio emitido y otro apuntando a otra IP):

`NOODARA_UI_REVIEW_CAPTURE=1 caffeinate -is pnpm exec playwright test -c docs/ui-review/phase-24/playwright.capture.config.ts`

| Dimensión | Verdicto | Evidencia |
|---|---|---|
| Tokens | PASS | Un solo acento azul (Add domain, Add variable, Add secret, Open); verde/ámbar/rojo solo en pills de DNS, certificado y proxy. Sin gradientes. |
| Superficie y elevación | PASS | Cards por escalón y hairlines entre filas; sin sombras (`domains-panel-1280-dark.png`, `proxy-card-1280-dark.png`). |
| Tipografía y jerarquía | PASS | Hostnames, claves, valores, puertos e IPs en mono; labels de sección en versalitas como el resto del detalle. |
| Layout y espaciado | FLAG | A 375 px el hostname se corta a mitad de palabra en la tabla DNS ("www.r8d52a / b.test", `domains-panel-375-light.png`) y "Redirect HTTP to HTTPS" ocupa tres líneas. Sin desborde horizontal en ninguna captura. |
| Componentes | FLAG | "Use a secret" es un `<select>` nativo sin estilo del design system (`service-variables-375-dark.png`). Con dominios, variables y secrets en la misma página conviven tres botones primarios. |
| Estados | FLAG | El dominio emitido aparece como "Renewing" al recargar con el certificado de Pebble (vida corta) y no como "Issued" (`domains-panel-1280-dark.png`). En el dominio Failed el detalle "Route: The route is live on the server proxy" convive con un certificado fallido sin aclarar que solo hay HTTP. |
| Progressive disclosure | PASS | La fila del dominio muestra hostname y pills; registros DNS solo mientras no resuelve, y causas bajo "Details". Variables y secrets del environment bajo un disclosure. El valor del secret no aparece en ninguna captura. |
| Copy | FLAG | La pista del secret se muestra como "/app" sin marca de enmascarado (`environment-secrets-1280-dark.png`); se lee como parte del nombre. Resto en inglés, sentence case, y los fallos dicen qué hacer ("Point its A/AAAA record at the server IP, then run the DNS check to retry."). |
| Accesibilidad y temas | PASS | Ambos temas con la misma jerarquía; estado por texto + dot en cada pill; toggle con label visible; Copy con icono y nombre accesible. |

## Bloqueantes

Ninguno.

## Correcciones sugeridas (fuera del alcance de 24-05, para el backlog de UI)

1. Tabla DNS a 375 px: `break-all` solo en el valor, o apilar Type/Name/Value.
2. Redirect a 375 px: label corto ("HTTPS redirect") o switch en su propia línea.
3. Selector de secret con el componente Select de `packages/ui`.
4. Un solo botón primario por vista: Add variable / Add secret como secundarios cuando hay otro primario visible.
5. Revisar el umbral de "Renewing" frente a certificados de vida corta (Pebble) o documentar que solo afecta a la CA de pruebas.
6. Detalle del dominio Failed: aclarar que la ruta sirve HTTP sin certificado.
7. Pista del secret con prefijo enmascarado ("••••/app").

## Lo que está bien

- El fallo del certificado nombra la causa (DNS) y el siguiente paso, con el registro A listo para copiar.
- La vista efectiva muestra el scope ganador por variable y la referencia al secret, nunca su valor.
- "Changes apply on the next deploy." y "Secret values are write-only." están donde se edita, no en docs aparte.
- La card de proxy muestra estado, puertos 80/443 y el email ACME sin ruido extra.
