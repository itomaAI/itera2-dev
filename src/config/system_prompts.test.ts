import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildSystemPrompt } from './system_prompts';
import { normalizeGuestPaths } from '../core/sys/GuestPaths';

describe('buildSystemPrompt', () => {
  it('includes memo always and thinking by default', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('<define_tag name="memo">');
    expect(p).toContain('<define_tag name="thinking">');
  });

  it('omits every trace of thinking when disabled', () => {
    const p = buildSystemPrompt({ thinkingTag: false });
    expect(p).toContain('<define_tag name="memo">');
    expect(p).not.toMatch(/thinking/i);
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
