/**
 * The DuckDB Lambda layer is built with a frozen `pnpm deploy`. pnpm also writes two metadata files into
 * node_modules that hold build timestamps and absolute paths; Node never loads them. They are left out of
 * the asset, so two clean builds give the same asset hash and a deploy does not replace the layer version.
 */
import { FileSystem } from "aws-cdk-lib";

export const LAYER_EXCLUDE = [
  "nodejs/node_modules/.modules.yaml",
  "nodejs/node_modules/.pnpm-workspace-state-v1.json",
];

/** The asset hash CDK computes for a layer directory (same fingerprint and exclude list as the stack). */
export const layerFingerprint = (dir: string): string =>
  FileSystem.fingerprint(dir, { exclude: LAYER_EXCLUDE });
