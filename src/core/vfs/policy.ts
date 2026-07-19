export const VFS_POLICY = {
  permanentDeletePrefixes: ['trash', 'system/temp', 'system/logs'],
  isPermanentDelete(path: string): boolean {
    const norm = path.replace(/\\/g, '/');
    return this.permanentDeletePrefixes.some((p) => norm === p || norm.startsWith(p + '/'));
  },
};