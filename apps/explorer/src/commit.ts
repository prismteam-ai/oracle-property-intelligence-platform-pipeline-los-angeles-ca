/** Set by the build's Vite define (vite.config.ts explorerCommit); absent when the code runs from source (tests). */
declare const __EXPLORER_COMMIT__: string | undefined;

/**
 * The short hash of the last commit that changed the Explorer's own code (the files its bundle is built from),
 * fixed at build; "unbundled" when run from source.
 */
export const EXPLORER_COMMIT: string =
  typeof __EXPLORER_COMMIT__ === "string" ? __EXPLORER_COMMIT__ : "unbundled";
