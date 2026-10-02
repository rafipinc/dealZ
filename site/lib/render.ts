// Markdown to HTML for the sections of a published decision record.
// Links between records become site links. Every other relative link is dropped to
// plain text, because its target (a research note, a source file) is not published.
// Images become their alt text and raw HTML is escaped, for the same reason.

import { Marked } from "marked";

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
  renderer: {
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      // A record links to another as a sibling file or through an `adr/` folder, nothing else.
      const adr = /^(?:\.\/)?(?:(?:\.\.\/)*(?:docs\/)?adr\/)?(\d{4})-[^/]*\.md(?:#.*)?$/.exec(token.href);
      if (adr) return `<a href="/decisions/${adr[1]}/">${text}</a>`;
      if (/^https?:\/\//.test(token.href)) return `<a href="${escapeHtml(token.href)}" rel="noreferrer">${text}</a>`;
      return text;
    },
    image(token) {
      return escapeHtml(token.text);
    },
    html(token) {
      return escapeHtml(token.text);
    },
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false }).trim();
}
