import type { ReactNode } from "react";

function inline(text: string): ReactNode[] {
  let occurrence = 0;
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      occurrence += 1;
      return <code key={`${part}-${occurrence}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      occurrence += 1;
      return <strong key={`${part}-${occurrence}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

/** A deliberately small reader for the maintained, human-facing docs.
 * These documents are prose first; this is not a general Markdown product
 * renderer. Unsupported constructs remain readable text rather than creating a
 * second documentation format that can drift from the source file. */
export function MarkdownPage({ source }: { source: string }) {
  const lines = source.split("\n");
  const content: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let table: string[][] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      content.push(
        <p
          className="design-doc-paragraph text-body text-secondary"
          key={`p-${content.length}`}
        >
          {inline(paragraph.join(" "))}
        </p>,
      );
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      content.push(
        <ul className="design-doc-list" key={`l-${content.length}`}>
          {list.map((item) => (
            <li className="text-body text-secondary" key={item}>
              {inline(item)}
            </li>
          ))}
        </ul>,
      );
      list = [];
    }
  };

  /**
   * A pipe table, as the two reference tables in DESIGN.md are written.
   *
   * These are the layer contract and the step-to-job map — the material a person
   * comes to look up. Skipping `|` lines hid them; rendering them as prose
   * printed the `|---|` separator as text. Both are rows, so both get a row.
   */
  const flushTable = () => {
    if (table.length) {
      const [head, ...body] = table;
      content.push(
        <table className="design-doc-table" key={`t-${content.length}`}>
          <thead>
            <tr>
              {(head ?? []).map((cell) => (
                <th className="text-body-sm text-tertiary" key={cell}>
                  {inline(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row) => (
              <tr key={row.join("|")}>
                {/* A cell can repeat within a row, so its column name keys it. */}
                {columns(head, row).map(({ column, cell }) => (
                  <td className="text-body text-secondary" key={column}>
                    {inline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      table = [];
    }
  };

  /** `|---|---|` carries no content; it only marks the row above as the header. */
  const isSeparator = (line: string) => /^\|[\s|:-]+\|$/.test(line.trim());

  /** Pairs each cell with its heading, so a repeated value still keys uniquely. */
  const columns = (head: string[] | undefined, row: string[]) =>
    row.map((cell, index) => ({
      column: head?.[index] ?? `column-${index}`,
      cell,
    }));

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flushParagraph();
      flushList();
      flushTable();
      content.push(
        <header className="design-doc-title" key={`h1-${content.length}`}>
          <h1 className="text-title text-primary">{line.slice(2)}</h1>
        </header>,
      );
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      flushTable();
      content.push(
        <h2
          className="design-doc-heading text-heading text-primary"
          key={`h2-${content.length}`}
        >
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith("- ")) {
      flushParagraph();
      flushTable();
      list.push(line.slice(2));
    } else if (line.trim().startsWith("|")) {
      flushParagraph();
      flushList();
      if (!isSeparator(line)) table.push(cells(line));
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
      flushTable();
    } else if (!line.startsWith("```")) {
      flushTable();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  flushTable();

  return <article className="design-doc">{content}</article>;
}
