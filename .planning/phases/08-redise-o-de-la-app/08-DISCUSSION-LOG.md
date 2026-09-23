# Phase 8: Rediseño de la app - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-23
**Phase:** 8-Rediseño de la app
**Areas discussed:** Cómo se cura lo "plano", Shell preparado (UI-11), Momentos autorados (UI-08), Revisión visual humana (UI-12)

---

## Cómo se cura lo "plano"

### ¿Cómo se agrupa el contenido para que deje de sentirse plano?

| Option | Description | Selected |
|--------|-------------|----------|
| Grupos inset | Bloques surface-1 sobre canvas, radio lg, hairline; filas separadas por hairline dentro (macOS System Settings / iOS grouped list). Escalón de superficie, sin sombra. | ✓ |
| Filas hairline como hoy | Estructura actual; la profundidad viene solo de elevación flotante, materiales del chrome y movimiento. | |
| Contenido sobre surface-1, chrome sobre canvas | El área de contenido entera como lámina surface-1; sidebar/toolbar en canvas (look Linear/Raycast). | |

**User's choice:** Grupos inset (recomendada)

### ¿Qué material lleva el chrome estructural (sidebar y toolbar)?

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar en canvas, contenido en canvas, grupos surface-1 | Sidebar fundido con el canvas, sin border-r; toolbar translúcido con scroll edge effect; un solo backdrop-filter. | ✓ |
| Sidebar como material más pesado (surface-2 frío) | Brief §7.7: materiales pesados separan regiones; tres niveles visibles a la vez. | |
| Sidebar translúcido | Segundo backdrop-filter; consume presupuesto (toolbar + sidebar + Sheet = 3). | |

**User's choice:** Sidebar en canvas + grupos surface-1 (recomendada)

### ¿Hasta dónde llega el rediseño en layout y densidad?

| Option | Description | Selected |
|--------|-------------|----------|
| Solo lo que exigen los grupos inset | max-w 1120, padding 32, filas 44px, stat tiles, tipografía y grid intactos. | ✓ |
| También densidad y jerarquía tipográfica | Revisar altura de fila, stat tiles, escala del título, medida. | |
| Repensar cada pantalla desde cero | Cada pantalla como composición nueva; mayor riesgo E2E y más rondas humanas. | |

**User's choice:** Solo lo que exigen los grupos inset (recomendada)

### ¿Qué pasa con la lista de servidores bajo grupos inset?

| Option | Description | Selected |
|--------|-------------|----------|
| Un solo grupo inset con las filas dentro | Bloque surface-1 con filas de 44px por hairline; fila sigue siendo link nativo; empty state dentro. | ✓ |
| Filas sueltas sobre canvas | Lista como hoy; solo detalle y settings usan grupos. | |
| Cada fila como bloque separado | Cards apiladas; roza §9 #5. | |

**User's choice:** Un solo grupo inset (recomendada)

---

## Shell preparado (UI-11)

### ¿Dónde vive el menú de cuenta y qué contiene hoy?

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar abajo, absorbe tema y sign out | Trigger avatar+nombre al pie; menú flotante con nombre/email, Settings, Appearance (tema inline, mismo write path), Sign out. Reemplaza el cluster actual. | ✓ |
| Sidebar abajo, tema se queda fuera | Menú con Settings y Sign out; ThemeToggle independiente al lado. | |
| Toolbar arriba a la derecha | Avatar en el toolbar de cada pantalla (GitHub/Google); compite con primaryAction y StreamStatus. | |

**User's choice:** Sidebar abajo, absorbe tema y sign out (recomendada)

### ¿Cómo se representa el avatar del admin?

| Option | Description | Selected |
|--------|-------------|----------|
| Iniciales monocromas | Círculo surface-3 con hairline, iniciales en ink, rol label; cero azul. | ✓ |
| Iniciales sobre accent-fill | Círculo azul con iniciales en on-accent; azul permanente en el chrome. | |
| Monograma de Noodara | El logo como avatar; confunde cuenta con producto. | |

**User's choice:** Iniciales monocromas (recomendada)

### ¿Cómo se ve la navegación jerárquica hoy?

