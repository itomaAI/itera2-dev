/**
 * src/config/constants.ts
 * Itera OS v2: System Constants
 */

// Providers configuration has been moved to VFS: system/registry/llm_profiles.json

export const VFS_HARD_LIMITS = {
  /** Maximum total size for VFS (1GB) */
  MAX_STORAGE_BYTES: 1024 * 1024 * 1024,
  
  /** Reserved space to guarantee system processes and logs can run (50MB) */
  SYSTEM_RESERVE_BYTES: 50 * 1024 * 1024,
};
