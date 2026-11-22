# Fixture SSH — reparar cancelación y conservar diagnóstico inconcluso

Replan solicitado2026-11-10 (America/Managua). Sólo planificación en este paso;
trabajo y evidencia anteriores conservados. Hardening independiente actualizado:
0 adiciones, sin criterios faltantes. Pendiente ejecución.

## Objetivo

Reparar primero el problema de cancelación/creación tardía demostrado por un
reproducer controlado. Después cerrar el registro de diagnóstico dejando la causa
histórica de los timeouts explícitamente INCONCLUSA. Retomar35-02 sólo con CI
completo y sitio verdes en la fuente documental final. Mantener v0.5.2, RC,
artefactos, datos/BYOK, trabajos terminados y WIP sin reinterpretarlos.

## Contexto comprobado

-35-01 completado (`1baf2318`): stablev0.5.2 sobre RC aprobado3a34f0da,
 Release/Lima/artefactos y gates acreditados. No se reabre.
-Docs públicos b8b1c042; sitio42743059908 PASS. CI42743060357 intento1
 terminó9success/3failure: E2E284pass/2timeouts, instalador22.04 build300000ms
 y rebuild diagnóstico300000ms, integración22.04 beforeAll900000ms.
 Los tres fallos se conservan; no se ha probado una causa compartida.
-Diagnóstico revisado/publicado sólo en task/35-03-ssh-diagnostics, commit
 dabdd438463b876cce4702f524fbdac21aa90e30, padre público b8b1c042. Run42884716047
 intento1 SUCCESS2jobs. Legacyfixture LinuxAMD64:24.04 build cold/warm30.197/.159s;
 22.04=21.521/.094s. Cleanup4owners verificado; no timeout/cancelación en ese run.
-[Runner observations](../docs/testing/ssh-fixture-timeouts/runner-observations.json)
 y handoff `.agent-flow/handoffs/35-03/CONTINUE-RUNNER.md` conservan identidades
 y límites. El manifiesto base observado por separado no es la plataforma/ID
 exactos resueltos históricamente; no se inventarán esos datos.
-El helper actual no recibe señal de cancelación; el test lifecycle controlado
 retiene build, observa un deadline externo y demuestra creación posterior de
 contenedor. Ese test pasa al observar el defecto: no acredita una reparación.
-Hay instrumentación, supervisor/tests y evidencia WIP; no están avanzados35-03
 ni35-04. Cuatro gates previos al push pasaron, no sustituyen gates finales.

## Conocido, inconcluso y pendiente

1. **DEMOSTRADO:** defecto actual de cancelación/creación tardía bajo control.
2. **INCONCLUSO:** operación y causa del atasco histórico. Logs retenidos no
   discriminan build/start/readiness; un nuevo éxito no reconstruye ese pasado.
   No se afirma haber agotado toda posible evidencia externa.
3. **PENDIENTE:** reparación de cancelación con contrato positivo RED/GREEN,
   wiring real de callers y cleanup, además de CI completo para35-02.

No se requiere demostrar una causa histórica no registrada para iniciar o
aceptar la reparación controlada. Cerrar el diagnóstico significa archivar su
conclusión honesta y auditable; no convertir el CI fallido en PASS.

## Secuencia corregida

1. **35-04, wave2, depende35-01:** reparar cancelación reproducida. Conservar
   diagnóstico existente; escribir RED del contrato deseado antes del fix.
   Propagar señal/deadline al lifecycle real de Playwright, no sólo añadir una
   opción nunca usada. Cubrir antes/durante build/create/start/puertos/SSH,
   éxito tardío y limpieza. Compatibilidad22.04/24.04 y nueve gates originales.
2. **35-03, wave3, depende35-01/35-04:** auditar evidencia de reparación,
   reconciliar diagnósticos seguros y clasificar la causa histórica INCONCLUSA.
   Preservar conteos/intentos y limitaciones de imagen/plataforma y hooks
   solapados Docker.start/puertos. No repetir runs sin una pregunta nueva.
