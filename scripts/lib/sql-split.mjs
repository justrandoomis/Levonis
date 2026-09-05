/** Splits a SQL script into statements, honouring string literals, `--` line
 *  comments, block comments and compound statements. Shared by the migration
 *  harness and tests.
 *
 *  A trigger body is `BEGIN <statement>; <statement>; END;` — semicolons that
 *  are NOT statement boundaries. wrangler's own splitter (src/d1/splitter)
 *  tracks BEGIN/CASE … END for exactly this reason; this one follows the same
 *  rule so a migration proves the same thing locally that it will do on D1. */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let depth = 0; // open BEGIN/CASE blocks
  let i = 0;
  const opens = (s) => /\s(BEGIN|CASE)\s$/i.test(s);
  const closes = (s) => /\sEND[;\s]$/i.test(s);
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
    if (closes(buf + ch) && depth > 0) depth--;
    if (ch === ';' && depth === 0) { out.push(buf.trim()); buf = ''; i++; continue; }
    buf += ch;
    if (opens(buf)) depth++;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
