/**
 * src/core/vfs/VersionedContent.test.ts
 * 中身は不変・名前が動く・渡した参照はプロセスの寿命（T-0791）
 *
 *   contentKey(id, version)            … 鍵は id@版。同じ鍵には 1 度しか書かない
 *   ContentStore.readBlob({ holder })  … handle を渡した相手を保持者として覚える
 *   ContentStore.delete                … 保持者が居れば消さずに孤児へ。release(holder) で参照 0 になった孤児を消す
 *   WriteOps（write / append / stub）  … 新しい鍵へ書き、ノードを差し替えた後で古い鍵を delete
 *   ContentStore.withBlob / VfsService.withBlob … 展開する読みは読み終わるまで鍵を保持する（T-0795）
 *   ContentStore.readBlob が失敗        … その呼び出しで付けた保持は残さない（T-0795）
 *   VfsFsck                            … 書き直しで残った古い鍵は削除（救出しない）。版が新しい鍵は触らない。
 *                                        ノードの無い鍵は従来どおり .lost+found へ
 *
 * 背景: OPFS の getFile() で得た File は同じ名前への上書き・削除で読めなくなる（両ブラウザで実測 2026-11-10）。
 * 二段起動（T-0784）はこの File をゲストに handle のまま渡しているので、別のプロセスの上書きで資産が壊れていた。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ContentStore, contentKey, parseContentKey } from './ContentStore';
import { VfsService } from './VfsService';
import { VfsFsck } from './VfsFsck';
import { PathResolver } from './PathResolver';
import { VfsEventBus } from './VfsEventBus';
import { USER_PRINCIPAL, type VfsNode } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** NodeStore の最小の写し（IndexedDB なし）。VersionedWrite.test.ts と同じ形 */
class MemoryNodeStore {
  memoryMap = new Map<string, VfsNode>();
  childrenIndex = new Map<string | null, Map<string, string>>();
  getNode(id: string) {
    return this.memoryMap.get(id);
  }
  getChildId(parentId: string | null, name: string) {
    return this.childrenIndex.get(parentId)?.get(name);
  }
  getChildren(parentId: string | null) {
    return [...(this.childrenIndex.get(parentId)?.values() || [])].map((id) => this.memoryMap.get(id)!).filter(Boolean);
  }
  getAllNodes() {
    return this.memoryMap.values();
  }
  getTotalSize() {
    return 0;
  }
  rebuildIndex() {
    this.childrenIndex.clear();
    for (const n of this.memoryMap.values()) this.add(n);
  }
  private add(node: VfsNode) {
    if (!this.childrenIndex.has(node.parentId)) this.childrenIndex.set(node.parentId, new Map());
    this.childrenIndex.get(node.parentId)!.set(node.name, node.id);
  }
  private remove(node: VfsNode) {
    this.childrenIndex.get(node.parentId)?.delete(node.name);
  }
  async putNode(node: VfsNode) {
    await this.commitTransaction([node], []);
  }
  async commitTransaction(puts: VfsNode[], deletes: string[]) {
    for (const id of deletes) {
      const ex = this.memoryMap.get(id);
      if (ex) {
        this.remove(ex);
        this.memoryMap.delete(id);
      }
    }
    for (const node of puts) {
      const ex = this.memoryMap.get(node.id);
      if (ex) this.remove(ex);
      this.memoryMap.set(node.id, node);
      this.add(node);
    }
  }
}

