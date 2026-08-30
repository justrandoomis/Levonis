/** Splits a SQL script into statements, honouring string literals, `--` line
 *  comments and block comments. Shared by the migration harness and tests. */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += ch;
      i++;
      while (i < sql.length) {
        buf += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { buf += sql[++i]; i++; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ';') { out.push(buf.trim()); buf = ''; i++; continue; }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
