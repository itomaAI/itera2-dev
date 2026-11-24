/**
 * src/core/state/sessionBundleIo.test.ts
 * 会話を VFS のディレクトリとして出し入れする手順（T-0908）。
 *
 * OS のチャットの会話での通し（保存 → 読み込み）は SessionManager.test.ts に在る。ここで見るのは、
 * 手順が「どの会話のものか」に依らないこと —— 添付の置き場が `system/temp/sessions/` でなくても同じに動く。
 */
import { describe, expect, it } from 'vitest';
import type { Turn } from './HistoryManager';
import { SYSTEM_PRINCIPAL, type Principal } from '../vfs/types';
import { buildSessionExport } from './sessionArchive';
import { collectBundleMedia, copyBundleMedia, readSessionBundle, restoreBundleMedia } from './sessionBundleIo';

const APP: Principal = { type: 'app', id: 'viewer' };

/** 中身は文字列で持つ。誰の主体で読み書きしたかを残す */
class FakeVfs {
  files = new Map<string, string>();
  writes: Array<{ by: string; path: string; system: boolean }> = [];
  reads: Array<{ by: string; path: string }> = [];
  failOn = new Set<string>();
  private isDir(path: string) {
    return [...this.files.keys()].some((k) => k.startsWith(`${path}/`));
  }
  exists(_p: Principal, path: string) {
    return this.files.has(path) || this.isDir(path);
  }
  stat(_p: Principal, path: string): any {
    if (this.files.has(path)) {
      return { kind: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, hash: `h:${this.files.get(path)}` };
    }
    if (this.isDir(path)) return { kind: 'directory', name: path.slice(path.lastIndexOf('/') + 1), path };
    throw new Error(`File not found: ${path}`);
  }
  listFiles(_p: Principal, options: { path: string }): any[] {
    const prefix = `${options.path}/`;
    const names = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
    return [...names].sort().map((n) => this.stat(SYSTEM_PRINCIPAL, `${prefix}${n}`));
  }
  async readFile(p: Principal, path: string) {
    this.reads.push({ by: `${p.type}:${p.id}`, path });
    if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
    return this.files.get(path)!;
  }
  async readBlob(p: Principal, path: string) {
    if (this.failOn.has(path)) throw new Error('unreadable');
    return new Blob([await this.readFile(p, path)]);
  }
  async writeFile(p: Principal, path: string, content: string | Blob, options: { system?: boolean }) {
    this.writes.push({ by: `${p.type}:${p.id}`, path, system: options.system === true });
    this.files.set(path, typeof content === 'string' ? content : await content.text());
  }
}

const media = (path: string) => ({ media: { path, mimeType: 'image/png', metadata: {} } });
const turn = (content: Turn['content']): Turn => ({ id: 't1', timestamp: 5, role: 'user', content, meta: {} });

const DIR = 'system/temp/engines/eng-1';

describe('collectBundleMedia — 同梱する添付を集める', () => {
  it('置き場の全ファイルと、会話が参照する system/temp/ の下のもの。ほかの場所への参照は入れない', () => {
    const vfs = new FakeVfs();
    vfs.files.set(`${DIR}/shot.png`, 'A');
    vfs.files.set(`${DIR}/unreferenced.txt`, 'B');
    vfs.files.set('system/temp/sessions/s9/old.png', 'C');
    vfs.files.set('data/docs/big.pdf', 'D');
    const turns = [
      turn([
        media(`${DIR}/shot.png`),
        media('system/temp/sessions/s9/old.png'),
        media('system/temp/sessions/s9/gone.png'),
        media('data/docs/big.pdf'),
      ]),
    ];
    expect([...collectBundleMedia(vfs, DIR, turns)]).toEqual([
      ['shot.png', `${DIR}/shot.png`],
      ['unreferenced.txt', `${DIR}/unreferenced.txt`],
      ['old.png', 'system/temp/sessions/s9/old.png'],
    ]);
  });

  it('名前が重なれば、置き場のものが勝つ', () => {
    const vfs = new FakeVfs();
    vfs.files.set(`${DIR}/a.png`, 'MINE');
    vfs.files.set('system/temp/sessions/s9/a.png', 'OTHER');
    const sources = collectBundleMedia(vfs, DIR, [turn([media('system/temp/sessions/s9/a.png')])]);
    expect(sources.get('a.png')).toBe(`${DIR}/a.png`);
  });

  it('置き場が無い（null・まだ作られていない）会話でも、参照から集める', () => {
    const vfs = new FakeVfs();
    vfs.files.set('system/temp/sessions/s9/a.png', 'X');
    const turns = [turn([media('system/temp/sessions/s9/a.png')])];
    expect([...collectBundleMedia(vfs, null, turns).keys()]).toEqual(['a.png']);
    expect([...collectBundleMedia(vfs, 'system/temp/engines/none', turns).keys()]).toEqual(['a.png']);
  });
});