/** OPFS の根の最小の写し。removeEntry と上書きを数える */
function makeOpfs() {
  const files = new Map<string, Blob>();
  const removed: string[] = [];
  let overwrites = 0;
  const root = {
    getFileHandle: async (key: string, opts?: { create?: boolean }) => {
      if (!files.has(key)) {
        if (!opts?.create) throw Object.assign(new Error(key), { name: 'NotFoundError' });
      } else if (opts?.create) {
        overwrites++;
      }
      return {
        createWritable: async () => ({
          write: async (c: any) => {
            files.set(key, c instanceof Blob ? c : new Blob([c]));
          },
          close: async () => {},
          abort: async () => {},
        }),
        getFile: async () => files.get(key)!,
      };
    },
    removeEntry: async (key: string) => {
      if (!files.has(key)) throw Object.assign(new Error(key), { name: 'NotFoundError' });
      files.delete(key);
      removed.push(key);
    },
    keys: () => files.keys(),
  };
  const storage = { getDirectory: async () => root };
  return { storage, files, removed, overwrites: () => overwrites };
}

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
function installOpfs() {
  const opfs = makeOpfs();
  Object.defineProperty(navigator, 'storage', { value: opfs.storage, configurable: true });
  return opfs;
}
afterEach(() => {
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
  else delete (navigator as any).storage;
});

describe('contentKey', () => {
  it('id@版 の形で、parseContentKey が戻す。版の無い旧形式は version null', () => {
    expect(contentKey('abc', 7)).toBe('abc@7');
    expect(parseContentKey('abc@7')).toEqual({ nodeId: 'abc', version: 7 });
    expect(parseContentKey('abc')).toEqual({ nodeId: 'abc', version: null });
    expect(parseContentKey('abc@x')).toEqual({ nodeId: 'abc@x', version: null });
  });
});

describe('ContentStore の保持と後回しの削除（OPFS）', () => {
  it('保持されていない鍵の delete は即消える', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await store.delete(ref);
    expect(opfs.removed).toEqual(['n@1']);
    expect(store.orphanKeys()).toEqual([]);
  });

  it('holder 付きで readBlob した鍵は delete されても残り、release(holder) で消える', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    const blob = await store.readBlob(ref, { holder: 'app_a' });
    expect(await blob.text()).toBe('a');
    expect(store.heldKeys('app_a')).toEqual(['n@1']);

    await store.delete(ref);
    expect(opfs.removed).toEqual([]);
    expect(opfs.files.has('n@1')).toBe(true);
    expect(store.orphanKeys()).toEqual(['n@1']);

    await store.release('app_a');
    expect(opfs.removed).toEqual(['n@1']);
    expect(store.orphanKeys()).toEqual([]);
    expect(store.heldKeys('app_a')).toEqual([]);
  });

  it('保持者が 2 人なら、最後の 1 人の release まで残る', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await store.readBlob(ref, { holder: 'a' });
    await store.readBlob(ref, { holder: 'b' });
    await store.delete(ref);
    await store.release('a');
    expect(opfs.removed).toEqual([]);
    await store.release('b');
    expect(opfs.removed).toEqual(['n@1']);
  });

  it('release は、まだノードが参照している（delete されていない）鍵を消さない', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await store.readBlob(ref, { holder: 'a' });
    await store.release('a');
    expect(opfs.removed).toEqual([]);
    expect(opfs.files.has('n@1')).toBe(true);
  });

  it('holder 無しの readBlob は保持しない（読んですぐ展開する相手）', async () => {
    installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await store.readBlob(ref);
    expect(store.heldKeys('')).toEqual([]);
    await store.delete(ref);
    expect(store.orphanKeys()).toEqual([]);
  });
});

