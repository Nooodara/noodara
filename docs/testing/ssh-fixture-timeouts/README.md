# 35-03 — diagnóstico SSH en curso

Estado: **INCOMPLETO**. Hay comparación fría/caliente aislada y pruebas Docker
parciales; la causa histórica SSH y cleanup de cancelación siguen sin demostrar.
No avanzar35-03/35-04/35-02 ni aplicar reparación especulativa.

## Alcance de este branch diagnóstico

Este branch contiene sólo el runner diagnóstico y sus12 archivos permitidos; **no es
un archivo autocontenido de la investigación ni evidencia completa de aceptación35-03**.
Las referencias históricas `ci-jobs.json`, `ci-summary.json`, `diagnostics-results.json`
y `local-measurements.json` que se citan abajo pertenecen al workspace local revisado
por separado y **no están incluidas ni disponibles como archivos de este branch**.
Los logs RED/GREEN citados por `supervisor-results.json` son registros locales ignorados,
también ausentes del branch; ese JSON registra sus hashes/resultados, no incorpora los logs.
Las cifras históricas siguientes se conservan como contexto de la investigación, no
como evidencia autosuficiente ni resultados de este futuro run público.

## CI original conservado

Fuente documental `b8b1c0422cfce18ecabcc2f4f572a3dcc37c8266`, CI42743060357
intento1. El snapshot final consultado mediante el conector GitHub registra
**9 jobs success, 3 failure, 0 skipped**,12 total. Todos están completed.
Referencias históricas locales ausentes: `ci-jobs.json` (jobs y pasos) y
`ci-summary.json` (conteos y artefactos).
La prueba histórica50 permanece intacta; no se reinterpreta su snapshot anterior.

- E2E129588583228:284 passed,2 failed,0 skipped. Los dos timeouts anteriores
  siguen siendo fallos; artifact13730449440 tiene el mismo SHA256 que proof50.
- Installer129588583325:1 archivo fallido/9 aprobados;48 tests passed/8 skipped.
  Falló setup de `idempotent-rerun.test.ts`: build de fixture DinD Ubuntu22.04
  excedió300000ms; su rebuild diagnóstico también excedió300000ms. Los8 tests
  del archivo no llegaron a validar el producto. Esto acredita el deadline de
  build, **no** su mecanismo causal ni relación con SSH24.04. No se copia output
  crudo del build. Una reparación de `helpers/installer-dind.ts`, sus imágenes
  o el escenario requiere otra tarea/ampliación de scope. Bloquea35-02.
- Integration129588583307:1 archivo fallido/107 aprobados/3 skipped;
  1304 tests passed/13 skipped. `activity/canary-deploy.test.ts:356`, beforeAll
  Ubuntu22.04, excedió900000ms. El hook inicia varias operaciones y sólo este
  timeout no identifica cuál quedó pendiente. No se atribuye a SSH24.04.
  Los3 archivos omitidos por opt-in NOODARA_STRESS son collector-soak,
  ai-concurrency y ssh/stress-connections; además los tests dependientes del
  setup fallido no validaron el producto. Hace falta triage separado antes de
  proponer reparaciones fuera del scope35-03. No hay waiver de CI.

El job installer y el job integration reportaron sus guards de recursos propios
verdes; eso no establece causa, ni ausencia de operaciones de build en vuelo.
Los otros conteos reales y las identidades de los dos artefactos publicados se
conservan en ci-summary.json; jobs estáticos no se presentan como tests.
No se ejecutó rerun público, publicación, tag, provider, VM ni cambio de runtime.

## Primera instrumentación observable

El helper tiene ownership UUID antes del build, stage events por allowlist,
reloj monotónico y tope64 eventos. Nunca serializa excepciones ni sus causas.
El sink no mantiene cola; false, Promise, rechazo o excepción desactivan emisión.
El build conserva sus args y el cache existente, con tag exclusivamente aleatorio
para poder identificar el recurso propio. La imagen sigue su cleanup Testcontainers
predeterminado. Credenciales siguen usando randomUUID. Sin cambios de budgets/retries.

Hooks Testcontainers distinguen build, creación, publicación de puerto y readiness
por el log SSH original. **Limitación:** su hook containerStarting ocurre después
Docker.start y del inspector de puertos: los intervalos container_start y
published_port se solapan. Esto no prueba separación temporal entre ambos ni
identifica por sí solo el stall de CI. El diagnóstico próximo debe observar Docker
start frente a port readiness sin interceptar globalmente clientes compartidos.

