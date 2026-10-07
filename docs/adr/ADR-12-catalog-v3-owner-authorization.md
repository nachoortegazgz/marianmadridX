# ADR-12 — Catalog V3: autorización del propietario y transición del sitio

- **Fecha:** 2026-10-07
- **Estado:** Aprobado por autorización expresa del propietario en esta tarea.
- **Supersede:** La conclusión “NO MIGRAR” de ADR-07 como decisión de destino; la sección 11 de ADR-06 en cuanto al objetivo de versión del catálogo.
- **Base:** Repositorio `nachoortegazgz/marianmadridX`, revisión base `5c4ee6dddd7141d9089e4d685be35e01d312cfaa`.

## Contexto y autorización

La rama principal contiene ADR-07, que concluye “NO MIGRAR”, y ADR-06, que ordena mantener Stores Catalog V1. El propietario revocó expresamente esa dirección el 2026-10-07 y autorizó Catalog V3, además de aprobar la excepción a la SSOT-08 anterior. Este ADR registra esa autorización y sustituye el objetivo futuro de V1; no altera retroactivamente la evidencia técnica histórica de ADR-07.

El contexto leído de Wix para el sitio Marian Madrid (ID `188bed94-177c-4bc9-a9f0-35080d874f3e`) confirma que Wix Stores está instalado en Catalog V1. La documentación oficial Wix consultada establece que un sitio usa V1 o V3, pero no ambos a la vez.

## Decisión

1. Catalog V3 queda fijado como destino del catálogo comercial Wix.
2. `@wix/stores` se añade al proyecto en la versión exacta `1.0.938`, que exporta el SDK `productsV3` y `queryProducts`.
3. La migración de código no inventará un call site: la auditoría del checkout no encontró operaciones de catálogo de productos V1 propias que portar. Las referencias eCommerce/Bookings existentes no se convierten en operaciones Products V3.
4. Hasta que el sitio cambie efectivamente a V3, no se desplegarán ni ejecutarán endpoints Catalog V3 contra ese sitio V1.
5. La incorporación de la dependencia y documentación en Git no migra productos ni cambia la versión de Stores. La migración del sitio y conciliación de los datos son trabajo separado y deben preservar IDs, variantes, precios, SKU y disponibilidad/inventario.

## Consecuencias

- ADR-06 y ADR-07 conservan su historial; esta decisión posterior prevalece para el destino.
- No se cambia en esta rama ningún producto, variante, precio, inventario, pedido o setting del sitio Wix.
- El proyecto puede desarrollar una integración V3 en cuanto el sitio confirme la versión V3 y se comprueben permisos/scopes adecuados.
- El catálogo de servicios de reservas (`ServiciosCatalogo`) mantiene su identidad y no se sustituye por Wix Stores: esta transición aplica solo al catálogo comercial Stores.

## Fuentes

- Contexto Wix del sitio recibido en esta sesión el 2026-10-07: Wix Stores — Catalog V1.
- Wix, [About the Wix Stores Catalog V3](https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v3/introduction): cada sitio admite Catalog V1 o V3, no ambos.
- Wix, [Query Products](https://dev.wix.com/docs/api-reference/business-solutions/stores/catalog-v3/products-v3/query-products): Products V3 y limitaciones de consulta/variantes.
- Wix, [About npm Packages](https://dev.wix.com/docs/develop-websites-sdk/code-your-site/developer-environments/packages/npm/about-npm-packages): `@wix/stores` es el paquete Wix para productos e inventario.