/** 外から開ける門。読みを途中で止めておくために使う */
function makeGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('展開する読みは、読み終わるまで鍵を保持する（T-0795）', () => {
  it('withBlob の途中で delete が通っても実体は残り、読み終わったところで消える', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    const gate = makeGate();
    const reading = store.withBlob(ref, async (blob) => {
      await gate.opened;
      return blob.text();
    });

    // 書き手が古い鍵を捨てる。読みの最中なので後回しになる
    await store.delete(ref);
    expect(opfs.removed).toEqual([]);
    expect(store.orphanKeys()).toEqual(['n@1']);

    gate.open();
    expect(await reading).toBe('a');
    expect(opfs.removed).toEqual(['n@1']);
    expect(store.orphanKeys()).toEqual([]);
  });

  it('withBlob は、呼んだ時点で（await より前に）保持している', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    const reading = store.withBlob(ref, (blob) => blob.text());
    // 同じ同期区間で delete を呼んでも、読みが先に保持を済ませている
    const deleting = store.delete(ref);
    expect(await reading).toBe('a');
    await deleting;
    expect(opfs.removed).toEqual(['n@1']);
  });

  it('use が投げても保持は残らない。まだノードが参照している鍵は消さない', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await expect(
      store.withBlob(ref, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(opfs.removed).toEqual([]);
    // 保持が残っていれば、ここで孤児に回る
    await store.delete(ref);
    expect(store.orphanKeys()).toEqual([]);
    expect(opfs.removed).toEqual(['n@1']);
  });

  it('readText / readBinary も同じ口を通り、読み終わったら保持を残さない', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'ab');
    expect(await store.readText(ref)).toBe('ab');
    expect(Array.from(await store.readBinary(ref))).toEqual([97, 98]);
    await store.delete(ref);
    expect(store.orphanKeys()).toEqual([]);
    expect(opfs.removed).toEqual(['n@1']);
  });

  it('VfsService.withBlob: 読んでいる間にファイルが書き直されても、読んでいる版の実体は読み終わるまで消えない', async () => {
    const opfs = installOpfs();
    const { vfs, nodeAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'a.txt', 'one');
    const id = nodeAt('a.txt')!.id;
    const gate = makeGate();
    const reading = vfs.withBlob(USER_PRINCIPAL, 'a.txt', async (blob, version) => {
      await gate.opened;
      return { text: await blob.text(), version };
    });

    await vfs.writeFile(USER_PRINCIPAL, 'a.txt', 'two', { overwrite: true });
    expect(opfs.files.has(`${id}@1`)).toBe(true);
    expect(opfs.removed).toEqual([]);

    gate.open();
    expect(await reading).toEqual({ text: 'one', version: 1 });
    expect(opfs.removed).toEqual([`${id}@1`]);
    expect(await vfs.readFile(USER_PRINCIPAL, 'a.txt')).toBe('two');
    expect(await vfs.readFileWithVersion(USER_PRINCIPAL, 'a.txt')).toEqual({ content: 'two', version: 2 });
  });

  it('中身の無いファイル（contentRef なし）は空の Blob で use を呼ぶ', async () => {
    installOpfs();
    const { vfs, nodeStore } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'e.txt', 'x');
    const id = (vfs as any).pathResolver.getIdByPath('e.txt');
    const node = nodeStore.getNode(id)!;
    await nodeStore.putNode({ ...node, contentRef: undefined });
    expect(await vfs.withBlob(USER_PRINCIPAL, 'e.txt', async (blob) => blob.size)).toBe(0);
    expect(await vfs.readFile(USER_PRINCIPAL, 'e.txt')).toBe('');
  });
});

describe('渡せなかった handle の保持は残さない（T-0795）', () => {
  it('holder 付きの readBlob が鍵の不在で失敗したら、その保持者の記録は残らない', async () => {
    installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    await expect(store.readBlob({ backend: 'opfs', key: 'gone@1' }, { holder: 'app_a' })).rejects.toThrow(
      'Content not found',
    );
    expect(store.heldKeys('app_a')).toEqual([]);
  });

  it('前からの保持（既に渡した handle のもの）は、後の失敗で外さない', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await store.readBlob(ref, { holder: 'app_a' });
    // 実体が外から失われた（サイトデータの消去など）。2 度目の読みは失敗する
    opfs.files.delete('n@1');
    await expect(store.readBlob(ref, { holder: 'app_a' })).rejects.toThrow('Content not found');
    expect(store.heldKeys('app_a')).toEqual(['n@1']);
  });

  it('失敗した readBlob だけが持っていた孤児は、その場で片付く', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const ref = await store.write('n@1', 'a');
    await store.readBlob(ref, { holder: 'app_a' });
    await store.delete(ref); // 孤児へ
    await store.release('app_a'); // 物理的に消える
    expect(opfs.removed).toEqual(['n@1']);
    await expect(store.readBlob(ref, { holder: 'app_b' })).rejects.toThrow('Content not found');
    expect(store.heldKeys('app_b')).toEqual([]);
    expect(store.orphanKeys()).toEqual([]);
  });
});