Referencia histórica local ausente: `diagnostics-results.json` (resultados enfocados).16 tests aprobados/0 skipped;
RED de milestones2 fallos y RED de runtime allowlist1 fallo vistos antes de sus
implementaciones. El primer intento del collector con pnpm quedó bloqueado por
verificación/descarga del package manager; el RED sin export se obtuvo después
restaurando temporalmente el baseline, por lo que no se declara RED-first estricto
para ese primer fragmento. La ejecución real usó el Vitest ya instalado con Node.
Typecheck SSH enfocado pasó. Gates autoritativos completos siguen pendientes.

## Comparación local aislada y lifecycle real

Referencia histórica local ausente: `local-measurements.json` (mediciones completas): Docker29.8.1 Linux ARM64,
namespace BuildKit propio586ed50e-747b-45b2-a431-900b4c65d9d6, nuevo sin import de
cache, Dockerfiles sin cambios y argumentosfalse originales. Ubuntu24.04 build
cold15.653s/warm2.068s; Ubuntu22.04 cold18.627s/warm2.383s. Cada imagen se inició,
publicó puerto y alcanzó el marker SSH original antes de cualquier navegador;
create/start/port se midieron como comandos Docker separados. Ambos presupuestos
60/180s quedaron por encima del build local. Las identidades observadas de source,
manifest base y resultado, comandos exactos, tiempos y cleanup están en el JSON.
Todos los containers, imágenes y builder propios se eliminaron; no prune global.
La primera medición24.04,19.795s, terminó tras build por error de desempaquetado
del harness; se eliminó ese namespace y se repitió con otro nuevo. No se acredita
lifecycle a ese primer intento ni se lo presenta como RED conductual.

**Límite:** este build usa BuildKit y plataformaARM64; el helper real usa API
legacy y el runner histórico UbuntuAMD64. No se atribuye causa a una comparación
exitosa. La medición no explica el timeout histórico y requiere evidencia runner
real aislada, revisada antes de publicar. Los manifests base se observaron antes
del build; el Dockerfile conserva tags originales, no pin de digest nuevo.

El test real `tests/integration/ssh/fixture-lifecycle.test.ts` verificó2passed,
0failed,0skipped en38.12s con configuración enfocada registrada en
`diagnostics-results.json` (referencia histórica local ausente). Una prueba conserva un
listenerTCP ajeno mientras un sink lanza, el fixture inicia y stop repetido elimina
su container. La otra retiene el resultado de un build Docker real, simula deadline
externo, libera el build y demuestra que el helper puede crear un container después
del deadline; el reproducer siempre espera y elimina su operación tardía.
**Eso demuestra un gap de cancelación controlado; NO satisfaceA5 ni prueba que el
CI original estuviera detenido en ese build.** El primer run1passed/1failed sólo
comparó IDs Docker truncados contra completos; corregir `--no-trunc` es harness,
no un RED de lifecycle corregido por una reparación del helper.

El cleanup de startup fallido ahora emite begin/success/failure por allowlist sin
suprimir la excepción primaria ni loggear causas. RED observado1failed/5passed;
GREEN enfocado16passed. Tres casos unit prueban startup/stop con sink throwing,
backpressured y Promise pendiente. El cleanup rechazado no se interpreta como
recurso ausente. Deadline/late-success/rechazo aún requieren ownership y cancelación
real del driver; estos tests no constituyen esa implementación.

Se preparó un candidato diagnóstico congelado en handoff ignorado para revisión
independiente; ninguna publicación ni rerun se ejecutó en esta continuación.

## Trabajo pendiente obligatorio

- Pruebas RED-first de cancelación/deadline, rechazo parcial, éxito tardío y
  cleanup fallido, ownership antes de await y sentinel ajeno intacto; prueba Docker.
- Evidencia real del runnerAMD64 mediante candidato aislado revisado: la comparación
  BuildKitARM64 ya registrada no reemplaza la ejecución legacy del helper ni prueba CI.
- Causa demostrada mediante etapas reales y reproducer controlado. Si local difiere,
  preparar diagnóstico aislado revisado para runner; nunca rerun automático.
- Aplicar pruebas de seguridad al lifecycle completo además del emisor; medir efecto
  de sink lento/fallido sin alterar limpieza. Escaneo completo saliente con config
  gitleaks intacta y cobertura real, gates root, revisión y avance sólo con verdad.

## R1 supervisor behavioral validation (publication still pending)

`supervisor-results.json` records actual RED/GREEN runs and limits. Run the two Node test files
with the exact command recorded there; the general `pnpm test` TypeScript glob does not collect
these `.mjs` files. The isolated diagnostic workflow explicitly runs them before the fixture.
The tests execute the real supervisor source with controlled platform boundaries plus two real
Node subprocess/pipe runs. They do not invoke Docker or establish A5 cancellation compliance.
The revised candidate needs fresh independent approval before any diagnostic branch push.
