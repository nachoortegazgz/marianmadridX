/*
=============================================================================
MODULE: backend/mmSecrets.js
VERSION: v5011-CLEAN-DEAD-SECRETS
BASE: v5009-FISCAL-V20.1
RESPONSIBILITY: Nombres canonicos de secretos Wix.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5011-CLEAN-DEAD-SECRETS:
  - CLEAN-01: eliminados secretos sin consumidor en el repo:
      POWER_AUTOMATE, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL,
      RESEND_API_KEY, RESEND_FROM_EMAIL,
      M365_GRAPH_CLIENT_ID, M365_GRAPH_CLIENT_SECRET, M365_GRAPH_TENANT_ID,
      M365_GRAPH_SITE_ID, M365_GRAPH_LIST_ID, M365_WEBHOOK_HMAC_KEY.
    M365 y SendGrid/Resend quedaron sin feature activa; POWER_AUTOMATE
    no tiene lecturas. Los secretos pueden seguir existiendo en Wix
    Secrets Manager; este modulo solo declara nombres referenciados.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. Los nombres de secretos son
            externos (Wix Secrets Manager) y no forman parte de la
            matriz V20.1.

CORRECTIONS (heredadas):
  [VF-01].
=============================================================================
*/

export const SECRETS = Object.freeze({
    // Fiscal (obligatorio Veri*factu)
    FISCAL_KEY: "SECRET_FISCALKEY",
    FISCAL_NIF_EMISOR: "FISCAL_NIF_EMISOR",

    // Firma X.509 delegada en microservicio externo
    FISCAL_SIGNER_ENDPOINT: "FISCAL_SIGNER_ENDPOINT",
    FISCAL_SIGNER_BEARER: "FISCAL_SIGNER_BEARER",

    // Autenticacion y roles
    AUTH_JWT_KEY: "SECRET_AUTH_JWT_KEY",
    ADMIN_EMAILS: "ADMIN_EMAILS",
    CAJERO_EMAILS: "CAJERO_EMAILS",

    // Asistente IA
    MARIAN_ASSISTANT_OPENAI_KEY: "MARIAN_ASSISTANT_OPENAI_KEY",
});

/*
-----------------------------------------------------------------------------
SDK v2 MIGRATION (ADR-06 Etapa C / ADR-10, T4): canonical getSecret wrapper.
Legacy Velo used:  import { getSecret } from "wix-secrets-backend";
@wix/secrets exposes secrets.getSecretValue(name) with the SAME positional
signature, so this wrapper keeps every consumer call-site unchanged:
    await getSecret(SECRETS.FISCAL_KEY)   ->   secrets.getSecretValue(name)
Consumers import { SECRETS, getSecret } from "backend/mmSecrets".
G10 ASCII strict. No secret values are ever hardcoded here (names only).
-----------------------------------------------------------------------------
*/
import { secrets } from "@wix/secrets";

export async function getSecret(name) {
    return secrets.getSecretValue(name);
}