function makeVfs() {
  const nodeStore = new MemoryNodeStore();
  const contentStore = new ContentStore({ retryDelaysMs: [] });
  const vfs = new VfsService(nodeStore as any, contentStore, new PathResolver(nodeStore as any), new VfsEventBus());
  const nodeAt = (path: string) => {
    const id = (vfs as any).pathResolver.getIdByPath(path);
    return id ? nodeStore.getNode(id) : undefined;
  };
  const keyAt = (path: string) => nodeAt(path)?.contentRef?.key;
  return { vfs, nodeStore, contentStore, nodeAt, keyAt };
}

describe('WriteOps は常に新しい鍵へ書き、古い鍵は差し替えの後で捨てる', () => {
  it('write → overwrite で鍵が id@1 → id@2 に動き、同じ鍵への上書きは起きない', async () => {
    const opfs = installOpfs();
    const { vfs, nodeAt, keyAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'a.txt', 'one');
    const id = nodeAt('a.txt')!.id;
    expect(keyAt('a.txt')).toBe(`${id}@1`);

    await vfs.writeFile(USER_PRINCIPAL, 'a.txt', 'two', { overwrite: true });
    expect(keyAt('a.txt')).toBe(`${id}@2`);
    expect(await vfs.readFile(USER_PRINCIPAL, 'a.txt')).toBe('two');
    // 誰も持っていない古い鍵は消えている
    expect(opfs.removed).toEqual([`${id}@1`]);
    expect(opfs.overwrites()).toBe(0);
  });

  it('ゲストが holder 付きで読んだ実体は、別の書き手が上書きしても release まで読める', async () => {
    const opfs = installOpfs();
    const { vfs, nodeAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'img.png', 'PNG1');
    const id = nodeAt('img.png')!.id;
    const handle = await vfs.readBlob(USER_PRINCIPAL, 'img.png', { holder: 'app_a' });

    await vfs.writeFile(USER_PRINCIPAL, 'img.png', 'PNG2', { overwrite: true });
    // 新しい中身は新しい鍵。古い鍵は app_a が持っているので残る（上書きも削除もされていない）
    expect(opfs.files.has(`${id}@1`)).toBe(true);
    expect(opfs.removed).toEqual([]);
    expect(await handle.text()).toBe('PNG1');
    expect(await vfs.readFile(USER_PRINCIPAL, 'img.png')).toBe('PNG2');

    await vfs.releaseContent('app_a');
    expect(opfs.removed).toEqual([`${id}@1`]);
    expect(opfs.files.has(`${id}@2`)).toBe(true);
  });

  it('append も新しい鍵へ', async () => {
    const opfs = installOpfs();
    const { vfs, nodeAt, keyAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'log.txt', 'a');
    const id = nodeAt('log.txt')!.id;
    await vfs.appendFile(USER_PRINCIPAL, 'log.txt', 'b');
    expect(keyAt('log.txt')).toBe(`${id}@2`);
    expect(await vfs.readFile(USER_PRINCIPAL, 'log.txt')).toBe('a\nb');
    expect(opfs.removed).toEqual([`${id}@1`]);
  });

  it('stub 化（createStub）は保持者が居れば実体を残し、release で消す', async () => {
    const opfs = installOpfs();
    const { vfs, nodeAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 's.bin', 'S');
    const id = nodeAt('s.bin')!.id;
    const handle = await vfs.readBlob(USER_PRINCIPAL, 's.bin', { holder: 'app_a' });
    await vfs.createStub(USER_PRINCIPAL, 's.bin', { size: 1 });
    expect(nodeAt('s.bin')!.contentRef).toBeUndefined();
    expect(nodeAt('s.bin')!.meta.syncState).toBe('stub');
    expect(opfs.removed).toEqual([]);
    expect(await handle.text()).toBe('S');
    await vfs.releaseContent('app_a');
    expect(opfs.removed).toEqual([`${id}@1`]);
  });

  it('完全削除も保持者が居れば後回し', async () => {
    const opfs = installOpfs();
    const { vfs, nodeAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'd.txt', 'D');
    const id = nodeAt('d.txt')!.id;
    await vfs.readBlob(USER_PRINCIPAL, 'd.txt', { holder: 'app_a' });
    await vfs.deleteFile(USER_PRINCIPAL, 'd.txt', { permanent: true });
    expect(nodeAt('d.txt')).toBeUndefined();
    expect(opfs.removed).toEqual([]);
    await vfs.releaseContent('app_a');
    expect(opfs.removed).toEqual([`${id}@1`]);
  });

  it('copy は新しいノードの id@1 へ', async () => {
    installOpfs();
    const { vfs, nodeAt, keyAt } = makeVfs();
    await vfs.writeFile(USER_PRINCIPAL, 'c.txt', 'C');
    await vfs.copyFile(USER_PRINCIPAL, 'c.txt', 'c2.txt');
    const id2 = nodeAt('c2.txt')!.id;
    expect(id2).not.toBe(nodeAt('c.txt')!.id);
    expect(keyAt('c2.txt')).toBe(`${id2}@1`);
    expect(await vfs.readFile(USER_PRINCIPAL, 'c2.txt')).toBe('C');
  });
});

