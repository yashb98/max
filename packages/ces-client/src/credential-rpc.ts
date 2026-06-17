/**
 * @maxai/ces-client/credential-rpc
 *
 * Re-exports the credential RPC surface from `@maxai/service-contracts` so
 * consumers that depend on `@maxai/ces-client` can access the CES wire
 * protocol types through this package without a separate dependency on
 * `@maxai/service-contracts`.
 *
 * Prefer importing directly from `@maxai/service-contracts/credential-rpc`
 * for new code outside of the ces-client boundary.
 */

export * from "@maxai/service-contracts/credential-rpc";
