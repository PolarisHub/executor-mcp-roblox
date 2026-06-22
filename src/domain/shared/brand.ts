/**
 * Nominal ("branded") types. The compiler treats `Brand<string, "ClientId">` as
 * distinct from a bare `string`, so an id can never be passed where a different
 * id (or a raw string) is expected. Branding lives in the domain because identity
 * is a domain concern, not an infrastructure detail.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };
