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

    const itemSummary = this._formatItemSummary(items, !!targetDir);
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

  private static _formatItemSummary(items: VfsEventItem[], hasTargetDir: boolean): string {
    if (items.length === 1) return this._label(items[0], hasTargetDir, true);

    const labels = items.map((i) => this._label(i, hasTargetDir, false));
    if (items.length <= 3) {
      return `${items.length} items (${labels.join(', ')})`;
    }
    return `${items.length} items (${labels.slice(0, 3).join(', ')} and ${items.length - 3} more)`;
  }

  /**
   * 1 項目の書き方。行き先のフォルダが在れば名前だけ（行き先は文の後ろに 1 度出る）。
   * 無ければ、先が元と違う項目は「元 -> 先」（改名・ゴミ箱から戻す。複数でも、先は項目ごとに違いうる。T-0923）。
   * 先の無い項目は、1 件ならパス、複数なら名前
   */
  private static _label(item: VfsEventItem, hasTargetDir: boolean, single: boolean): string {
    const name = item.name || item.srcPath.split('/').pop() || item.srcPath;
    if (hasTargetDir) return `"${name}"`;
    if (item.destPath && item.srcPath !== item.destPath) return `"${item.srcPath}" -> "${item.destPath}"`;
    return single ? `"${item.srcPath}"` : `"${name}"`;
  }
}
