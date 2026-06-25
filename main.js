const { Plugin, Notice } = require('obsidian');

const TITLE_RE = /^\s*%%\s*table-title:\s*([\s\S]*?)\s*%%\s*$/;
const NOTE_RE = /^\s*%%\s*table-note:\s*([\s\S]*?)\s*%%\s*$/;
const META_ANY_RE = /^\s*%%\s*table-(?:title|note):\s*[\s\S]*?%%\s*$/;

class TableToolsPlugin extends Plugin {
  async onload() {
    this.addStyle();
    new Notice('Table Tools loaded ✓');

    // 在实时预览/源码里隐藏 %% table-title: ... %% 这一行（光标在该行时显形）
    try {
      const ext = buildTitleHider();
      if (ext) this.registerEditorExtension(ext);
    } catch (e) {
      console.error('Table Tools: 隐藏标题注释的编辑器扩展加载失败', e);
    }

    // 阅读模式 / Live Preview：渲染后处理（ctx 可定位源码行）
    this.registerMarkdownPostProcessor((el, ctx) => {
      el.querySelectorAll('table:not(.tt-done)').forEach((t) => this.enhance(t, ctx));
    });

    // 兜底：监听 DOM（无 ctx）
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.body, { childList: true, subtree: true });

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        setTimeout(() => this.scan(), 300);
      })
    );

    this._onResize = () => this.relayoutAll();
    window.addEventListener('resize', this._onResize);

    this.addCommand({
      id: 'process-tables',
      name: '处理当前页面的表格',
      callback: () => {
        const before = document.querySelectorAll('table:not(.tt-done)').length;
        this.scan();
        new Notice(`已处理 ${before} 个表格`);
      },
    });

    this.app.workspace.onLayoutReady(() => setTimeout(() => this.scan(), 500));
  }

  onunload() {
    this.observer?.disconnect();
    window.removeEventListener('resize', this._onResize);
    document.querySelectorAll('.tt-wrapper').forEach((wrapper) => {
      const table = wrapper.querySelector('table');
      if (table) {
        table.classList.remove('tt-done');
        wrapper.replaceWith(table);
      }
    });
    document.getElementById('tt-style')?.remove();
  }

  scan() {
    document
      .querySelectorAll(
        '.markdown-preview-view table:not(.tt-done), .markdown-source-view table:not(.tt-done), .view-content table:not(.tt-done)'
      )
      .forEach((t) => this.enhance(t, null));
  }

  enhance(table, ctx) {
    if (table.classList.contains('tt-done')) return;
    if (!table.rows || table.rows.length === 0) return;
    if (table.closest('.tt-wrapper')) return;
    table.classList.add('tt-done');

    const wrapper = document.createElement('div');
    wrapper.className = 'tt-wrapper';
    wrapper.dataset.ttTitle = '';
    table.parentNode.insertBefore(wrapper, table);

    // 标题（表格正上方、同宽）
    const titleEl = this.makeMetaEl(wrapper, table, ctx, 'title');
    wrapper.appendChild(titleEl);

    wrapper.appendChild(table);

    const numLayer = document.createElement('div');
    numLayer.className = 'tt-numlayer';
    wrapper.appendChild(numLayer);

    // 备注（表格下方、独立元素，不影响表格加行）
    const noteEl = this.makeMetaEl(wrapper, table, ctx, 'note');
    wrapper.appendChild(noteEl);

    // 工具栏
    const toolbar = document.createElement('div');
    toolbar.className = 'tt-toolbar';
    const imgBtn = document.createElement('button');
    imgBtn.className = 'tt-btn';
    imgBtn.title = '复制为图片';
    imgBtn.innerHTML = SVG_IMAGE;
    imgBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyAsImage(wrapper, table);
    });
    const mdBtn = document.createElement('button');
    mdBtn.className = 'tt-btn';
    mdBtn.title = '复制为 Markdown 表格';
    mdBtn.innerHTML = SVG_COPY;
    mdBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyAsMarkdown(table, wrapper);
    });
    toolbar.appendChild(imgBtn);
    toolbar.appendChild(mdBtn);
    wrapper.appendChild(toolbar);

    this.layoutNumbers(wrapper, table, numLayer);
    this.loadMeta(table, ctx, wrapper, titleEl, 'title');
    this.loadMeta(table, ctx, wrapper, noteEl, 'note');

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => this.layoutNumbers(wrapper, table, numLayer));
      ro.observe(table);
      wrapper._ttRO = ro;
    }
  }

  // 创建可编辑的标题/备注元素
  makeMetaEl(wrapper, table, ctx, kind) {
    const dataKey = kind === 'title' ? 'ttTitle' : 'ttNote';
    const el = document.createElement('div');
    el.className = `tt-meta tt-${kind} tt-empty`;
    el.setAttribute('contenteditable', 'false');
    el.spellcheck = false;
    el.dataset.ph = kind === 'title' ? '＋ 添加表格标题' : '＋ 添加备注';

    el.addEventListener('click', () => {
      if (el.getAttribute('contenteditable') === 'true') return;
      el.setAttribute('contenteditable', 'true');
      el.classList.remove('tt-empty');
      el.textContent = wrapper.dataset[dataKey] || '';
      el.focus();
      const sel = document.getSelection();
      if (sel) sel.selectAllChildren(el);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        el.textContent = wrapper.dataset[dataKey] || '';
        el.blur();
      }
    });
    el.addEventListener('blur', async () => {
      el.setAttribute('contenteditable', 'false');
      const text = (el.textContent || '').replace(/\n/g, ' ').trim();
      const old = wrapper.dataset[dataKey] || '';
      if (text !== old) await this.saveMeta(table, ctx, wrapper, text, kind);
      el.textContent = text;
      el.classList.toggle('tt-empty', !text);
    });
    return el;
  }

  bodyRows(table) {
    if (table.tBodies && table.tBodies.length) return Array.from(table.tBodies[0].rows);
    return Array.from(table.rows).slice(1);
  }

  layoutNumbers(wrapper, table, numLayer) {
    const rows = this.bodyRows(table);
    numLayer.innerHTML = '';
    const wrect = wrapper.getBoundingClientRect();
    rows.forEach((tr, i) => {
      const r = tr.getBoundingClientRect();
      if (r.height === 0) return;
      const span = document.createElement('span');
      span.className = 'tt-rownum';
      span.textContent = String(i + 1);
      span.style.top = r.top - wrect.top + r.height / 2 + 'px';
      numLayer.appendChild(span);
    });
  }

  relayoutAll() {
    document.querySelectorAll('.tt-wrapper').forEach((wrapper) => {
      const table = wrapper.querySelector('table');
      const numLayer = wrapper.querySelector('.tt-numlayer');
      if (table && numLayer) this.layoutNumbers(wrapper, table, numLayer);
    });
  }

  // ---------- 源码定位 ----------
  domTableIndex(table) {
    const view = table.closest('.markdown-reading-view, .markdown-source-view, .view-content');
    if (!view) return -1;
    return Array.from(view.querySelectorAll('table')).indexOf(table);
  }

  async resolveLoc(table, ctx) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');
    let start = -1;
    let end = -1;
    if (ctx && ctx.getSectionInfo) {
      const info = ctx.getSectionInfo(table);
      if (info) {
        if (typeof info.lineStart === 'number') start = info.lineStart;
        if (typeof info.lineEnd === 'number') end = info.lineEnd;
      }
    }
    if (start < 0 || end < 0) {
      const blocks = findTableBlocks(lines);
      const idx = this.domTableIndex(table);
      if (idx >= 0 && blocks[idx]) {
        if (start < 0) start = blocks[idx].start;
        if (end < 0) end = blocks[idx].end;
      }
    }
    if (start < 0) return null;
    if (end < 0) end = start;
    return { file, lines, start, end };
  }

  metaRe(kind) {
    return kind === 'title' ? TITLE_RE : NOTE_RE;
  }
  metaLabel(kind) {
    return kind === 'title' ? 'table-title' : 'table-note';
  }

  // 读取某个表格的标题/备注/列宽（原始字符串）
  async readMeta(table, ctx, kind) {
    const loc = await this.resolveLoc(table, ctx);
    if (!loc) return '';
    const { lines, start, end } = loc;
    const re = this.metaRe(kind);
    const idx = kind === 'note' ? findMetaBelow(lines, end, re) : findMetaAbove(lines, start, re);
    if (idx < 0) return '';
    const m = lines[idx].match(re);
    return m ? m[1].trim() : '';
  }

  // 写回笔记
  async writeMeta(table, ctx, kind, newText) {
    newText = (newText || '').replace(/\n/g, ' ').trim();
    const loc = await this.resolveLoc(table, ctx);
    if (!loc) {
      new Notice('无法定位表格，未保存');
      return;
    }
    const { file, lines, start, end } = loc;
    const re = this.metaRe(kind);
    const lineText = `%% ${this.metaLabel(kind)}: ${newText} %%`;

    if (kind === 'note') {
      const idx = findMetaBelow(lines, end, re);
      if (newText) {
        if (idx >= 0) lines[idx] = lineText;
        else {
          lines.splice(end + 1, 0, '', lineText);
          const after = end + 3;
          if (lines[after] !== undefined && lines[after].trim() !== '') lines.splice(after, 0, '');
        }
      } else if (idx >= 0) {
        lines.splice(idx, 1);
        if (idx - 1 > end && lines[idx - 1] !== undefined && lines[idx - 1].trim() === '') {
          lines.splice(idx - 1, 1);
        }
      }
    } else {
      // 标题 / 列宽：放在表格上方
      const idx = findMetaAbove(lines, start, re);
      if (newText) {
        if (idx >= 0) lines[idx] = lineText;
        else {
          const ins = [];
          if (start > 0 && lines[start - 1].trim() !== '') ins.push('');
          ins.push(lineText, '');
          lines.splice(start, 0, ...ins);
        }
      } else if (idx >= 0) {
        lines.splice(idx, 1);
        if (lines[idx] !== undefined && lines[idx].trim() === '') lines.splice(idx, 1);
      }
    }

    await this.app.vault.modify(file, lines.join('\n'));
  }

  async loadMeta(table, ctx, wrapper, el, kind) {
    try {
      const text = await this.readMeta(table, ctx, kind);
      wrapper.dataset[kind === 'title' ? 'ttTitle' : 'ttNote'] = text;
      el.textContent = text;
      el.classList.toggle('tt-empty', !text);
    } catch (e) {
      /* ignore */
    }
  }

  async saveMeta(table, ctx, wrapper, newText, kind) {
    await this.writeMeta(table, ctx, kind, newText);
    wrapper.dataset[kind === 'title' ? 'ttTitle' : 'ttNote'] = (newText || '').replace(/\n/g, ' ').trim();
  }

  // ---------- 复制为 Markdown ----------
  copyAsMarkdown(table, wrapper) {
    try {
      let md = tableToMarkdown(table);
      const title = wrapper && wrapper.dataset ? wrapper.dataset.ttTitle : '';
      const note = wrapper && wrapper.dataset ? wrapper.dataset.ttNote : '';
      if (title) md = `**${title}**\n\n` + md;
      if (note) md = md + `\n\n*${note}*`;
      navigator.clipboard.writeText(md).then(
        () => new Notice('已复制为 Markdown 表格'),
        () => new Notice('复制失败：剪贴板不可用')
      );
    } catch (err) {
      console.error(err);
      new Notice('复制失败');
    }
  }

  // ---------- 复制为图片 ----------
  async copyAsImage(wrapper, table) {
    const toolbar = wrapper.querySelector('.tt-toolbar');
    // 截图时隐藏：工具栏、以及空的标题/备注占位
    const hidden = [];
    if (toolbar) hidden.push([toolbar, toolbar.style.display]);
    wrapper.querySelectorAll('.tt-meta.tt-empty').forEach((m) => hidden.push([m, m.style.display]));
    hidden.forEach(([elm]) => (elm.style.display = 'none'));
    try {
      new Notice('正在生成图片…');
      const blob = await domToPngBlob(wrapper);
      if (!blob) throw new Error('no blob');
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        new Notice('表格图片已复制到剪贴板');
      } else {
        const buf = await blob.arrayBuffer();
        const name = `table-${Date.now()}.png`;
        await this.app.vault.createBinary(name, buf);
        new Notice(`剪贴板不可用，已保存为 ${name}`);
      }
    } catch (err) {
      console.error(err);
      new Notice('生成图片失败，请重试');
    } finally {
      hidden.forEach(([elm, prev]) => (elm.style.display = prev));
    }
  }

  addStyle() {
    const style = document.createElement('style');
    style.id = 'tt-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
}

