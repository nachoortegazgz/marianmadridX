# ADR-06: Decision de migracion Velo -> JavaScript SDK v2 (FASE8)

Fecha: 2026-10-02
Estado: Aceptada
Alcance: Etapa A (correcciones seguras) ejecutada; Etapa C EJECUTADA
(FASE8-C1/C2, ver ADR-10 docs/adr/ADR-10-sdk-v2-data-migration.md);
Etapas B y D registradas como pendientes.

## Contexto

La auditoria SDK del proyecto detecto tres niveles distintos de deuda:

1. Deprecated confirmado en documentacion oficial de Wix.
2. Velo estable pero legacy (sigue funcionando; las nuevas funcionalidades
   van al JavaScript SDK).
3. Legacy interno del proyecto (contratos SSOT), no API deprecated de Wix.

## Decisiones

### 1. Imports backend: convencion unica `backend/<modulo>.web.js`

Aplicado en Etapa A. Todos los especificadores `backend/*.web` (estaticos y
dinamicos `import()`) se normalizaron con extension `.js`, incluida la capa
backend interna (crons, events, citasManager, eventLog, bookingSaga,
fiscalDocuments). Se verifico que el harness offline (`tests/loader.mjs`)
resuelve ambas formas (anade `.js` automaticamente). En una pasada posterior
se normalizaron tambien los `import()` dinamicos de los `.test.mjs` que aun
usaban la forma corta (`backend/reservas.web`, `backend/cajas.web`,
`backend/fiscalAggregator.web` -> `*.web.js`), para que el criterio "un solo
estilo" incluya explicitamente la capa de tests. Los especificadores internos
no-`.web` (p. ej. `backend/logger`, `backend/internalConfig`) quedan tal cual:
el contrato de extension `.web.js` solo aplica a los webModules.

Criterio cumplido: un solo estilo, modulos existentes, funciones exportadas,
`node --check` OK y bateria de pruebas en verde (52 pass / 0 fail).

### 2. `promptLogin()` no debe bloquear `onReady()`

Corregido en `ADMINISTRACION.gn7mx.js`: se elimina el `await` sobre
`promptLogin()` dentro de `$w.onReady` y se maneja con `.catch(() => {})`,
siguiendo la advertencia oficial de Wix (retornar/esperar la promesa puede
impedir la carga de la pagina). La autorizacion sigue siendo backend
(`checkStaffCollaboratorAccess` + `isMarianManager`); la sesion de Members
no autoriza por si sola.

### 3. `wix-window` -> `wix-window-frontend`

`ConfirmacionReserva.q5vps.js` migro su import al modulo frontend
`wix-window-frontend`, normalizando el proyecto (el calendario ya usaba el
modulo frontend). `wixWindow.lightBox.close()` continua documentado por
compatibilidad. No se sustituye el patron lightbox completo porque el
calendario abre la confirmacion con `openLightbox(...)` y le pasa datos.

### 4. Codigo muerto `wix-data` en frontend

Ya retirado previamente en `ConfirmacionReserva.q5vps.js` (comentario FASE4
SSOT-07). Verificacion global: ningun import de `wix-data` queda en
`src/pages/`; todos los usos restantes son backend-legitimos.

### 5. Campos legacy SSOT (`slugUrl`, `addons`, `imageUrl`, `phase2ServiceId`)

Barrido global confirmado: NO existen fallbacks legacy de esos campos en
`src/pages/` ni en DTOs nuevos del backend. El calendario ya trabaja con
`slug`, `addOnIds`, `mainMedia` y `linkedPhases`. Restos aceptados:
proyecciones de compatibilidad `metadata.titulo` / `metadata.tituloServicio`
en `reservas.web.js` (ambas derivan de `title` canonico; no son identidad
canonica, se conservan como alias de lectura hasta confirmar consumidores) y
la palabra "addons" en mensajes de error legibles (no es campo de datos).

### 6. Members: `wix-members-frontend` -> `@wix/site-members` (ETAPA B, pendiente)

Se MANTIENE temporalmente `wix-members-frontend` como excepcion documentada:

- `@wix/site-members` no esta instalado ni resuelto en `wix.lock`; instalar
  paquetes SDK frontend requiere accion en el editor/site de Wix, no
  reproducible de forma segura desde este repositorio.
- Sustituir el import sin poder ejecutar el sitio publicaria una pagina de
  administracion rota (peor que el estado actual, que es Velo legacy
  estable, no deprecated).

Plan cuando el paquete este disponible:
1. Adaptador local `getCurrentMemberSafe()` sobre `currentMember.getMember()`.
2. Migrar `promptLogin()` al modulo de autenticacion del SDK (ya corregido
   el patron anti-bloqueo en Etapa A).
3. Probar SOLO en sitio publicado (las APIs frontend de Members no funcionan
   completamente en Preview).
4. Mantener verificacion de rol en backend.

