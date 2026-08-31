import { describe, it, expect, vi } from 'vitest';
import { CognitiveManager } from './CognitiveManager';

/**
 * LLM アダプタの作り直しは「llm.json が変わったとき」に一度だけ配線する（T-0313）。
 *
 * 背景: かつて作り直しは入口（チャット送信・ai.ask・ai.task・ai.log(trigger)）に散っていた。
 * 設定を変えても次にそれらの入口を通るまで旧モデルのまま走り、
 * ツール結果からの継続や set_timer の起床では反映されなかった。
 * Engine はステップごとに `this.llm` を読むので、変更の持ち主（ConfigManager）が知らせた時点で
 * 差し替えれば足りる。
 */

/** ConfigManager の代わり。購読者を覚えて、こちらから鳴らせるだけ */
function makeConfigManager() {
  const listeners: Array<(config: any, changed: ReadonlySet<string>) => void> = [];
  return {
    listeners,
    onUpdate(cb: (config: any, changed: ReadonlySet<string>) => void) {
      listeners.push(cb);
      return () => {};
    },
    get: (_category: string) => ({ model: 'custom/x' }),
    fire(changed: string[]) {
      for (const cb of listeners) cb({}, new Set(changed));
    },
  };
}

function makeManager() {
  const configManager = makeConfigManager();
  const manager = new CognitiveManager(configManager as any, {} as any, {} as any, {} as any);
  const refresh = vi.spyOn(manager, 'refreshEngineConfig').mockResolvedValue();
  return { configManager, manager, refresh };
}

describe('CognitiveManager.start — llm.json の変更で作り直す', () => {
  it('llm が変わったときに refreshEngineConfig を呼ぶ', () => {
    const { configManager, manager, refresh } = makeManager();
    manager.start();
    configManager.fire(['llm']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('llm 以外のカテゴリが変わっても作り直さない', () => {
    const { configManager, manager, refresh } = makeManager();
    manager.start();
    configManager.fire(['appearance']);
    configManager.fire(['preferences', 'network']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('複数カテゴリが同時に変わり、その中に llm があれば作り直す', () => {
    const { configManager, manager, refresh } = makeManager();
    manager.start();
    configManager.fire(['preferences', 'llm', 'network']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('start を呼ぶまでは購読しない（作った時点では何も起きない）', () => {
    const { configManager, refresh } = makeManager();
    expect(configManager.listeners).toHaveLength(0);
    configManager.fire(['llm']);
    expect(refresh).not.toHaveBeenCalled();
  });
});
