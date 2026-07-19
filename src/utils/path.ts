/**
 * Resolves a relative VFS path using the existing GuestCompiler and
 * ProcessManager path semantics.
 */

export function resolveRelativePath(baseDir: string, relPath: string): string {
  if (relPath.startsWith('/')) {
    baseDir = '';
    relPath = relPath.substring(1);
  }
  const stack = baseDir ? baseDir.split('/') : [];
  const parts = relPath.split('/');

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}