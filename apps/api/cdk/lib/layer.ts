/**
 * The DuckDB Lambda layer is built with a frozen `pnpm deploy`. pnpm also writes two metadata files into
 * node_modules that hold build timestamps and absolute paths, and a copy of the workspace settings
 * (nodejs/pnpm-workspace.yaml, which follows the root pnpm-workspace.yaml); Node never loads any of them.
 * They are left out of the asset, so two clean builds give the same asset hash, and a deploy does not
 * replace the layer version when only pnpm's own bookkeeping changed.
 */
import { FileSystem } from "aws-cdk-lib";

export const LAYER_EXCLUDE = [
  "nodejs/node_modules/.modules.yaml",
  "nodejs/node_modules/.pnpm-workspace-state-v1.json",
  "nodejs/pnpm-workspace.yaml",
];

/** The asset hash CDK computes for a layer directory (same fingerprint and exclude list as the stack). */
export const layerFingerprint = (dir: string): string =>
  FileSystem.fingerprint(dir, { exclude: LAYER_EXCLUDE });
