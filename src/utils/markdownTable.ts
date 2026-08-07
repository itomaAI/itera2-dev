/**
 * src/utils/markdownTable.ts
 * Itera OS v2: Lightweight GFM Table Renderer
 *
 * NOTE: This is intentionally NOT a full Markdown parser. It only detects and
 * converts GitHub-Flavored-Markdown style pipe tables into <table> HTML,
 * leaving all other text completely untouched. This mirrors the existing
 * pragmatic, regex-based approach already used for code fences (see
 * ChatPanel._formatSystemMessage).
 *
 * IMPORTANT: The input text is expected to be ALREADY HTML-escaped
 * (e.g. via `escape()` in LpmlRenderer, or the manual replace chain in
 * ChatPanel._formatSystemMessage). Cell contents are inserted as-is (no
 * further escaping), consistent with how code blocks are handled elsewhere
 * in this codebase.
 */

const SEPARATOR_CELL = /^:?-+:?$/;

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !/-/.test(trimmed)) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed);
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

type Align = 'left' | 'center' | 'right' | '';

function getAlign(sepCell: string): Align {
  const left = sepCell.startsWith(':');
  const right = sepCell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

function buildTableHTML(headerCells: string[], aligns: Align[], bodyRows: string[][]): string {
  const alignStyle = (idx: number) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '');

  let html = '<div class="overflow-x-auto my-2"><table class="text-xs border-collapse w-full">';
  html += '<thead><tr>';
  headerCells.forEach((cell, idx) => {
    html += `<th class="border border-border-main px-2 py-1 bg-card/50 font-bold text-left"${alignStyle(idx)}>${cell}</th>`;
  });
  html += '</tr></thead><tbody>';

  bodyRows.forEach((row) => {
    html += '<tr>';
    headerCells.forEach((_, idx) => {
      const cell = row[idx] !== undefined ? row[idx] : '';
      html += `<td class="border border-border-main px-2 py-1 align-top"${alignStyle(idx)}>${cell}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  return html;
}

/**
 * Detects GFM pipe-tables within (already HTML-escaped) text and converts
 * them to styled <table> HTML. All other lines are returned untouched.
 *
 * A table block is recognized as:
 *   1. A "header" line containing at least one `|`.
 *   2. Immediately followed by a "separator" line (e.g. `--- | :---: | ---:`).
 *   3. Followed by zero or more non-blank "body" lines.
 *
 * The separator's column count must match the header's column count,
 * otherwise the block is left as plain text (matches common GFM behavior).
 */
export function renderMarkdownTables(text: string): string {
  if (!text || !text.includes('|')) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerLine = lines[i];
    const sepLine = lines[i + 1];

    if (headerLine && headerLine.includes('|') && sepLine !== undefined && isSeparatorLine(sepLine)) {
      const headerCells = splitRow(headerLine);
      const sepCells = splitRow(sepLine);

      if (
        headerCells.length > 0 &&
        sepCells.length === headerCells.length &&
        sepCells.every((c) => SEPARATOR_CELL.test(c))
      ) {
        const bodyRows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== '') {
          bodyRows.push(splitRow(lines[j]));
          j++;
        }

        const aligns = sepCells.map(getAlign);
        out.push(buildTableHTML(headerCells, aligns, bodyRows));
        i = j;
        continue;
      }
    }

    out.push(headerLine);
    i++;
  }

  return out.join('\n');
}
