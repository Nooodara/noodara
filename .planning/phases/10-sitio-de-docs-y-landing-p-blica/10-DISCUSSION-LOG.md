# Phase 10: Sitio de docs y landing pública - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-27
**Phase:** 10-sitio-de-docs-y-landing-pública
**Areas discussed:** Landing: mensaje y secciones, Docs: arquitectura y fuente única, Dominio y publicación, Look del sitio: temas y tipografía

---

## Landing: mensaje y secciones

| Option | Description | Selected |
|--------|-------------|----------|
| Lema + frase + comando + screenshot | README ampliado: wordmark, lema, frase, comando copiable, captura de Servers | ✓ |
| Lema + CTAs sin captura arriba | Texto y dos botones; capturas al hacer scroll | |
| Captura a pantalla completa con el lema encima | La app como protagonista | |
| Pilares entregados con captura real | Solo lo que ya funciona | ✓ |
| Pilares + tira de roadmap 'planned' | Añade sección de futuro etiquetada | |
| Narrativa del roadmap con 'you are here' | Visión completa v0.1→v0.5 | |
| Bloque explícito de límites en la landing | Sección "What it does not do yet" + link a docs | ✓ |
| Solo una línea + link a docs | Detalle en /docs | |
| Sin nombrar a nadie | Frase de posicionamiento propia | ✓ |
| Nombrarlos con respeto | Cita a Coolify/Dokploy | |
| Nada de posicionamiento | Solo descripción | |
| 3 pilares: Connect, Discover, Understand | Tres bloques con captura | ✓ |
| 4 pilares (+ Yours) | Añade self-hosted/open source | |
| How it works: 3 pasos con diagrama SVG propio | Diagrama en tinta | ✓ |
| How it works: solo texto | | |
| Sin How it works | | |
| Footer: Docs, GitHub, licencia, versión del build | | ✓ |
| Footer mínimo | | |
| GitHub: botón secundario sin estrellas | | ✓ |
| GitHub: botón con contador de estrellas | API de terceros | |
| GitHub: solo en el footer | | |

**User's choice:** las marcadas.
**Notes:** pidió una segunda ronda de preguntas para cerrar pilares, "How it works", footer y CTA de GitHub.

---

## Docs: arquitectura y fuente única

| Option | Description | Selected |
|--------|-------------|----------|
| Mover install a apps/site; docs/install.md apunta allí | MDX fuente única; test re-apuntado | ✓ |
| docs/install.md sigue siendo la fuente; el sitio lo importa | Plomería de build | |
| Dos copias con test de igualdad | | |
| Cuatro grupos (Getting started · Concepts · Operate · Reference) | | ✓ |
| Lista plana | | |
| 'Your first server' ahora; 'first deploy' al cerrar la Fase 13 | Sin "coming soon" | ✓ |
| Documentar el deploy planificado marcado como planned | | |
| Posponer guías a la Fase 13 | | |
| Página 'Scope of this release' + notas en contexto | Hechos en presente | ✓ |
| Solo la página de referencia | | |

**User's choice:** las marcadas.

---

## Dominio y publicación

| Option | Description | Selected |
|--------|-------------|----------|
| Aún sin dominio: Pages por defecto, CNAME después | | |
| Ya tengo dominio | **noodara.com** (respuesta libre) | ✓ |
| Mismo repo, Pages vía artifact de Actions | Sin rama gh-pages; basePath calculado | ✓ |
| Repo de la org nooodara.github.io | | |
| Cada push a main publica; PR corre build + tests del sitio | Sin filtro de paths | ✓ |
| Publicar solo si cambian ciertas rutas | | |
| sitemap + robots + 404, sin analytics | | |
| Lo anterior + analytics self-hosted después | Slot documentado, sin código ahora | ✓ |

**User's choice:** las marcadas.
**Notes:** el dominio se comunicó en texto libre: `noodara.com`. Se asume landing en raíz y docs en `/docs`, `www` redirigido por Pages.

---

## Look del sitio: temas y tipografía

| Option | Description | Selected |
|--------|-------------|----------|
| Sigue al SO + toggle en el header | Preferencia en localStorage | ✓ |
| Solo sigue al SO | | |
| Solo oscuro | | |
| Fuente del sistema, como la app | Cero descargas | ✓ |
| Inter self-hosted | | |
| Capturas planas con hairline y radio | Sin marco ni sombra | ✓ |
| Marco de ventana mínimo | | |
| Un solo momento: el monograma enfoca una vez | reduced-motion lo apaga | ✓ |
| Sin animación | | |

**User's choice:** las marcadas.

---

## Claude's Discretion

Mecanismo del test de afirmaciones; forma del boundary test; integración de tokens/componentes de `packages/ui` con Fumadocs; estructura interna de `content/` y redacción en inglés; ancho máximo, tamaño del wordmark y estilo de bloques de código; procedimiento de revisión humana (capturas + URL de Pages); lectura de la versión en build.

## Deferred Ideas

- Página "Your first deploy" (Fase 13).
- Analytics self-hosted.
- Contador de estrellas de GitHub.
- Versionado de docs / i18n.
- Previews de PR del sitio.
