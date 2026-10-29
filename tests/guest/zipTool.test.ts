/**
 * tests/guest/zipTool.test.ts
 * zip の道具（system/services/zip_tool.html）と、その部品 system/lib/zip_core.js（T-0712）
 *
 * 守りたいこと:
 *   - 作った zip を読み戻すと同じ中身（store / deflate、CRC の照合、日時）
 *   - 名前の符号: UTF-8 旗つきはそのまま、旗の無い cp932 の名前も読める（Windows の zip）、Unicode Path extra を信じる
 *   - 危険な名前（`..`・絶対パス・ドライブ文字）は VFS に書かない。zip64・暗号化は断る
 *   - デーモンは VFS だけで完結する（偽の MetaOS で往復する。実装はコピーしない）
 *   - 常駐しない（services.json で autoStart: false）、道具の定義は英語、system prompt が道具を案内する
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadCore(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = { exports: {} };
  new Function('module', 'window', read('vfs_root/system/lib/zip_core.js'))(mod, undefined);
  return mod.exports;
}
const Z = loadCore();
const enc = new TextEncoder();
const dec = new TextDecoder();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- 偽の VFS（メモリ）: 試験の対象は zip の道具であって VFS ではない ----
type Node = { kind: 'file'; data: Uint8Array; updatedAt: number } | { kind: 'directory' };
class FakeFs {
  nodes = new Map<string, Node>();
  constructor() {
    this.nodes.set('', { kind: 'directory' });
  }
  put(path: string, data: Uint8Array | string, updatedAt = Date.now()) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    this.mkdir(path.slice(0, Math.max(0, path.lastIndexOf('/'))), { recursive: true });
    this.nodes.set(path, { kind: 'file', data: bytes, updatedAt });
  }
  text(path: string) {
    const n = this.nodes.get(path);
    if (!n || n.kind !== 'file') throw new Error('no file ' + path);
    return dec.decode(n.data);
  }
  async exists(path: string) {
    return this.nodes.has(path);
  }
  async stat(path: string) {
    const n = this.nodes.get(path);
    if (!n) throw new Error('ENOENT ' + path);
    return n.kind === 'file' ? { kind: 'file', size: n.data.length, updatedAt: n.updatedAt } : { kind: 'directory' };
  }
  async read(path: string, opts?: { encoding?: string }) {
    const n = this.nodes.get(path);
    if (!n || n.kind !== 'file') throw new Error('ENOENT ' + path);
    return opts?.encoding === 'binary' ? n.data : dec.decode(n.data);
  }
  async write(path: string, data: Uint8Array, opts?: { overwrite?: boolean; meta?: { updatedAt?: number } }) {
    if (this.nodes.has(path) && !opts?.overwrite) throw new Error('EEXIST ' + path);
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (!this.nodes.has(dir)) throw new Error('ENOENT parent ' + dir);
    this.nodes.set(path, { kind: 'file', data: data, updatedAt: opts?.meta?.updatedAt ?? Date.now() });
  }
  mkdir(path: string, _opts?: { recursive?: boolean }) {
    const segs = path.split('/').filter(Boolean);
    let cur = '';
    for (const s of segs) {
      cur = cur ? cur + '/' + s : s;
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: 'directory' });
    }
    return Promise.resolve();
  }
  async list(dir: string) {
    const out: string[] = [];
    for (const k of this.nodes.keys()) {
      if (!k || k === dir) continue;
      const parent = k.slice(0, Math.max(0, k.lastIndexOf('/')));
      if (parent === dir) out.push(k.split('/').pop() as string);
    }
    return out.sort();
  }
  async getUsage() {
    return { used: 0, max: 1 << 30, reserved: 0 };
  }
}

/** デーモンの <script> を評価し、登録された道具の handler を返す（実装をコピーしない） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadDaemon(fs: FakeFs): Record<string, (p: any) => Promise<string>> {
  const html = read('vfs_root/system/services/zip_tool.html');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('zip_tool.html に <script> が無い');
  const tools: Record<string, (p: unknown) => Promise<string>> = {};
  const logs: string[] = [];
  const win = {
    ZipCore: Z,
    MetaOS: {
      fs,
      ai: { log: (msg: string) => logs.push(msg) },
      tools: {
        register: (t: { name: string; handler: (p: unknown) => Promise<string> }) => (tools[t.name] = t.handler),
        unregister: () => undefined,
      },
    },
    addEventListener: () => undefined,
  };
  new Function('window', m[1])(win);
  if (!tools.zip_list || !tools.zip_extract || !tools.zip_create) throw new Error('道具が登録されなかった');
  return tools;
}

describe('zip_core: 書いて読む', () => {
  it('crc32 は IEEE（"123456789" → cbf43926）', () => {
    expect(Z.crc32(enc.encode('123456789')).toString(16)).toBe('cbf43926');
  });
  it('store と deflate の項目を往復し、日時（2 秒刻み）とディレクトリの印が残る', async () => {
    const text = enc.encode('hello zip '.repeat(200));
    const compressed = await Z.deflateRaw(text);
    expect(compressed.length).toBeLessThan(text.length);
    const when = new Date(2026, 9, 26, 14, 30, 42);
    const zip = Z.buildZip([
      { name: 'app/' },
      { name: 'app/日本語.txt', data: text, method: 8, compressed, mtime: when },
      { name: 'app/raw.bin', data: new Uint8Array([1, 2, 3]), method: 0 },
    ]);
    const cd = Z.readCentralDirectory(zip);
    expect(cd.entries.map((e: { name: string; dir: boolean; method: number }) => [e.name, e.dir, e.method])).toEqual([
      ['app/', true, 0],
      ['app/日本語.txt', false, 8],
      ['app/raw.bin', false, 0],
    ]);
    expect(cd.entries[1].encoding).toBe('utf-8');
    expect(cd.entries[1].mtime.getTime()).toBe(when.getTime());
    expect(same(await Z.extractEntry(zip, cd.entries[1]), text)).toBe(true);
    expect(same(await Z.extractEntry(zip, cd.entries[2]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it('extractEntry は store の項目でも zip 全体への view ではなく写しを返す（hash が zip 本体の値に化けない）', async () => {
    const zip = Z.buildZip([{ name: 'small.txt', data: enc.encode('tiny'), method: 0 }]);
    const { entries } = Z.readCentralDirectory(zip);
    const data = await Z.extractEntry(zip, entries[0]);
    expect(same(data, enc.encode('tiny'))).toBe(true);
    expect(data.byteOffset).toBe(0);
    expect(data.buffer.byteLength).toBe(data.byteLength);
    expect(data.buffer).not.toBe(zip.buffer);
  });

  it('壊れたデータは CRC で分かる', async () => {
    const data = enc.encode('abcdefgh');
    const zip = Z.buildZip([{ name: 'a.txt', data, method: 0 }]);
    const cd = Z.readCentralDirectory(zip);
    const { start } = Z.localDataRange(zip, cd.entries[0]);
    zip[start] ^= 0xff;
    await expect(Z.extractEntry(zip, cd.entries[0])).rejects.toThrow(/CRC mismatch/);
  });
  it('zip でないもの・zip64・暗号化は断る', async () => {
    expect(() => Z.readCentralDirectory(enc.encode('not a zip at all, really not'))).toThrow(/Not a zip/);
    const zip = Z.buildZip([{ name: 'a.txt', data: enc.encode('x'), method: 0 }]);
    const z64 = new Uint8Array(zip);
    const eocd = z64.length - 22;
    z64[eocd + 10] = 0xff;
    z64[eocd + 11] = 0xff; // total entries = 0xffff → zip64
    expect(() => Z.readCentralDirectory(z64)).toThrow(/Zip64/);
    const encd = new Uint8Array(zip);
    const cd = Z.readCentralDirectory(encd);
    const p = encd.length - 22 - (46 + 5); // central entry の先頭（名前 5 文字）
    encd[p + 8] |= 0x01; // flags: encrypted
    const cd2 = Z.readCentralDirectory(encd);
    expect(cd2.entries[0].encrypted).toBe(true);
    await expect(Z.extractEntry(encd, cd2.entries[0])).rejects.toThrow(/Encrypted/);
    expect(cd.entries[0].encrypted).toBe(false);
  });
});

describe('zip_core: 名前', () => {
  const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x2e, 0x74, 0x78, 0x74]); // 日本.txt (cp932)
  it('旗の無い cp932 の名前は shift_jis で、旗があれば UTF-8 で、ASCII はそのまま', () => {
    expect(Z.decodeName(sjis, 0, new Uint8Array(0))).toEqual({ name: '日本.txt', encoding: 'shift_jis' });
    expect(Z.decodeName(enc.encode('日本.txt'), 0x800, new Uint8Array(0))).toEqual({
      name: '日本.txt',
      encoding: 'utf-8',
    });
    expect(Z.decodeName(enc.encode('日本.txt'), 0, new Uint8Array(0))).toEqual({ name: '日本.txt', encoding: 'utf-8' });
    expect(Z.decodeName(enc.encode('a.txt'), 0, new Uint8Array(0))).toEqual({ name: 'a.txt', encoding: 'ascii' });
    expect(Z.decodeName(sjis, 0, new Uint8Array(0), { encoding: 'utf-8' }).encoding).toBe('utf-8');
  });
  it('Info-ZIP Unicode Path（0x7075）は元の名前の CRC が合うときだけ信じる', () => {
    const u = enc.encode('日本.txt');
    const mk = (crc: number) => {
      const x = new Uint8Array(4 + 5 + u.length);
      const dv = new DataView(x.buffer);
      dv.setUint16(0, 0x7075, true);
      dv.setUint16(2, 5 + u.length, true);
      x[4] = 1;
      dv.setUint32(5, crc, true);
      x.set(u, 9);
      return x;
    };
    const legacy = enc.encode('NIHON.TXT');
    expect(Z.decodeName(legacy, 0, mk(Z.crc32(legacy))).name).toBe('日本.txt');
    expect(Z.decodeName(legacy, 0, mk(0)).name).toBe('NIHON.TXT');
  });
  it('safeName: .. と絶対パスとドライブ文字は null、区切りは / に、末尾の / は保つ', () => {
    expect(Z.safeName('../x')).toBeNull();
    expect(Z.safeName('a/../../x')).toBeNull();
    expect(Z.safeName('/etc/passwd')).toBe('etc/passwd');
    expect(Z.safeName('C:\\x\\y.txt')).toBe('x/y.txt');
    expect(Z.safeName('a//b\\c/')).toBe('a/b/c/');
    expect(Z.safeName('./a/./b')).toBe('a/b');
    expect(Z.safeName('.')).toBeNull();
    expect(Z.stripComponents('app/x/y', 1)).toBe('x/y');
    expect(Z.stripComponents('app/', 1)).toBeNull();
  });
  it('glob: 名前そのもの・その下・**・*・?', () => {
    expect(Z.matchesAny('app/x/y.js', ['app'])).toBe(true);
    expect(Z.matchesAny('application/x', ['app'])).toBe(false);
    expect(Z.matchesAny('app/x/y.js', ['app/'])).toBe(true);
    expect(Z.matchesAny('app/x/y.js', ['**/*.js'])).toBe(true);
    expect(Z.matchesAny('app/x/y.js', ['*.js'])).toBe(false);
    expect(Z.matchesAny('y.js', ['*.js'])).toBe(true);
    expect(Z.matchesAny('a/b.txt', ['a/?.txt'])).toBe(true);
    expect(Z.matchesAny('node_modules/x/y', ['node_modules', '**/*.log'])).toBe(true);
  });
  it('buildZip は危険な名前と重複を断る', () => {
    expect(() => Z.buildZip([{ name: '../x', data: new Uint8Array(0) }])).toThrow(/Unsafe/);
    expect(() =>
      Z.buildZip([
        { name: 'a', data: new Uint8Array(0) },
        { name: 'a', data: new Uint8Array(0) },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe('zip_tool デーモン（偽の VFS で往復）', () => {
  it('zip_create → zip_list → zip_extract で同じ木が戻る（既定は隣の同名ディレクトリ・先頭のフォルダは src の名前）', async () => {
    const fs = new FakeFs();
    fs.put('data/app/index.html', '<html>app</html>'.repeat(30), new Date(2026, 0, 2, 3, 4, 6).getTime());
    fs.put('data/app/lib/日本語.js', 'const x = 1;');
    fs.put('data/app/img/px.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    fs.mkdir('data/app/empty', { recursive: true });
    const t = loadDaemon(fs);
    const created = await t.zip_create({ src: 'data/app' });
    expect(created).toMatch(/^Wrote: data\/app\.zip \(3 file\(s\)/);
    expect(created).toContain('top folder "app/"');
    expect(fs.nodes.get('data/app.zip')?.kind).toBe('file');

    const listed = await t.zip_list({ path: 'data/app.zip' });
    expect(listed).toContain('data/app.zip: 4 entries (3 files, 1 directories)'); // ディレクトリの項目は空のものだけ
    expect(listed).toContain('  app/index.html');
    expect(listed).toContain('  app/lib/日本語.js');
    expect(listed).toContain('  app/empty/');
    expect(listed).toContain('everything is under "app/"; pass strip="1"');
    expect(listed).toContain('Default out: data/app/.');

    const extracted = await t.zip_extract({ path: 'data/app.zip', out: 'out/here', strip: '1' });
    expect(extracted).toMatch(/^Extracted: 3 file\(s\)/);
    expect(fs.text('out/here/index.html')).toBe('<html>app</html>'.repeat(30));
    expect(fs.text('out/here/lib/日本語.js')).toBe('const x = 1;');
    expect(
      same(
        (fs.nodes.get('out/here/img/px.png') as { data: Uint8Array }).data,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      ),
    ).toBe(true);
    expect(fs.nodes.get('out/here/empty')?.kind).toBe('directory');
    // 日時は zip のもの（2 秒刻み）
    expect((fs.nodes.get('out/here/index.html') as { updatedAt: number }).updatedAt).toBe(
      new Date(2026, 0, 2, 3, 4, 6).getTime(),
    );

    // strip 無しなら先頭のフォルダごと、既定の out
    const again = await t.zip_extract({ path: 'data/app.zip', out: 'out/two' });
    expect(again).toContain('everything went under out/two/app/');
    expect(fs.text('out/two/app/lib/日本語.js')).toBe('const x = 1;');
  });
  it('only で絞る・既にあるものは overwrite 無しでは残す・出力は自分を入れない', async () => {
    const fs = new FakeFs();
    fs.put('p/a.md', 'A');
    fs.put('p/b.md', 'B');
    fs.put('p/c.txt', 'C');
    fs.put('p/old.zip', new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const t = loadDaemon(fs);
    const created = await t.zip_create({ src: 'p', out: 'p/p.zip', prefix: '', exclude: '*.zip' });
    expect(created).toContain('3 file(s)');
    expect(created).toContain('no top folder');
    fs.put('q/a.md', 'already here');
    const r = await t.zip_extract({ path: 'p/p.zip', out: 'q', only: '*.md' });
    expect(r).toMatch(/^Extracted: 1 file\(s\)/);
    expect(r).toContain('Already there, not overwritten');
    expect(r).toContain('Not matching only="*.md": 1');
    expect(fs.text('q/a.md')).toBe('already here');
    expect(fs.text('q/b.md')).toBe('B');
    expect(await fs.exists('q/c.txt')).toBe(false);
    const r2 = await t.zip_extract({ path: 'p/p.zip', out: 'q', only: 'a.md', overwrite: 'true' });
    expect(r2).toMatch(/^Extracted: 1 file\(s\)/);
    expect(fs.text('q/a.md')).toBe('A');
    // only は strip 後の名前にも当たる（先頭フォルダを落として "*.md" と書ける）
    await t.zip_create({ src: 'p', out: 'p/top.zip', exclude: '*.zip' });
    const r3 = await t.zip_extract({ path: 'p/top.zip', out: 'r', strip: '1', only: '*.md' });
    expect(r3).toMatch(/^Extracted: 2 file\(s\)/);
    expect(fs.text('r/b.md')).toBe('B');
    expect(await fs.exists('r/c.txt')).toBe(false);
    expect(await t.zip_extract({ path: 'p/top.zip', out: 'r2', only: '*.md' })).toMatch(
      /^\[Error\] Nothing to extract .*\*\*\/\*\.md/,
    );
  });
  it('危険な名前の項目は書かない・cp932 の名前を読む・zip でないファイルは [Error]', async () => {
    const fs = new FakeFs();
    const zip = Z.buildZip([
      { name: 'ok/safe.txt', data: enc.encode('safe'), method: 0 },
      { name: 'ok/XXXXXXX', data: enc.encode('evil'), method: 0 }, // あとで名前を ../evil に書き換える
    ]);
    // 名前の書き換え（ローカルヘッダと central の両方。長さは同じ 10 文字）
    const from = enc.encode('ok/XXXXXXX');
    const to = enc.encode('../../evil');
    for (let i = 0; i + from.length <= zip.length; i++) {
      if (same(zip.subarray(i, i + from.length), from)) zip.set(to, i);
    }
    fs.put('z/bad.zip', zip);
    // cp932 の名前（旗なし）を持つ zip を手で組む: buildZip は UTF-8 旗を立てるので、旗を落とし名前を差し替える
    const sj = Z.buildZip([{ name: 'XXXXXXXX', data: enc.encode('sjis'), method: 0 }]);
    const sjName = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x2e, 0x74, 0x78, 0x74]); // 日本.txt
    for (let i = 0; i + 8 <= sj.length; i++) {
      if (same(sj.subarray(i, i + 8), enc.encode('XXXXXXXX'))) {
        sj.set(sjName, i);
        // 旗（名前の 24 bytes 前がローカル、44 bytes 前が central）
        if (sj[i - 30] === 0x50 && sj[i - 29] === 0x4b) sj[i - 30 + 6] = sj[i - 30 + 7] = 0;
        if (sj[i - 46] === 0x50 && sj[i - 45] === 0x4b) sj[i - 46 + 8] = sj[i - 46 + 9] = 0;
      }
    }
    fs.put('z/sjis.zip', sj);
    fs.put('z/not.zip', 'this is plain text pretending to be a zip, long enough');
    const t = loadDaemon(fs);
    const r = await t.zip_extract({ path: 'z/bad.zip' });
    expect(r).toMatch(/^Extracted: 1 file\(s\)/);
    expect(r).toContain('Skipped unsafe names: ../../evil');
    expect(fs.text('z/bad/ok/safe.txt')).toBe('safe');
    expect(await fs.exists('evil')).toBe(false);
    expect([...fs.nodes.keys()].some((k) => k.includes('evil'))).toBe(false);

    const l = await t.zip_list({ path: 'z/sjis.zip' });
    expect(l).toContain('  日本.txt');
    expect(l).toContain('1 read as shift_jis');
    const r2 = await t.zip_extract({ path: 'z/sjis.zip', out: 'z/sj' });
    expect(r2).toMatch(/^Extracted: 1 file\(s\)/);
    expect(fs.text('z/sj/日本.txt')).toBe('sjis');

    expect(await t.zip_list({ path: 'z/not.zip' })).toMatch(/^\[Error\] Not a zip/);
    expect(await t.zip_list({ path: 'z/missing.zip' })).toMatch(/^\[Error\] Not found/);
    expect(await t.zip_create({ src: 'z/nothing' })).toMatch(/^\[Error\] Not found/);
  });
});

describe('置き場と配線', () => {
  it('3 つの道具を登録し、部品を /system/lib から読み、常駐しない', () => {
    const daemon = read('vfs_root/system/services/zip_tool.html');
    for (const n of ['zip_list', 'zip_extract', 'zip_create']) expect(daemon).toContain(`name: '${n}'`);
    expect(daemon).toContain('<script src="/system/lib/zip_core.js">');
    expect(daemon).not.toContain('window.top.location');
    const reg = JSON.parse(read('vfs_root/system/registry/services.json'));
    expect(reg.find((s: { id: string }) => s.id === 'zip_tool')).toMatchObject({
      autoStart: false,
      path: 'system/services/zip_tool.html',
    });
  });
  it('道具の定義（define_tag）は英語（Itera の見えるところは英語）', () => {
    const daemon = read('vfs_root/system/services/zip_tool.html');
    const defs = daemon.slice(daemon.indexOf('const DEF = {'), daemon.indexOf('const defs = '));
    expect(defs).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
  });
  it('system prompt と read の断り文が zip_tool を案内する', () => {
    const sp = read('src/config/system_prompts.ts');
    expect(sp).toContain('system/services/zip_tool.html');
    expect(sp).toContain('zip_extract');
    expect(read('src/core/control/tools/fs_tools.ts')).toContain('zip_list → zip_extract');
    expect(read('src/config/attachment_policy.ts')).toContain("'application/zip'");
  });
});