| Option | Description | Selected |
|--------|-------------|----------|
| Componente de árbol genérico, items planos hoy | NavTree en packages/ui (hijos opcionales, expand/collapse grid-rows, aria-expanded, rail colapsa a tooltip/flyout); tres hojas hoy; Fase 13 solo pasa datos. | ✓ |
| Lista plana + sección 'Infrastructure' como etiqueta | Encabezado en rol label sobre Servers; riesgo de eyebrow (§9 #8) y placeholder velado (§9 #19). | |
| Dejar la lista plana; el árbol lo hace la Fase 13 | Mínimo trabajo; contradice UI-11 y ARCHITECTURE §8.2. | |

**User's choice:** Componente de árbol genérico (recomendada)

### ¿Cómo se comporta el slot del inspector por breakpoint?

| Option | Description | Selected |
|--------|-------------|----------|
| Columna ≥1280, sheet <1280, invisible vacío | Parallel route @inspector con default.tsx null; columna ~360-400px a ≥1280 que estrecha el contenido; Sheet por debajo; sin scrim. | ✓ |
| Siempre overlay (Sheet) | Nunca columna; los logs taparían la vista que narran. | |
| Columna redimensionable | Drag handle persistido; otro gesto fuera de D19. | |

**User's choice:** Columna ≥1280 / sheet <1280 / invisible vacío (recomendada)

---

## Momentos autorados (UI-08)

### Discovery: ¿cuál es el tratamiento de la narración?

| Option | Description | Selected |
|--------|-------------|----------|
| Timeline con hilo + monograma enfocando | Hilo vertical que se llena en ink; duración en tabular-nums; checks con stagger 40ms; el anillo del Viewfinder va de abierto a nítido al completar (idea diferida de Fase 7). | ✓ |
| Timeline con hilo, sin animar la marca | Mismo hilo y stagger; monograma estático. | |
| Solo stagger y duraciones sobre la estructura actual | Cumple UI-07, difícilmente UI-08. | |

**User's choice:** Timeline con hilo + monograma enfocando (recomendada)

### TOFU: ¿cómo se trata el bloque de fingerprint y confianza?

| Option | Description | Selected |
|--------|-------------|----------|
| Fingerprint como bloque tipográfico + diff old/new | Componente Fingerprint: SHA256 mono grande en bloques de 4, prefijo atenuado, copiable; mismo componente en aviso, fila Connection y diálogo HOST_KEY_CHANGED con old/new alineados y bloques distintos en ink fuerte. | ✓ |
| Bloque tipográfico + randomart ASCII de OpenSSH | Añade el randomart de ssh-keygen -lv; roza §9 #7. | |
| Mantener Notice/Banner, solo pulir | Sin componente propio; no pasaría el test de intercambio de marca. | |

**User's choice:** Bloque tipográfico + diff old/new (recomendada)

### ¿Qué momento autorado llevan las demás pantallas?

| Option | Description | Selected |
|--------|-------------|----------|
| Uno discreto y propio por pantalla | Login/setup: monograma enfocando una vez; servers: stagger + StatusPill; activity: filas por evento translateY+opacity sin reset de scroll; settings: Disclosure grid-rows. | ✓ |
| Solo discovery y TOFU | Resto solo press feedback y transiciones de estado. | |
| El monograma enfocando en todas las cargas | Contradice §8.4. | |

**User's choice:** Uno discreto y propio por pantalla (recomendada)

---

## Revisión visual humana (UI-12)

### ¿Se captura un baseline del estado actual antes de tocar nada?

| Option | Description | Selected |
|--------|-------------|----------|
| Sí, baseline primero | Primer plan captura las seis pantallas en ambos temas a 375/900/1280/1920 con datos reales usando el pipeline de 07-04; el usuario las ve antes de cualquier CSS. | ✓ |
| No, solo capturas del resultado | Ahorra una ronda; pierde el antes/después y contradice P0 #4. | |

**User's choice:** Sí, baseline primero (recomendada)

### ¿Con qué cadencia se revisan screenshots?

| Option | Description | Selected |
|--------|-------------|----------|
| Tres gates: baseline, P0+shell, final | G1 baseline; G2 tras P0 + grupos inset + shell; G3 final con P1/P2 y momentos autorados. Cada gate bloquea la wave siguiente. | ✓ |
| Un gate por pantalla rediseñada | Seis gates; más interrupciones, difícil juzgar coherencia. | |
| Baseline + un solo gate final | Riesgo de rehacer P1/P2 si la dirección no convence. | |

**User's choice:** Tres gates (recomendada)

### ¿Cómo se revisa el movimiento?

| Option | Description | Selected |
|--------|-------------|----------|
| App en vivo local + capturas estáticas | En G2/G3 el usuario levanta el stack local y prueba gesto y animaciones a velocidad real y en cámara lenta; capturas para layout/contraste/temas; hardware táctil real si disponible. | ✓ |
| Video WebM grabado por Playwright | No transmite respuesta al gesto ni interrumpibilidad. | |
| Solo capturas estáticas; el movimiento lo validan los tests | Contradice §10. | |

**User's choice:** App en vivo + capturas estáticas (recomendada)

### ¿Dónde y cómo queda registrada la aprobación?

| Option | Description | Selected |
|--------|-------------|----------|
| docs/ui/APPROVAL.md + capturas aprobadas en git | Patrón de docs/brand/APPROVAL.md; docs/ui/approved/ con capturas finales por pantalla × tema a 1280 (resto gitignored en docs/ui/review/); test que pinea el set; sirve a la landing de Fase 10. | ✓ |
| Solo en .planning (08-HUMAN-UAT.md) | Capturas gitignored; Fase 10 tendría que regenerar. | |
| APPROVAL.md sin capturas en git | Imágenes siempre regeneradas por script. | |

**User's choice:** docs/ui/APPROVAL.md + capturas en git (recomendada)

---

## Claude's Discretion

- `RowMenu`: arreglar sobre Radix Dialog no-modal vs migrar a `@radix-ui/react-dropdown-menu` (con ADR-0000 y provenance); comportamiento UI-04 es lo exigido.
- API para suprimir animación en cierre por teclado (P14), codificada en el componente.
- Forma del gate automatizado de sombras (UI-03).
- Técnica para animar el anillo del Viewfinder (CSS/WAAPI, nunca `motion`).
- Recuento de `backdrop-filter` en el peor caso y qué superficie pasa a sólido si excede tres.
- Token exacto del escalón más claro en oscuro para superficies flotantes, según medición de contraste.
- Anchura del inspector (360–400 px), del menú de cuenta, tamaño del avatar.
- Orden interno de planes dentro de las restricciones de los gates; cuándo correr el E2E completo.

## Deferred Ideas

- Inspector con contenido real y nav jerárquica con Projects — Fase 13.
- Perfil editable, preferencias y tema en servidor dentro del menú de cuenta — Fase 9.
- Inspector redimensionable — no en v0.2.
- Randomart ASCII para fingerprint — descartado.
- Confirmación por mantener presionado con clip-path — futura; §9 #18 manda.
- Screenshots reales en la landing — Fase 10 consume `docs/ui/approved/`.
- Reconciliar `width="240"` vs `"220"` del lockup (nota 07-10) — quick task.