describe('VfsFsck と版付きの鍵', () => {
  const file = (id: string, name: string, version: number, key: string): VfsNode => ({
    id,
    name,
    parentId: null,
    kind: 'file',
    flags: { isSystem: false, isTrashed: false },
    meta: { size: 1, createdAt: 1, updatedAt: 1, version },
    acl: { owner: { type: 'user', id: 'me' }, rules: [] },
    contentRef: { backend: 'opfs', key },
  });

  it('ノードが別の版へ進んだ古い鍵は削除。旧形式（版なし）の鍵も同じ。版が新しい鍵は触らない。ノードの無い鍵は救出', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const nodeStore = new MemoryNodeStore();
    nodeStore.memoryMap.set('n1', file('n1', 'a.txt', 3, 'n1@3'));
    nodeStore.rebuildIndex();
    await store.write('n1@3', 'current');
    await store.write('n1@2', 'stale');
    await store.write('n1', 'legacy-stale');
    await store.write('n1@4', 'in-flight');
    await store.write('ghost@1', 'unknown');

    const report = await new VfsFsck(nodeStore as any, store).runRepair();

    expect(opfs.removed.filter((k) => k !== '__fsck_test__').sort()).toEqual(['n1', 'n1@2']);
    expect(report.staleContentsRemoved).toBe(2);
    expect(report.danglingContentsRescued).toBe(1);
    expect(report.missingContentsFixed).toBe(0);
    expect(opfs.files.has('n1@3')).toBe(true);
    expect(opfs.files.has('n1@4')).toBe(true);
    const rescued = [...nodeStore.memoryMap.values()].find((n) => n.name === 'recovered_file_ghost@1');
    expect(rescued?.contentRef?.key).toBe('ghost@1');
  });

  it('実体の欠けを補うときも id@版 の鍵に書く', async () => {
    const opfs = installOpfs();
    const store = new ContentStore({ retryDelaysMs: [] });
    const nodeStore = new MemoryNodeStore();
    nodeStore.memoryMap.set('n1', file('n1', 'a.txt', 5, 'n1@4'));
    nodeStore.rebuildIndex();
    const report = await new VfsFsck(nodeStore as any, store).runRepair();
    expect(report.missingContentsFixed).toBe(1);
    expect(nodeStore.getNode('n1')!.contentRef!.key).toBe('n1@5');
    expect(opfs.files.has('n1@5')).toBe(true);
  });
});
