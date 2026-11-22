import DOMPurify from 'dompurify';
import { marked } from 'marked';

// The description comes from a language model that looked at a third-party page:
// it is untrusted, so the HTML produced from it is always sanitized before rendering.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Renders the Markdown design description as sanitized HTML, safe for `v-html`. */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  return DOMPurify.sanitize(html, {
    // No remote images (tracking pixels), styles or forms in the description.
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'button'],
  });
}