### 7. `onLogin` deprecated

Busqueda global sobre `src/` (incluido `masterPage.js`): SIN resultados. No
existe uso de `onLogin`/`wixUsers.onLogin`/`wixMembersFrontend.onLogin`. Sin
accion necesaria. Revisar en cada auditoria futura antes del 30-09-2026 ya
superado; cualquier aparicion posterior debe sustituirse de inmediato.

### 8. `wix-location-frontend` y `wix-window-frontend`: Velo legacy estable

DECISION: mantener. Son las APIs soportadas para `wixLocation.query`,
`wixLocation.to(...)` y lightboxes en codigo de pagina Velo. Los equivalentes
SDK (`@wix/site-location`, `@wix/site-window`) no cubren aun el contrato de
routing/query usado por calendario, ADMINISTRACION y ZONA STAFF, y la
sustitucion exigiria rediseñar el flujo popup de confirmacion. Registrado
como "Velo legacy estable; migracion SDK posterior" (Etapa D).

### 9. `$w`

No es deprecated. Wix confirma que `$w`/`$widget` siguen recibiendo
actualizaciones dentro de las APIs Velo-only. Se mantiene para elementos de
pagina, eventos de UI, HTML components y widget bridge. No tiene equivalente
en SDK v2.

### 10. `wix-data` -> `wix-data.v2` / SDK (ETAPA C, pendiente)

Inventario: 20 modulos backend importan `wix-data`. Politica:
- Consultas nuevas: preferir SDK v2.
- Ledger, hooks y consultas fiscales criticas: NO migrar sin pruebas de
  igualdad de resultados (permisos, filtros, paginacion, orden, errores).
- Frontend con acceso directo a CMS: prohibido (usar webMethods). Ya cumple.

### 11. Bookings / Stores

Se mantiene Wix Bookings V2 y Stores Catalog V1 segun la Biblia del
proyecto. Sin migracion a Catalog V3. El SDK v2 se usa solo como cliente
oficial, nunca como nueva fuente de verdad.

POST-AUDITORIA 2026-10-02: esta decision fue re-verificada con evidencia
fisica (barrido completo de src/, package.json y wix.lock) y ampliada con
el analisis tecnico de impacto en ADR-07 (`docs/adr/ADR-07-catalog-v3-analysis.md`):
superficie Stores real = cero codigo propio; decision NO MIGRAR confirmada.

## Consecuencias

- Riesgo bajo: todas las modificaciones de Etapa A son sintaxis/contrato o
  correccion anti-bloqueo documentada; no alteran Bookings, caja, ledger ni
  fiscalidad.
- Validacion: `node --check` en todos los ficheros modificados y bateria
  offline completa en verde.
- Pendientes gobernados: Etapa B (Members SDK, requiere instalacion del
  paquete), Etapa C (data, requiere pruebas de igualdad), Etapa D
  (routing/UI, requiere cobertura SDK).

## Ejecucion Etapa C (FASE8-C1/C2, 2026-10-07) -- EJECUTADA

Etapa C marcada como EJECUTADA. Detalle completo de decisiones, verificaciones
y correcciones sobre el plan original en ADR-10
(`docs/adr/ADR-10-sdk-v2-data-migration.md`). Resumen:

- DAL unico `src/backend/dataClient.js` sobre la superficie real de
  `@wix/data` (`items.*`), con firma compatible wix-data; 18 modulos
  backend importan ahora `backend/dataClient` (0 residuos `wix-data`).
- `consistentRead` sustituido en call-sites por `consistencyMode:
  "strong"` (17) / `"eventual"` (2); lectura fuerte de CAJA_SEQ preservada
  (RD 1619/2012).
- Secretos via wrapper canonico `getSecret(name)` en `mmSecrets.js` sobre
  `secrets.getSecretValue` de `@wix/secrets` (firma posicional real del
  paquete; NO `getSecret({name})` como asumia el plan). 8 consumidores
  fusionados; 0 residuos `wix-secrets-backend`.
- `@wix/members` x3 y `@wix/ecom` x1 aplicados. Nota de alcance: T5/T6
  cambian solo el especificador; la superficie invocada
  (`currentMember.getMember()`, `orders.getOrder()`) difiere de la API
  funcional de esos paquetes y queda pendiente de validacion E2E en
  preview antes de publicar (ver ADR-10 Riesgo R7).
- Harness offline: rama dedicada `mock:@wix/data` delegando en
  `wixDataMock` + export `secrets.getSecretValue` determinista; mock
  ampliado con contrato de cursor (`totalCount`, `hasNext()`, `next()`).
- Igualdad verificada: bateria offline 57/57 verde, identica al baseline
  pre-migracion (misma semantica de store a traves del DAL).
- Whitelist de gobernanza: `contabilidad.js` y `marianAssistant.web.js`
  permanecen activos pese a BIBLIA 13.2 (consumidores vivos; ver ADR-10).
