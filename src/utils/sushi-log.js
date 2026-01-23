/**
 * Parses SUSHI log files and returns a list of error entries with file/line information
 */
export function parseSushiLog(logContent) {
  const entries = [];
  const lines = logContent.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const errorMatch = line.match(/^\s*error\s+(.*)$/i);
    if (!errorMatch) {
      index += 1;
      continue;
    }

    const entry = { message: errorMatch[1], file: null, line: null, endLine: null };
    index += 1;

    while (index < lines.length) {
      const detailMatch = lines[index].match(/^\s{2,}(.*)$/);
      if (!detailMatch) {
        break;
      }
      const detail = detailMatch[1].trim();
      const fileMatch = detail.match(/^File:\s*(.+)$/i);
      if (fileMatch) {
        entry.file = fileMatch[1];
      }
      // Parse single line (e.g., "Line: 122") or line range (e.g., "Line: 122 - 124")
      const lineRangeMatch = detail.match(/^Line:\s*(\d+)\s*-\s*(\d+)$/i);
      const lineMatch = detail.match(/^Line:\s*(\d+)$/i);
      if (lineRangeMatch) {
        entry.line = Number.parseInt(lineRangeMatch[1], 10);
        entry.endLine = Number.parseInt(lineRangeMatch[2], 10);
      } else if (lineMatch) {
        entry.line = Number.parseInt(lineMatch[1], 10);
      }
      index += 1;
    }

    entries.push(entry);
  }

  return entries;
}
