# 14-34 — causa raíz: la flecha atrás ignora Enter tras cerrar la sheet de edición

Log: `nightly-38565964460-project-toolbar-back.log`. `projects-dod.spec.ts:1274` (A2, 375 px), iteración
3 de 20: tras Escape en `project-edit-sheet`, `back.focus()` + Enter dejó la URL en `/projects/<id>` 15 s.

## Causa

Restauración de foco tardía del `RowMenu` (`⋯`), no de la Sheet ni del layout del Toolbar.

- Radix `FocusScope` devuelve el foco desde un `setTimeout(0)` que corre después de desmontar el contenido.
  El `RowMenu` (Dialog no modal) enfoca su trigger ahí, sin mirar dónde está el foco en ese momento.
- Al elegir Edit, el menú se desmonta y la sheet se abre. Ese timer no tiene tiempo acotado: con el hilo
  ocupado (montaje de la sheet, chunk de Motion, comandos CDP con prioridad) puede correr después de que
  la sheet se cerró y el usuario enfocó la flecha atrás. Le roba el foco y el Enter siguiente reabre el menú.
- La `Sheet` tenía el mismo defecto: su `onCloseAutoFocus` devolvía el foco al opener sin comprobar si el
  usuario ya estaba en otro control.
- Hipótesis (b) descartada: a 375 px el toolbar queda `compact` todo el flujo (el nombre "Back to
  Projects" solo existe en compact) y el log de foco no muestra un remontaje del link, solo
  `focusout A[Back to Projects] -> BUTTON[project-actions-menu]` seguido del `focusin` cuyo stack es
  `onCloseAutoFocus` del RowMenu.

## Prueba

Probe temporal en `projects-dod.spec.ts` (eliminado): log de `focusin`/`focusout` con stack, marcas antes y
después de cada paso.

| Prueba | Resultado |
|---|---|
| Idle, sin intervención | 1 de 2 corridas: el restore del menú llegó 6 ms *después* del Enter en la flecha (el robo existe, el Enter ganó por poco) |
| Carga (28 busy-loops `noodara.stress=14-34`) + throttle 10, x6 | 6/6 pasan: con throttle el restore cae mientras la sheet está abierta y su trap lo devuelve |
| RED determinista, código previo: los timers de restore de FocusScope retenidos y liberados después de `back.focus()` | 2/2 fallan como el nightly: foco en el trigger, menú `open`, URL en `/projects/<id>` |
| Mismo RED determinista con el fix | 3/3 pasan: el foco sigue en la flecha, navega a `/projects` |

## Fix

- `packages/ui/src/RowMenu.tsx`: `onCloseAutoFocus={keepFocusThatMovedOn}`. Si el foco está fuera del
  contenido cerrado (ni `body` ni dentro del contenido), se cancela la restauración. Con el foco perdido
  sigue volviendo al trigger (Escape, selección normal).
- `packages/ui/src/Sheet.tsx`: `useReturnFocus` aplica la misma regla antes de volver al opener y anula
  también el default de Radix en ese caso.
- Tests de componente (RED visto, ambos recibían el foco en el trigger/opener): `RowMenu.test.tsx` "never
  takes focus back…" y `Sheet.test.tsx` "but never takes focus back…". Cierran con `fireEvent` (síncrono),
  así el timer de restore sigue pendiente cuando el test enfoca otro control.
- El spec no cambia: sin esperas nuevas.

## Verificación

Ver tabla de cierre abajo.
