/**
 * src/core/vfs/VfsEventFormatter.ts
 * Itera OS v2: Unified VFS Event Message Formatter
 */

export interface VfsEventItem {
  srcPath: string;
  destPath?: string;
  name?: string;
}

export interface VfsEventContext {
  actor: 'User' | string;
  action: 'move' | 'copy' | 'delete' | 'create' | 'upload' | 'edit';
  items: VfsEventItem[];
  targetDir?: string;
}

export class VfsEventFormatter {
  public static format(ctx: VfsEventContext): string {
    const { actor, action, items, targetDir } = ctx;
    if (!items || items.length === 0) return '';

    const itemSummary = this._formatItemSummary(items);
    const destStr = targetDir ? ` to "${targetDir}"` : '';

    switch (action) {
      case 'move':
        return `${actor} moved ${itemSummary}${destStr}`;
      case 'copy':
        return `${actor} copied ${itemSummary}${destStr}`;
      case 'delete':
        return `${actor} deleted ${itemSummary}`;
      case 'upload':
        return `${actor} uploaded ${itemSummary}${destStr}`;
      case 'create':
        return `${actor} created ${itemSummary}${destStr}`;
      case 'edit':
        return `${actor} saved edits to ${itemSummary}`;
      default:
        return `${actor} performed ${action} on ${itemSummary}`;
    }
  }

  private static _formatItemSummary(items: VfsEventItem[]): string {
    if (items.length === 1) {
      const item = items[0];
      const name = item.name || item.srcPath.split('/').pop() || item.srcPath;
      if (item.destPath) {
        return `"${name}" (${item.srcPath} -> ${item.destPath})`;
      }
      return `"${name}" (${item.srcPath})`;
    }

    const names = items.map((i) => `"${i.name || i.srcPath.split('/').pop() || i.srcPath}"`);
    if (items.length <= 3) {
      return `${items.length} items (${names.join(', ')})`;
    }
    return `${items.length} items (${names.slice(0, 3).join(', ')} and ${items.length - 3} more)`;
  }
}