describe('copyBundleMedia — 保存先の media/ に写す', () => {
  it('置き場は OS の主体で読み、保存先は頼んだ者の主体で書く。同じ中身が在れば飛ばす', async () => {
    const vfs = new FakeVfs();
    vfs.files.set(`${DIR}/a.png`, 'A');
    vfs.files.set(`${DIR}/b.png`, 'B');
    vfs.files.set('data/x/media/a.png', 'A'); // 既に同じ中身
    const sources = new Map([
      ['a.png', `${DIR}/a.png`],
      ['b.png', `${DIR}/b.png`],
    ]);
    expect(await copyBundleMedia(vfs, APP, sources, 'data/x/media')).toBe(1);
    expect(vfs.writes).toEqual([{ by: 'app:viewer', path: 'data/x/media/b.png', system: false }]);
    expect(vfs.reads).toEqual([{ by: 'system:kernel', path: `${DIR}/b.png` }]);
  });

  it('中身が違えば書き直す。1 つ写せなくても残りは続ける', async () => {
    const vfs = new FakeVfs();
    vfs.files.set(`${DIR}/a.png`, 'NEW');
    vfs.files.set(`${DIR}/b.png`, 'B');
    vfs.files.set(`${DIR}/c.png`, 'C');
    vfs.files.set('data/x/media/a.png', 'OLD');
    vfs.failOn.add(`${DIR}/b.png`);
    const sources = new Map(['a.png', 'b.png', 'c.png'].map((n) => [n, `${DIR}/${n}`]));
    expect(await copyBundleMedia(vfs, APP, sources, 'data/x/media')).toBe(2);
    expect(vfs.files.get('data/x/media/a.png')).toBe('NEW');
    expect(vfs.files.has('data/x/media/b.png')).toBe(false);
    expect(vfs.files.get('data/x/media/c.png')).toBe('C');
  });
});

describe('readSessionBundle / restoreBundleMedia — 保存された会話を読む', () => {
  const saved = (turns: Turn[]) => JSON.stringify(buildSessionExport({ id: 's1', createdAt: 1, title: 'T' }, turns, 9));

  it('ディレクトリ・その中の session.json・旧形式の単一ファイルのどれでも読める', async () => {
    const vfs = new FakeVfs();
    vfs.files.set('data/x/session.json', saved([turn('hi')]));
    vfs.files.set('data/old.json', saved([turn('old')]));
    const a = await readSessionBundle(vfs, APP, 'data/x/');
    const b = await readSessionBundle(vfs, APP, 'data/x/session.json');
    const c = await readSessionBundle(vfs, APP, 'data/old.json');
    expect(a).toMatchObject({ ok: true, bundleDir: 'data/x', parsed: { id: 's1', title: 'T' } });
    expect(b).toMatchObject({ ok: true, bundleDir: 'data/x' });
    expect(c).toMatchObject({ ok: true, bundleDir: null });
    // 読むのは頼んだ者の主体
    expect(new Set(vfs.reads.map((r) => r.by))).toEqual(new Set(['app:viewer']));
  });

  it('無い・形が違えば、理由を付けて断る', async () => {
    const vfs = new FakeVfs();
    vfs.files.set('data/bad.json', '{"format":"something-else"}');
    vfs.files.set('data/empty/other.txt', 'x');
    expect(await readSessionBundle(vfs, APP, 'data/none')).toMatchObject({ ok: false });
    expect(await readSessionBundle(vfs, APP, 'data/bad.json')).toMatchObject({ ok: false });
    expect(await readSessionBundle(vfs, APP, 'data/empty')).toMatchObject({ ok: false });
    for (const r of [
      await readSessionBundle(vfs, APP, 'data/none'),
      await readSessionBundle(vfs, APP, 'data/bad.json'),
    ]) {
      expect(r.ok === false && r.detail.length > 0).toBe(true);
    }
  });

  it('同梱の添付を置き場へ写し（書くのは OS の主体）、参照を付け替える。置き場はどこでもよい', async () => {
    const vfs = new FakeVfs();
    vfs.files.set('data/x/media/shot.png', 'A');
    vfs.files.set('data/x/media/memo.txt', 'M');
    const turns = [
      turn([
        media('system/temp/sessions/s1/shot.png'),
        { text: '<user_attachment name="memo.txt" path="system/temp/sessions/s1/memo.txt">M</user_attachment>' },
        media('system/temp/sessions/s1/missing.png'),
        media('data/docs/big.pdf'),
      ]),
    ];
    const out = await restoreBundleMedia(vfs, APP, 'data/x', DIR, turns);
    expect(vfs.files.get(`${DIR}/shot.png`)).toBe('A');
    expect(vfs.files.get(`${DIR}/memo.txt`)).toBe('M');
    expect(vfs.writes.every((w) => w.by === 'system:kernel' && w.system)).toBe(true);
    const content = out[0].content as any[];
    expect(content[0].media.path).toBe(`${DIR}/shot.png`);
    expect(content[1].text).toContain(`path="${DIR}/memo.txt"`);
    // 同梱に無いもの・一時領域の外への参照は、そのまま
    expect(content[2].media.path).toBe('system/temp/sessions/s1/missing.png');
    expect(content[3].media.path).toBe('data/docs/big.pdf');
    // 元のターンは書き換えない
    expect((turns[0].content as any[])[0].media.path).toBe('system/temp/sessions/s1/shot.png');
  });

  it('同梱が無ければ、ターンはそのまま（旧形式・media/ の無い保存）', async () => {
    const vfs = new FakeVfs();
    const turns = [turn([media('system/temp/sessions/s1/shot.png')])];
    expect(await restoreBundleMedia(vfs, APP, null, DIR, turns)).toBe(turns);
    expect(await restoreBundleMedia(vfs, APP, 'data/nomedia', DIR, turns)).toBe(turns);
    expect(vfs.writes).toEqual([]);
  });
});
