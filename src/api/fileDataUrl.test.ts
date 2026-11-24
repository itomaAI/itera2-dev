// @vitest-environment jsdom
/**
 * MetaOS.fs.read の encoding: 'dataurl' が返す data URL の種別（T-0906）。
 * 実体の Blob は種別を持たない（ContentStore）ので、種別はパスの拡張子から付く —— resolveUrl と同じ表。
 */
import { describe, expect, it } from 'vitest';
import { fileDataUrl } from './fileDataUrl';
import { guestMimeOf } from '../shell/windowing/GuestCompiler';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe('fileDataUrl', () => {
  it('種別を持たない実体でも、.png は image/png の data URL になる（中身はそのまま）', async () => {
    const url = await fileDataUrl(new Blob([bytes(PNG_B64)]), 'data/img/a.png');
    expect(url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('拡張子の大文字小文字は問わない', async () => {
    const url = await fileDataUrl(new Blob([bytes(PNG_B64)]), 'data/img/A.PNG');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('種別は実体ではなくパスから決まる（文字として書かれた実体でも）', async () => {
    const url = await fileDataUrl(new Blob(['<svg/>'], { type: 'text/plain' }), 'data/x.svg');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('表に無い拡張子・拡張子なしは application/octet-stream', async () => {
    for (const path of ['data/x.unknownext', 'data/noext']) {
      const url = await fileDataUrl(new Blob([bytes(PNG_B64)]), path);
      expect(url, path).toBe(`data:application/octet-stream;base64,${PNG_B64}`);
    }
  });

  it('resolveUrl と同じ表を見る（どの拡張子でも、頭は guestMimeOf の値）', async () => {
    for (const ext of ['jpg', 'jpeg', 'gif', 'webp', 'pdf', 'json', 'md', 'mp3', 'wasm']) {
      const url = await fileDataUrl(new Blob(['x']), `data/f.${ext}`);
      expect(url.startsWith(`data:${guestMimeOf(`f.${ext}`)};base64,`), ext).toBe(true);
    }
  });
});