// ====================== 工具函数 ======================

function tableToMarkdown(table) {
  const rows = Array.from(table.rows);
  const lines = [];
  rows.forEach((tr, ri) => {
    const cells = Array.from(tr.cells).map((td) =>
      (td.innerText || td.textContent || '')
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|')
        .trim()
    );
    lines.push('| ' + cells.join(' | ') + ' |');
    if (ri === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
  });
  return lines.join('\n');
}

// 向上跳过空行和其它 table-* 注释，找到匹配 re 的注释行
function findMetaAbove(lines, start, re) {
  let i = start - 1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '') {
      i--;
      continue;
    }
    if (META_ANY_RE.test(lines[i])) {
      if (re.test(lines[i])) return i;
      i--;
      continue;
    }
    break;
  }
  return -1;
}

// 向下跳过空行和其它 table-* 注释
function findMetaBelow(lines, end, re) {
  let i = end + 1;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') {
      i++;
      continue;
    }
    if (META_ANY_RE.test(lines[i])) {
      if (re.test(lines[i])) return i;
      i++;
      continue;
    }
    break;
  }
  return -1;
}

function findTableBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const isRow = /^\s*\|.*\|\s*$/.test(lines[i]);
    const nextSep =
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-');
    if (isRow && nextSep) {
      const start = i;
      let j = i;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') j++;
      blocks.push({ start, end: j - 1 });
      i = j;
    } else i++;
  }
  return blocks;
}

