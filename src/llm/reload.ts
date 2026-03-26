/** Pending reload state — shared between file tools and the agentic loop */

let pendingReload = false;

export function isPendingReload(): boolean {
  return pendingReload;
}

export function setPendingReload(value: boolean): void {
  pendingReload = value;
}

const SOURCE_EXT = /\.(ts|js|mts|mjs|json)$/;

/**
 * Mark a pending reload if the file is a source file.
 * Called by write_file / edit_file after mutating source code.
 */
export function markReloadIfSource(filePath: string): boolean {
  if (SOURCE_EXT.test(filePath)) {
    pendingReload = true;
    return true;
  }
  return false;
}
