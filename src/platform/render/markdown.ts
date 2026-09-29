/** Minimal Markdown → HTML renderer for generated reports (headings, tables, lists, code, links). */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

export function markdownToHtml(md: string, title: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,4} /.test(line)) {
      const level = line.indexOf(' ');
      const text = line.slice(level + 1);
      out.push(`<h${level} id="${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}">${inline(text)}</h${level}>`);
      i++;
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|[\s:|-]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split(' | ').map((c) => c.trim()));
        i++;
      }
      const [head, ...body] = rows;
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(esc(lines[i++]));
      i++;
      out.push(`<pre>${code.join('\n')}</pre>`);
    } else if (line.startsWith('> ')) {
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
      i++;
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
      i++;
    } else i++;
  }
  return page(title, out.join('\n'));
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;max-width:1100px;margin:24px auto;padding:0 20px;color:#1b1f24;line-height:1.45}
h1{border-bottom:3px solid #0176d3;padding-bottom:6px}h2{margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}th,td{border:1px solid #d8dde6;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f3f6f9}
code,pre{background:#f4f6f8;border-radius:3px;font-size:12px}pre{padding:10px;overflow:auto}blockquote{border-left:4px solid #0176d3;margin:10px 0;padding:6px 12px;background:#f3f8fd}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.kpi{border:1px solid #d8dde6;border-radius:6px;padding:12px}.kpi b{display:block;font-size:26px}
.bad{color:#ba0517}.warn{color:#8c4b02}.ok{color:#2e844a}.bar{height:10px;background:#e5e8ec;border-radius:5px;overflow:hidden}.bar>span{display:block;height:100%;background:#2e844a}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;background:#fef1cd;color:#8c4b02}
</style></head><body>${body}</body></html>`;
}
