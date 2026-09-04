import { Marked, type Token, type Tokens } from "marked";

export interface TocEntry {
  id: string;
  text: string;
}

export interface RenderedDoc {
  /** Text of the leading H1, stripped from `bodyHtml` and shown as the page title instead. */
  title: string;
  bodyHtml: string;
  /** Every h2 in the page, in document order, for the "On this page" list. */
  toc: TocEntry[];
  /** Plain text of the first paragraph, for the page's meta description. */
  description: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Recursively flattens an inline token tree (text, strong, em, link, codespan, ...) to plain
 *  text, for heading ids, the "On this page" list and the meta description. */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((t) => {
      const withTokens = t as { tokens?: Token[] };
      if (Array.isArray(withTokens.tokens)) return plainText(withTokens.tokens);
      const withText = t as { text?: string };
      return typeof withText.text === "string" ? withText.text : "";
    })
    .join("");
}

/** Renders one docs markdown page: strips the leading H1, ids every heading, wraps tables for
 *  horizontal scroll, and collects h2 headings + the first paragraph for the page shell. */
export function renderDoc(markdown: string): RenderedDoc {
  const seen = new Map<string, number>();
  const toc: TocEntry[] = [];

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(token: Tokens.Heading) {
        const text = plainText(token.tokens);
        const base = slugify(text) || "section";
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n + 1}`;
        if (token.depth === 2) toc.push({ id, text });
        return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      table(token: Tokens.Table) {
        const headerCell = (c: Tokens.TableCell) =>
          `<th${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`;
        const bodyCell = (c: Tokens.TableCell) =>
          `<td${c.align ? ` align="${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`;
        const header = `<tr>${token.header.map(headerCell).join("")}</tr>`;
        const rows = token.rows.map((row) => `<tr>${row.map(bodyCell).join("")}</tr>`).join("\n");
        return `<div class="docs-table"><table>\n<thead>\n${header}\n</thead>\n<tbody>\n${rows}\n</tbody>\n</table></div>\n`;
      },
    },
  });

  const tokens = marked.lexer(markdown);

  let title = "";
  const h1Index = tokens.findIndex((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1);
  if (h1Index !== -1) {
    title = plainText((tokens[h1Index] as Tokens.Heading).tokens);
    tokens.splice(h1Index, 1);
  }

  const firstParagraph = tokens.find((t): t is Tokens.Paragraph => t.type === "paragraph");
  const description = firstParagraph ? plainText(firstParagraph.tokens) : "";

  const bodyHtml = marked.parser(tokens);

  return { title, bodyHtml, toc, description };
}