// 用 CodeMirror 扩展隐藏整行的 %% table-title: ... %% 注释
function buildTitleHider() {
  let ViewPlugin, Decoration, RangeSetBuilder;
  try {
    ({ ViewPlugin, Decoration } = require('@codemirror/view'));
    ({ RangeSetBuilder } = require('@codemirror/state'));
  } catch (e) {
    return null;
  }
  if (!ViewPlugin || !Decoration || !RangeSetBuilder) return null;

  const hideDeco = Decoration.line({ class: 'tt-hidden-comment' });
  const LINE_RE = /^\s*%%\s*table-(?:title|note):\s*[\s\S]*?%%\s*$/;

  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = this.build(u.view);
        }
      }
      build(view) {
        const builder = new RangeSetBuilder();
        const sel = view.state.selection.main;
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            if (LINE_RE.test(line.text)) {
              const cursorHere = sel.from <= line.to && sel.to >= line.from;
              if (!cursorHere) builder.add(line.from, line.from, hideDeco);
            }
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
  return plugin;
}

function inlineStyles(src, dst) {
  const cs = getComputedStyle(src);
  let css = '';
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    css += `${p}:${cs.getPropertyValue(p)};`;
  }
  dst.style.cssText = css;
  const sc = src.children;
  const dc = dst.children;
  for (let i = 0; i < sc.length; i++) if (dc[i]) inlineStyles(sc[i], dc[i]);
}

