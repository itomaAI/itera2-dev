/**
 * src/core/vfs/backupExclusion.test.ts
 * 全体バックアップの除外判定（T-0030）
 *
 * 守りたいこと:
 *   1. ルートマウントで全部を除外してしまわないこと（バックアップが空になる）
 *   2. 前方一致の紛れでマウント外を巻き込まないこと
 *   3. マウント表に載らないスタブも確実に外れること
 *      （デーモン未起動・接続断のとき、1 番目の規則は効かない）
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMountPaths,
  findExcludingMount,
  classifyForBackup,
  BackupExclusionRecorder,
  BACKUP_MANIFEST_FORMAT,
} from './backupExclusion';

describe('normalizeMountPaths', () => {
  it('ルートマウントは除外対象にしない', () => {
    expect(normalizeMountPaths([{ mountPath: '', pid: 'gdrive' }])).toEqual([]);
    expect(normalizeMountPaths([{ mountPath: '/', pid: 'gdrive' }])).toEqual([]);
  });

  it('前後のスラッシュを落とし、重複を畳み、長い順に並べる', () => {
    const got = normalizeMountPaths([
      { mountPath: 'local/a' },
      { mountPath: '/local/a/' },
      { mountPath: 'local/a/deeper' },
      { mountPath: '' },
    ]);
    expect(got).toEqual(['local/a/deeper', 'local/a']);
  });

  it('null や undefined でも落ちない', () => {
    expect(normalizeMountPaths(null)).toEqual([]);
    expect(normalizeMountPaths(undefined)).toEqual([]);
  });
});

describe('findExcludingMount', () => {
  const mounts = ['local/yachiyo/ws_itera'];

  it('マウント地点そのものと、その配下は当たる', () => {
    expect(findExcludingMount('local/yachiyo/ws_itera', mounts)).toBe('local/yachiyo/ws_itera');
    expect(findExcludingMount('local/yachiyo/ws_itera/src/main.ts', mounts)).toBe('local/yachiyo/ws_itera');
  });

  it('名前が前方一致するだけの別ディレクトリは当たらない', () => {
    // 素の startsWith で書くとここが落ちる
    expect(findExcludingMount('local/yachiyo/ws_itera_evil/x.txt', mounts)).toBeNull();
    expect(findExcludingMount('local/yachiyo/ws_iteraX', mounts)).toBeNull();
  });

  it('最長一致を先に返す', () => {
    const nested = normalizeMountPaths([{ mountPath: 'local/a' }, { mountPath: 'local/a/deeper' }]);
    expect(findExcludingMount('local/a/deeper/f.txt', nested)).toBe('local/a/deeper');
  });
});

describe('classifyForBackup', () => {
  const mounts = normalizeMountPaths([{ mountPath: 'local/yachiyo/ws_itera' }, { mountPath: '' }]);

  it('通常のファイルは含める', () => {
    expect(classifyForBackup({ path: 'memory/init.md' }, mounts)).toEqual({ excluded: false, reason: null });
  });

  it('ルートマウントがあっても、その外のファイルは含める', () => {
    expect(classifyForBackup({ path: 'data/notes/a.md' }, mounts).excluded).toBe(false);
  });

  it('マウント配下は、実体があっても外す', () => {
    const v = classifyForBackup({ path: 'local/yachiyo/ws_itera/src/main.ts', syncState: 'synced' }, mounts);
    expect(v).toEqual({ excluded: true, reason: 'mount', mountPath: 'local/yachiyo/ws_itera' });
  });

  it('マウント表に載らないスタブも外す（接続断のときに効く規則）', () => {
    const v = classifyForBackup({ path: 'local/spark/densoten/img/0001.jpg', syncState: 'stub' }, mounts);
    expect(v.excluded).toBe(true);
    expect(v.reason).toBe('stub');
  });

  it('マウント配下のスタブは mount として数える（理由が二重に立たない）', () => {
    const v = classifyForBackup({ path: 'local/yachiyo/ws_itera/big.bin', syncState: 'stub' }, mounts);
    expect(v.reason).toBe('mount');
  });

  it('ごみ箱は従来どおり外す', () => {
    expect(classifyForBackup({ path: 'trash/old.md' }, mounts).reason).toBe('trash');
  });

  it('先頭のスラッシュがあっても同じ判定になる', () => {
    expect(classifyForBackup({ path: '/local/yachiyo/ws_itera/a.ts' }, mounts).reason).toBe('mount');
  });
});

describe('BackupExclusionRecorder', () => {
  const mountTable = [
    { mountPath: 'local/yachiyo/ws_itera', pid: 'local_bridge' },
    { mountPath: '', pid: 'gdrive_sync_daemon' },
  ];
  const mounts = normalizeMountPaths(mountTable);

  function run() {
    const rec = new BackupExclusionRecorder(mountTable);
    const files = [
      { path: 'memory/init.md', size: 100, syncState: 'synced' },
      { path: 'local/yachiyo/ws_itera/a.ts', size: 200, syncState: 'synced' },
      { path: 'local/yachiyo/ws_itera/b.ts', size: 300, syncState: 'stub' },
      { path: 'local/spark/densoten/x.jpg', size: 1000, syncState: 'stub' },
      { path: 'local/spark/densoten/y.jpg', size: 2000, syncState: 'stub' },
      { path: 'trash/old.md', size: 9999, syncState: 'synced' },
    ];
    for (const f of files) {
      const v = classifyForBackup(f, mounts);
      if (v.excluded) rec.recordExcluded(f.path, f.size, v);
      else rec.recordIncluded(f.size);
    }
    return rec.toManifest(new Date('2026-08-20T00:00:00.000Z'));
  }

  it('マウントごとに件数と容量をまとめる', () => {
    const m = run();
    expect(m.excludedMounts).toEqual([
      { mountPath: 'local/yachiyo/ws_itera', pid: 'local_bridge', files: 2, bytes: 500 },
    ]);
  });

  it('マウント外のスタブは接頭辞ごとにまとめる', () => {
    const m = run();
    expect(m.excludedStubsOutsideMounts.files).toBe(2);
    expect(m.excludedStubsOutsideMounts.bytes).toBe(3000);
    expect(m.excludedStubsOutsideMounts.byPrefix).toEqual([{ prefix: 'local/spark/densoten', files: 2, bytes: 3000 }]);
  });

  it('ごみ箱は集計に混ぜない', () => {
    const m = run();
    expect(m.totals.excludedFiles).toBe(4);
    expect(m.totals.excludedBytes).toBe(3500);
    expect(m.totals.includedFiles).toBe(1);
    expect(m.totals.includedBytes).toBe(100);
  });

  it('形式と時刻を持つ', () => {
    const m = run();
    expect(m.format).toBe(BACKUP_MANIFEST_FORMAT);
    expect(m.createdAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('除外が無ければ空の集計になる（マウントは 0 件として残る）', () => {
    const rec = new BackupExclusionRecorder(mountTable);
    rec.recordIncluded(10);
    const m = rec.toManifest();
    expect(m.totals.excludedFiles).toBe(0);
    expect(m.excludedMounts).toEqual([
      { mountPath: 'local/yachiyo/ws_itera', pid: 'local_bridge', files: 0, bytes: 0 },
    ]);
  });
});
