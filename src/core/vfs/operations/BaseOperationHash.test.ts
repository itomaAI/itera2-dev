import { describe, it, expect } from 'vitest';
import { BaseOperation } from './BaseOperation';

/**
 * src/core/vfs/operations/BaseOperationHash.test.ts
 * calculateHash は渡された Uint8Array の **範囲だけ** を hash する（T-0716）
 *
 * ゲストが大きな束の subarray（byteOffset つきの view）を writeFile に渡すと、中身は Blob が view を
 * 尊重するので正しく保存されるが、hash が `.buffer` を見ていたため束全体の値になっていた。
 * zip の道具で無圧縮の項目を展開すると、各ファイルの hash が zip 本体の hash と同じになる、として見つかった。
 */
describe('BaseOperation.calculateHash', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const op: any = Object.create(BaseOperation.prototype);
  const hashOf = (c: string | Uint8Array | Blob): Promise<string> => op.calculateHash(c);

  it('byteOffset つきの view の hash は、その範囲を写した配列の hash と同じ', async () => {
    const whole = new Uint8Array(64);
    for (let i = 0; i < whole.length; i++) whole[i] = (i * 37) & 0xff;
    const view = whole.subarray(10, 30);
    expect(view.byteOffset).toBe(10);
    expect(await hashOf(view)).toBe(await hashOf(view.slice()));
    expect(await hashOf(view)).not.toBe(await hashOf(whole));
  });

  it('同じ中身なら 文字列・Uint8Array・Blob で同じ hash', async () => {
    const text = 'hello, zip';
    const bytes = new TextEncoder().encode(text);
    const h = await hashOf(text);
    expect(await hashOf(bytes)).toBe(h);
    expect(await hashOf(new Blob([bytes]))).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