async function domToPngBlob(node) {
  const scale = Math.max(2, window.devicePixelRatio || 1);
  const rect = node.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);

  const clone = node.cloneNode(true);
  inlineStyles(node, clone);
  clone.style.margin = '0';
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');

  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = svgUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width * scale);
  canvas.height = Math.max(1, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  let bg = getComputedStyle(document.body).backgroundColor;
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') bg = '#ffffff';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  return await new Promise((res) => canvas.toBlob(res, 'image/png'));
}

// ====================== 图标 ======================
const SVG_COPY = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const SVG_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

const CSS = `
.tt-hidden-comment {
  display: none !important;
}
.tt-wrapper {
  position: relative;
  padding-left: 2.2em;
  margin: 1em 0;
}
.tt-wrapper > table {
  margin: 0 !important;
}

/* 标题（表格上方）/ 备注（表格下方）公共样式 */
.tt-meta {
  outline: none;
  cursor: text;
  white-space: pre-wrap;
  word-break: break-word;
}
.tt-meta.tt-empty::before {
  content: attr(data-ph);
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.12s;
}
.tt-wrapper:hover .tt-meta.tt-empty::before {
  opacity: 1;
}
.tt-meta[contenteditable='true'] {
  background: var(--background-modifier-hover);
  border-radius: 4px;
}
.tt-title {
  font-weight: 600;
  font-size: 1.05em;
  color: var(--text-normal);
  line-height: 1.4;
  padding: 2px 4px 8px 2px;
}
.tt-title.tt-empty::before {
  font-weight: 400;
  font-size: 0.88em;
}
.tt-note {
  font-size: 0.9em;
  color: var(--text-muted);
  line-height: 1.5;
  padding: 8px 4px 2px 2px;
}
.tt-note.tt-empty::before {
  font-size: 0.92em;
}

/* 行号层 */
.tt-numlayer {
  position: absolute;
  left: 0;
  top: 0;
  width: 2.2em;
  height: 100%;
  pointer-events: none;
}
.tt-rownum {
  position: absolute;
  left: 0;
  transform: translateY(-50%);
  width: 1.9em;
  text-align: right;
  padding-right: 0.5em;
  font-family: var(--font-monospace);
  font-weight: 400;
  font-size: 0.8em;
  line-height: 1;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  user-select: none;
}

/* 工具栏 */
.tt-toolbar {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s ease;
  z-index: 5;
}
.tt-wrapper:hover .tt-toolbar {
  opacity: 1;
}
.tt-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12);
}
.tt-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.tt-btn:active {
  transform: translateY(1px);
}
.tt-btn svg {
  width: 15px !important;
  height: 15px !important;
  display: block;
  fill: none !important;
  stroke: currentColor !important;
  color: inherit;
}
`;

module.exports = TableToolsPlugin;
