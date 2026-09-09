import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildSystemPrompt } from './system_prompts';

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
});
