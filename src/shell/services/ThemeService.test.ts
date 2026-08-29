// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ThemeService } from './ThemeService';
import type { ConfigUpdateListener } from '../../core/sys/ConfigManager';

/**
 * 購読者は「自分に関わる変化か」を自分で決める（T-0304）。
 *
 * ThemeService が見ているのは appearance だけである。
 * モデル名を変えただけでテーマを読み直しても、同じ絵を描き直すことにしかならない。
 */
function makeService() {
  const listeners: ConfigUpdateListener[] = [];
  const configManager: any = { onUpdate: (cb: ConfigUpdateListener) => listeners.push(cb) };
  const service = new ThemeService(configManager, {} as any);
  service.start();

  let applied = 0;
  (service as any).applyAppearance = async () => {
    applied++;
  };
  return { listeners, applied: () => applied };
}

describe('ThemeService: 自分に関わる変化にだけ反応する', () => {
  const appearance = { theme: 'system/themes/dark.json' } as any;

  it('appearance が変わっていなければ、テーマを貼り直さない', async () => {
    const { listeners, applied } = makeService();

    await listeners[0]({ appearance } as any, new Set(['llm']));

    expect(applied()).toBe(0);
  });

  it('appearance が変わったときは貼り直す', async () => {
    const { listeners, applied } = makeService();

    await listeners[0]({ appearance } as any, new Set(['appearance']));

    expect(applied()).toBe(1);
  });
});
