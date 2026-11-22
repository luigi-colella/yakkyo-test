import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../../src/utils/markdown.js';

describe('renderMarkdown', () => {
  it('renders headings, lists, paragraphs and emphasis', () => {
    const html = renderMarkdown('## Layout\n\nTwo **columns**.\n\n- Header\n- Footer');

    expect(html).toContain('<h2>Layout</h2>');
    expect(html).toContain('<p>Two <strong>columns</strong>.</p>');
    expect(html).toMatch(/<ul>\s*<li>Header<\/li>\s*<li>Footer<\/li>\s*<\/ul>/);
  });

  it('wraps plain text in a paragraph', () => {
    expect(renderMarkdown('Clean layout').trim()).toBe('<p>Clean layout</p>');
  });

  it('removes scripts and event handlers', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<b onclick="alert(1)">bold</b>');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('<b>bold</b>');
  });

  it('removes images, so the description cannot load remote content', () => {
    const html = renderMarkdown(
      '![pixel](https://tracker.example/p.gif)\n\n<img src=x onerror=alert(1)>',
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('removes forms and styles', () => {
    const html = renderMarkdown('<style>body{display:none}</style><form><input></form>text');

    expect(html).not.toMatch(/<(style|form|input)/);
  });

  it('drops javascript: links and opens the others in a new tab without opener', () => {
    const html = renderMarkdown('[bad](javascript:alert(1)) [good](https://example.com)');

    expect(html).not.toContain('javascript:');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">good</a>',
    );
  });
});
