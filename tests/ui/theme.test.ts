import { readFileSync } from 'node:fs';
import { applyTheme } from '../../src/ui/theme';

describe('applyTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it.each(['auto', 'light', 'dark'] as const)('puts "%s" into data-theme of the given root', (theme) => {
    const root = document.createElement('div');
    applyTheme(theme, root);
    expect(root.getAttribute('data-theme')).toBe(theme);
  });

  it('defaults to the document element and replaces the previous value', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('theme.css', () => {
  const css = readFileSync('src/ui/theme.css', 'utf8');
  const body = (pattern: RegExp): string => {
    const match = pattern.exec(css);
    if (!match?.[1]) throw new Error(`No block for ${pattern}`);
    return match[1];
  };
  const declarations = (block: string): Record<string, string> =>
    Object.fromEntries(
      [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().replace(/\s+/g, ' ')]),
    );

  const light = declarations(body(/:root\s*\{([^}]*)\}/));
  const dark = declarations(body(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/));
  const auto = declarations(
    body(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\[data-theme="auto"\]\s*\{([^}]*)\}/),
  );

  it('defines the colour tokens on :root', () => {
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(8);
  });

  it('gives every colour token a dark value for [data-theme="dark"]', () => {
    const colours = Object.keys(light).filter((name) => name.startsWith('--tc-color-'));
    expect(colours.length).toBeGreaterThan(0);
    expect(Object.keys(dark).sort()).toEqual(colours.sort());
  });

  it('uses the same dark values for [data-theme="auto"] under prefers-color-scheme: dark', () => {
    expect(auto).toEqual(dark);
  });
});