3. **35-02, wave4, depende35-01/35-04/35-03:** evidencia documental final,
   revisión tier1, CI COMPLETO y Publish site sobre su SHA exacto. Instalador e
   integración siguen obligatorios; defectos ajenos requieren plan propio.

QA-24 cubre la reparación reproducible; QA-23 el registro diagnóstico honesto.
Ambos quedan pendientes hasta gates/avance reales. REL-05 sigue abierto. Todos
los tasks previos completados, scopes y gates actuales quedan preservados.

## Seguridad, compatibilidad y riesgos

-Ownership antes de await, cancelación hasta callers reales; no Promise.race
 abandonada. Cleanup de todo recurso tardío propio y errores primarios intactos.
 Si Docker/inventario/remoción falla, resultado cleanup NO VERIFICADO, nunca
 una afirmación falsa de cero recursos ni de cancelación resuelta.
-Hardening conservado: diagnóstico no interfiere ante sink cerrado/throw/backpressure;
 lifecycles concurrentes no borran recursos ajenos aunque compartan noodara.test;
 inventario/remoción fallidos no permiten cero-fugas. Hardening independiente revisado sin adiciones.
-No subir presupuestos test/job, relajar assertions/readiness, skips, retries0,
 sleeps o blanket retries. No prebuild/performance fix sin causalidad nueva.
-Diagnósticos allowlist/acotados; nunca inspect/env crudos, errores originales,
 keys/passwords/passphrases/cookies/tokens. CSPRNG para credenciales/ownership.
-Cold/warm aislado; no borrar cachés compartidas ni usar Docker prune. Sentinel
 ajeno/listeners conservados; cleanup exclusivamente de recursos propios.
-Publicación sólo de fuente revisada sobre base pública y diff allowlist,
 nunca ascendencia local490 ni WIP ajeno. No reemplazar CI normal por el workflow
 limitado de diagnóstico. Mantener todos los jobs y scans/permisos previos.
-Tags/índices/platform digests estables inmutables, Latest en0.5.2/3a34f0da,
 publishers competidores ausentes. Sin nuevas llamadas a providers ni Lima.
-No cambios de datos/migraciones/API/UX/runtime o producto instalador. Sus
 fallos22.04 independientes permanecen bloqueos finales, no se subsumen en SSH.

## Verificación durante implementación

Comprobar puertos libres33992/33993/33994 y conservar procesos ajenos. Usar
DOCKER_HOST=unix:///Users/xch4rt/.docker/run/docker.sock,
NOODARA_TEST_PORT_OVERRIDE=33992, NOODARA_E2E_WEB_PORT=33993,
NOODARA_E2E_API_PORT=33994. No ejecutar estos gates durante planificación.

```sh
agent-flow context "35-04 reproduced cancellation repair"
agent-flow gate --task 35-04 --strict
agent-flow gate --task 35-03 --strict
agent-flow gate --task 35-02 --strict
```

35-04 conserva test/typecheck/lint/boundaries/it-ssh-fixture/it-ssh-contracts/
e2e-ssh-regression/e2e-full/security-leaks.35-03 conserva sus cuatro gates.
Registrar conteos/skips/sha/attempt reales; escanear contenido completo saliente
con gitleaks sin exención por path ni cobertura0bytes. El CI completo verde
se exige para35-02, además de los gates de reparación pertinentes de35-04;
un fallo ajeno nunca se elimina ni se rotula como éxito global.

## Exenciones y memoria

Sin exenciones nuevas. Se conservan password-hashing (no almacenamiento de
cuentas en estas tareas) e input-validation/body-cap (sin nuevos handlers HTTP
de producto). Siguen vigentes redacción, topes y ownership de infraestructura.

Agregar decisión y evento append-only del replan. Al ejecutar, registrar causa
CONTROLADA y reparación probadas sin afirmar causa HISTÓRICA; no sobrescribir
memoria previa. Actualizar estados sólo con avance real. Deuda fase15/OPS-05
permanece fuera de alcance.

## Próximos comandos

1. `/flow-orchestrate`
