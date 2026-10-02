# ADR-07: Analisis de migracion a Wix Stores Catalog V3 (auditoria post-SDK)

Fecha: 2026-10-02
Estado: Aceptada — Decision: NO MIGRAR (rechazo fundamentado con evidencia fisica)
Relacion: extiende y confirma la decision ya registrada en ADR-06 seccion 11.
Alcance: barrido completo de src/, package.json, wix.lock y docs/.

## Contexto

La directriz del proyecto ("Biblia") exige mantener Wix Bookings V2 y Wix
Stores Catalog V1, y prohibe expresamente una migracion a Catalog V3. La
auditoria de codigo actual verifica fisicamente si esa prohibicion sigue
siendo correcta o si existe deuda que obligue a reevaluarla.

## Evidencia del barrido (octubre 2026)

### 1. Superficie Stores real = CERO

- Ningun archivo de `src/` importa `wix-stores-backend`, `wix-stores-frontend`
  ni `@wix/stores`. Grep global: 0 coincidencias.
- Las 8 paginas ecommerce del sitio (`Pagina del producto.deb1u.js`,
  `Pagina de categoria.clfx1.js`, `Pagina del carrito.twv9b.js`,
  `Pagina de pago.exnty.js`, `Carrito lateral.m1jxs.js`,
  `Mis pedidos.obpcx.js`, `TARJETAS REGALO.sodym.js`, `Servicios.d4fc7.js`)
  son plantillas vacias de Wix (10 lineas de comentarios boilerplate con un
  `$w.onReady` sin logica, y una de 0 bytes). No hay codigo propio que migrar.
- `package.json` no declara `@wix/stores`; `wix.lock` tampoco lo resuelve.
  El unico paquete ecommerce declarado es `@wix/ecom` (checkout), usado para
  el flujo ONLINE de reservas, no para catalogo de productos.

### 2. El "catalogo" operativo no es Wix Stores

El catalogo canonico del negocio es la coleccion CMS propia
`ServiciosCatalogo` (rev.88), leida via `wixData` server-side con la
excepcion documentada del APENDICE C de la Biblia (suppressAuth controlado;
no se migra a `datasets.query('@wix/data')`). Las colecciones de inventario
(`ProductosCatalogo`, `ComplementosCatalogo`, `ProveedoresLista`) estan
declaradas en `RESERVED_COLLECTIONS` (internalConfig.js:87-96) como dominio
gestionado FUERA del nucleo SSOT, con cero consumidores backend activos
(grep verificado; `ComplementosCatalogo` y `ProveedoresLista` ademas marcados
degradados por evidencia ADR-04).

### 3. Inconsistencia detectada y corregida en la gobernanza SDK

`bookingCore.js` importa `checkout` de `@wix/ecom` y `package.json` lo
declara, PERO `@wix/ecom` NO esta resuelto en `wix.lock` (0 coincidencias).
Contraste: los demas paquetes SDK declarados (`@wix/bookings`, `@wix/data`,
`@wix/members`, `@wix/crm`, `@wix/secrets`, `@wix/site-*`) SI aparecen en el
lock. Esto sugiere que el lock esta desactualizado respecto a package.json
(situacion tipica tras anadir dependencias sin `wix install` / sync local).
Accion gobernada: ejecutar `npx @wix/cli install` (o `wix dev`) en entorno
con red y confirmar regeneracion del lock ANTES de cualquier publicacion.
No se toca el codigo: el import es correcto segun la documentacion SDK.

## Analisis tecnico de una hipotetica migracion a Catalog V3

| Dimension | Hallazgo | Impacto |
|---|---|---|
| API surface usada hoy | 0 llamadas a APIs de Stores (V1 o V3) | Nada que portar |
| Fuente de verdad | ServiciosCatalogo (CMS propio) + Bookings V2 | V3 introduceria una SEGUNDA fuente de verdad de catalogo, violando la SSOT vigente |
| Fiscal/ledger | eventLog/cajas referencian `catalogId` = id de Servicio CMS, con hash-chain append-only (ADR-05) | Cambiar la identidad del catalogo romper trazabilidad VeriFactu y ledger; riesgo regulatorio inaceptable sin necesidad funcional |
| Add-ons | Contrato canónico `addOnOptions`/`addOnId`/`addOnIds` embebido en ServiciosCatalogo (BIBLIA 3.2/4.3) | V3 modela options/productos con esquema distinto; exigiría re-validacion completa de bookingSaga SAGA-04 |
| Paginas | Plantillas vacias gestionadas por widgets nativos de Wix | La decision de activar ecommerce es funcional/comercial, no tecnica |
| Beneficio esperado | Ninguno cuantificable: no existen queries V1 propias que V3 mejore | Migracion preventiva sin driver = riesgo neto |

## Decision

**NO MIGRAR a Catalog V3.** Se confirma y refuerza ADR-06.11:

1. No existe superficie Stores V1 en codigo propio; la migracion carece de
   objeto material.
2. El catalogo operativo es `ServiciosCatalogo` bajo SSOT; adoptara V3 solo
   si el negocio activa ecommerce real sobre Wix Stores, mediante un nuevo
   ADR con analisis de impacto fiscal/ledger previo.
3. El SDK v2 (`@wix/bookings`, `@wix/ecom`) continua usandose exclusivamente
   como cliente oficial de capacidades ya gobernadas, nunca como nueva fuente
   de verdad.
4. Seguimiento abierto (no bloqueante): reconciliar `wix.lock` con
   `package.json` (`@wix/ecom` ausente en lock) antes de publicar.

## Consecuencias

- Cero cambios de codigo: el repositorio queda exactamente como estaba; la
  auditoria concluye que la prohibicion biblica es tecnicamente correcta y
  barata de mantener.
- La unica accion derivada es operativa (regenerar lock en entorno Wix CLI).
- Queda registrado el trigger de reevaluacion: activacion de ventas de
  producto fisico/tarjetas regalo reales sobre Wix Stores.
