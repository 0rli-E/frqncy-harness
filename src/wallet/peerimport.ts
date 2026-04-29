/**
 * Helper for dynamically importing optional peer dependencies (`viem`,
 * `@coinbase/cdp-sdk`) without TypeScript trying to resolve them at
 * compile time.
 *
 * `import()` with a literal string is statically analyzed; TypeScript will
 * fail compilation if the module isn't installed (peer dep). Wrapping the
 * specifier in a `string`-typed variable defeats that analysis. The runtime
 * behavior is identical.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function peerImport<T = any>(specifier: string): Promise<T> {
  // The cast through `string` (and the indirection through this function)
  // prevents TS from attempting to resolve the module at type-check time.
  // This is the documented escape hatch for optional peer deps.
  return (await import(specifier as string)) as T;
}
