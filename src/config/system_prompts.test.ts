import { describe, it, expect } from 'vitest';
import { ROLE_PARTS, SYSTEM_PROMPT, buildSystemPrompt } from './system_prompts';
import { normalizeGuestPaths } from '../core/sys/GuestPaths';

describe('buildSystemPrompt', () => {
  it('includes memo always and thinking only when asked (default off since T-0856)', () => {
    const p = buildSystemPrompt({ thinkingTag: true });
    expect(p).toContain('<define_tag name="memo">');
    expect(p).toContain('<define_tag name="thinking">');
  });

  it('omits every trace of thinking by default and when disabled', () => {
    for (const p of [buildSystemPrompt(), buildSystemPrompt({ thinkingTag: false })]) {
      expect(p).toContain('<define_tag name="memo">');
      expect(p).not.toMatch(/thinking/i);
    }
  });

  it('SYSTEM_PROMPT equals the default build', () => {
    expect(SYSTEM_PROMPT).toBe(buildSystemPrompt());
  });

  it('names the boot document from paths.json and never hard-codes memory/ (T-0614)', () => {
    const paths = normalizeGuestPaths({
      agent: { home: 'brain', init: 'brain/start.md' },
      user: { home: 'stuff' },
    }).paths;
    const p = buildSystemPrompt({ paths });
    expect(p).toContain('You MUST read `brain/start.md`');
    expect(p).toContain('<rule name="guest_layout">');
    expect(p).toContain('`brain/`');
    expect(p).toContain("The user's area: `stuff/`");
    expect(p).not.toMatch(/memory\//);
  });

  it('without a boot document it says so instead of pointing at a file', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('declares no boot document');
    expect(p).not.toContain('<rule name="guest_layout">');
    expect(p).not.toMatch(/memory\//);
  });
});

describe('buildSystemPrompt の役割（T-0908）— 共通の部分に、役割ごとの部分が差さる', () => {
  const paths = normalizeGuestPaths({
    agent: { home: 'brain', init: 'brain/start.md', scratch: 'brain/tmp' },
    user: { home: 'stuff', sessions: 'stuff/talks' },
  }).paths;

  it('役割を省けば root（OS のチャットのエンジン）', () => {
    expect(buildSystemPrompt({ paths })).toBe(buildSystemPrompt({ paths, role: 'root' }));
  });

  it('sub には起動手順が無く、起動の文書を指さない', () => {
    const p = buildSystemPrompt({ paths, role: 'sub' });
    expect(p).toContain('You are a **sub engine** of Itera OS');
    expect(p).toContain('<rule name="start">');
    expect(p).not.toContain('<rule name="boot_protocol">');
    expect(p).not.toContain('Initialization Protocol');
    expect(p).not.toContain('brain/start.md');
    expect(p).not.toContain('kept in the session history');
    // 自分の領域・利用者の領域は、ルートと同じに見える
    expect(p).toContain('Your own area (only you write here; others read): `brain/`');
    expect(p).toContain("The user's area: `stuff/`");
  });

  it('違うのは役割の部分だけ: root の文を sub の文に替えると、sub のプロンプトになる', () => {
    const { root, sub } = ROLE_PARTS;
    for (const thinkingTag of [false, true]) {
      let p = buildSystemPrompt({ paths, thinkingTag, role: 'root' });
      const swap = (from: string, to: string) => {
        expect(p.split(from)).toHaveLength(2); // ちょうど 1 か所
        p = p.replace(from, () => to);
      };
      swap(root.identity, sub.identity);
      swap(root.resetKeeps, sub.resetKeeps);
      swap(root.resetThen, sub.resetThen);
      swap('- Your boot document: `brain/start.md`\n', '');
      swap(root.start(paths), sub.start(paths));
      expect(p).toBe(buildSystemPrompt({ paths, thinkingTag, role: 'sub' }));
    }
  });

  it('役割の文は、名前と言語の穴をそのまま持つ（投影が埋める）', () => {
    for (const role of ['root', 'sub'] as const) {
      const p = buildSystemPrompt({ role });
      expect(p).toContain('{{agentName}}');
      expect(p).toContain('{{username}}');
      expect(p).toContain('{{language}}');
    }
  });
});
