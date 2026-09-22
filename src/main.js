import { Plugin, Notice, setIcon } from "obsidian";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { t } from "./i18n.js";

const TITLE_RE = /^\s*%%\s*table-title:\s*([\s\S]*?)\s*%%\s*$/;
const NOTE_RE = /^\s*%%\s*table-note:\s*([\s\S]*?)\s*%%\s*$/;
const META_ANY_RE = /^\s*%%\s*table-(?:title|note):\s*[\s\S]*?%%\s*$/;

// The fallback DOM sweep reacts to mutations it causes itself, so it is
// coalesced rather than run once per mutation record.
const SCAN_DEBOUNCE_MS = 150;

export default class TableToolsPlugin extends Plugin {
	async onload() {
		this.timers = new Set();

		// Hide the `%% table-title: ... %%` line in Live Preview and source mode
		// (it reappears while the cursor sits on it).
		try {
			this.registerEditorExtension(buildTitleHider());
		} catch (e) {
			console.error(t("editorExtensionFailed"), e);
		}

		// Reading view and Live Preview: ctx can map the table back to its source lines.
		this.registerMarkdownPostProcessor((el, ctx) => {
			el.querySelectorAll("table:not(.tt-done)").forEach((table) => this.enhance(table, ctx));
		});

		// Fallback for tables rendered outside the post processor (no ctx available).
		this.observer = new MutationObserver(() => this.scheduleScan());
		this.observer.observe(document.body, { childList: true, subtree: true });

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.later(() => this.scan(), 300))
		);

		this.registerDomEvent(window, "resize", () => this.relayoutAll());

		this.addCommand({
			id: "process-tables",
			name: t("commandName"),
			callback: () => {
				const before = document.querySelectorAll("table:not(.tt-done)").length;
				this.scan();
				new Notice(t("processed", before));
			},
		});

		this.app.workspace.onLayoutReady(() => this.later(() => this.scan(), 500));
	}

	onunload() {
		this.observer?.disconnect();
		this.timers.forEach((id) => window.clearTimeout(id));
		this.timers.clear();
		document.querySelectorAll(".tt-wrapper").forEach((wrapper) => {
			wrapper._ttRO?.disconnect();
			const table = wrapper.querySelector("table");
			if (table) {
				table.classList.remove("tt-done");
				wrapper.replaceWith(table);
			}
		});
	}

	/** A setTimeout that will not outlive the plugin. */
	later(fn, delay) {
		const id = window.setTimeout(() => {
			this.timers.delete(id);
			fn();
		}, delay);
		this.timers.add(id);
		return id;
	}

	scheduleScan() {
		if (this.scanTimer !== undefined) return;
		this.scanTimer = this.later(() => {
			this.scanTimer = undefined;
			this.scan();
		}, SCAN_DEBOUNCE_MS);
	}

	scan() {
		document
			.querySelectorAll(
				".markdown-preview-view table:not(.tt-done), .markdown-source-view table:not(.tt-done), .view-content table:not(.tt-done)"
			)
			.forEach((table) => this.enhance(table, null));
	}

	enhance(table, ctx) {
		if (table.classList.contains("tt-done")) return;
		if (!table.rows || table.rows.length === 0) return;
		if (table.closest(".tt-wrapper")) return;
		table.classList.add("tt-done");

		const wrapper = createDiv({ cls: "tt-wrapper" });
		wrapper.dataset.ttTitle = "";
		table.parentNode.insertBefore(wrapper, table);

		// Caption: directly above the table, matching its width.
		const titleEl = this.makeMetaEl(wrapper, table, ctx, "title");
		wrapper.appendChild(titleEl);

		wrapper.appendChild(table);

		const numLayer = wrapper.createDiv({ cls: "tt-numlayer" });

		// Note: below the table and outside it, so adding rows is unaffected.
		const noteEl = this.makeMetaEl(wrapper, table, ctx, "note");
		wrapper.appendChild(noteEl);

		const toolbar = wrapper.createDiv({ cls: "tt-toolbar" });
		this.addToolbarButton(toolbar, "image", t("copyAsImage"), () =>
			this.copyAsImage(wrapper, table)
		);
		this.addToolbarButton(toolbar, "copy", t("copyAsMarkdown"), () =>
			this.copyAsMarkdown(table, wrapper)
		);

		this.layoutNumbers(wrapper, table, numLayer);
		this.loadMeta(table, ctx, wrapper, titleEl, "title");
		this.loadMeta(table, ctx, wrapper, noteEl, "note");

		if (window.ResizeObserver) {
			const ro = new ResizeObserver(() => this.layoutNumbers(wrapper, table, numLayer));
			ro.observe(table);
			wrapper._ttRO = ro;
		}
	}

	addToolbarButton(toolbar, icon, label, onClick) {
		const btn = toolbar.createEl("button", { cls: "tt-btn", attr: { "aria-label": label } });
		btn.title = label;
		setIcon(btn, icon);
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
		return btn;
	}

	/** Build the click-to-edit caption or note element. */
	makeMetaEl(wrapper, table, ctx, kind) {
		const dataKey = kind === "title" ? "ttTitle" : "ttNote";
		const el = createDiv({ cls: `tt-meta tt-${kind} tt-empty` });
		el.setAttribute("contenteditable", "false");
		el.spellcheck = false;
		el.dataset.ph = kind === "title" ? t("captionPlaceholder") : t("notePlaceholder");

		el.addEventListener("click", () => {
			if (el.getAttribute("contenteditable") === "true") return;
			el.setAttribute("contenteditable", "true");
			el.classList.remove("tt-empty");
			el.textContent = wrapper.dataset[dataKey] || "";
			el.focus();
			document.getSelection()?.selectAllChildren(el);
		});
		el.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				el.blur();
			} else if (e.key === "Escape") {
				e.preventDefault();
				el.textContent = wrapper.dataset[dataKey] || "";
				el.blur();
			}
		});
		el.addEventListener("blur", () => {
			el.setAttribute("contenteditable", "false");
			const text = (el.textContent || "").replace(/\n/g, " ").trim();
			const old = wrapper.dataset[dataKey] || "";
			el.textContent = text;
			el.classList.toggle("tt-empty", !text);
			if (text !== old) void this.saveMeta(table, ctx, wrapper, text, kind);
		});
		return el;
	}

	bodyRows(table) {
		if (table.tBodies && table.tBodies.length) return Array.from(table.tBodies[0].rows);
		return Array.from(table.rows).slice(1);
	}

	layoutNumbers(wrapper, table, numLayer) {
		const rows = this.bodyRows(table);
		numLayer.empty();
		const wrect = wrapper.getBoundingClientRect();
		rows.forEach((tr, i) => {
			const r = tr.getBoundingClientRect();
			if (r.height === 0) return;
			const span = numLayer.createSpan({ cls: "tt-rownum", text: String(i + 1) });
			span.setCssStyles({ top: `${r.top - wrect.top + r.height / 2}px` });
		});
	}

	relayoutAll() {
		document.querySelectorAll(".tt-wrapper").forEach((wrapper) => {
			const table = wrapper.querySelector("table");
			const numLayer = wrapper.querySelector(".tt-numlayer");
			if (table && numLayer) this.layoutNumbers(wrapper, table, numLayer);
		});
	}

	// ---------- Mapping a rendered table back to its source lines ----------

	domTableIndex(table) {
		const view = table.closest(".markdown-reading-view, .markdown-source-view, .view-content");
		if (!view) return -1;
		return Array.from(view.querySelectorAll("table")).indexOf(table);
	}

	async resolveLoc(table, ctx) {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		let start = -1;
		let end = -1;
		const info = ctx?.getSectionInfo?.(table);
		if (info) {
			if (typeof info.lineStart === "number") start = info.lineStart;
			if (typeof info.lineEnd === "number") end = info.lineEnd;
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
		return kind === "title" ? TITLE_RE : NOTE_RE;
	}

	metaLabel(kind) {
		return kind === "title" ? "table-title" : "table-note";
	}

	/** Read the caption or note currently stored beside this table. */
	async readMeta(table, ctx, kind) {
		const loc = await this.resolveLoc(table, ctx);
		if (!loc) return "";
		const { lines, start, end } = loc;
		const re = this.metaRe(kind);
		const idx = kind === "note" ? findMetaBelow(lines, end, re) : findMetaAbove(lines, start, re);
		if (idx < 0) return "";
		const m = lines[idx].match(re);
		return m ? m[1].trim() : "";
	}

	/** Write the caption or note back into the note as a `%%` comment line. */
	async writeMeta(table, ctx, kind, newText) {
		newText = (newText || "").replace(/\n/g, " ").trim();
		const loc = await this.resolveLoc(table, ctx);
		if (!loc) {
			new Notice(t("cannotLocate"));
			return;
		}
		const { file, lines, start, end } = loc;
		const re = this.metaRe(kind);
		const lineText = `%% ${this.metaLabel(kind)}: ${newText} %%`;

		if (kind === "note") {
			const idx = findMetaBelow(lines, end, re);
			if (newText) {
				if (idx >= 0) lines[idx] = lineText;
				else {
					lines.splice(end + 1, 0, "", lineText);
					const after = end + 3;
					if (lines[after] !== undefined && lines[after].trim() !== "") lines.splice(after, 0, "");
				}
			} else if (idx >= 0) {
				lines.splice(idx, 1);
				if (idx - 1 > end && lines[idx - 1] !== undefined && lines[idx - 1].trim() === "") {
					lines.splice(idx - 1, 1);
				}
			}
		} else {
			const idx = findMetaAbove(lines, start, re);
			if (newText) {
				if (idx >= 0) lines[idx] = lineText;
				else {
					const ins = [];
					if (start > 0 && lines[start - 1].trim() !== "") ins.push("");
					ins.push(lineText, "");
					lines.splice(start, 0, ...ins);
				}
			} else if (idx >= 0) {
				lines.splice(idx, 1);
				if (lines[idx] !== undefined && lines[idx].trim() === "") lines.splice(idx, 1);
			}
		}

		await this.app.vault.modify(file, lines.join("\n"));
	}

	async loadMeta(table, ctx, wrapper, el, kind) {
		try {
			const text = await this.readMeta(table, ctx, kind);
			wrapper.dataset[kind === "title" ? "ttTitle" : "ttNote"] = text;
			el.textContent = text;
			el.classList.toggle("tt-empty", !text);
		} catch (e) {
			// The note may have been closed or renamed mid-read; leave the field empty.
		}
	}

	async saveMeta(table, ctx, wrapper, newText, kind) {
		await this.writeMeta(table, ctx, kind, newText);
		wrapper.dataset[kind === "title" ? "ttTitle" : "ttNote"] = (newText || "")
			.replace(/\n/g, " ")
			.trim();
	}

	// ---------- Copy as Markdown ----------

	copyAsMarkdown(table, wrapper) {
		try {
			let md = tableToMarkdown(table);
			const title = wrapper?.dataset?.ttTitle;
			const note = wrapper?.dataset?.ttNote;
			if (title) md = `**${title}**\n\n` + md;
			if (note) md = md + `\n\n*${note}*`;
			navigator.clipboard.writeText(md).then(
				() => new Notice(t("copiedMarkdown")),
				() => new Notice(t("clipboardUnavailable"))
			);
		} catch (err) {
			console.error(err);
			new Notice(t("copyFailed"));
		}
	}

	// ---------- Copy as image ----------

	async copyAsImage(wrapper, table) {
		// Keep the toolbar and any empty caption/note placeholders out of the shot.
		const hidden = [wrapper.querySelector(".tt-toolbar")].filter(Boolean);
		wrapper.querySelectorAll(".tt-meta.tt-empty").forEach((m) => hidden.push(m));
		hidden.forEach((el) => el.classList.add("tt-capture-hidden"));
		try {
			new Notice(t("renderingImage"));
			const blob = await domToPngBlob(wrapper);
			if (!blob) throw new Error("the canvas produced no image data");
			if (navigator.clipboard && window.ClipboardItem) {
				await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
				new Notice(t("imageCopied"));
			} else {
				const buf = await blob.arrayBuffer();
				const name = `table-${Date.now()}.png`;
				await this.app.vault.createBinary(name, buf);
				new Notice(t("imageSaved", name));
			}
		} catch (err) {
			console.error(err);
			new Notice(t("imageFailed"));
		} finally {
			hidden.forEach((el) => el.classList.remove("tt-capture-hidden"));
		}
	}
}

// ====================== Helpers ======================

function tableToMarkdown(table) {
	const rows = Array.from(table.rows);
	const lines = [];
	rows.forEach((tr, ri) => {
		const cells = Array.from(tr.cells).map((td) =>
			(td.innerText || td.textContent || "")
				.replace(/\r?\n/g, " ")
				.replace(/\|/g, "\\|")
				.trim()
		);
		lines.push("| " + cells.join(" | ") + " |");
		if (ri === 0) lines.push("| " + cells.map(() => "---").join(" | ") + " |");
	});
	return lines.join("\n");
}

/** Walk up past blank lines and sibling `table-*` comments to find one matching `re`. */
function findMetaAbove(lines, start, re) {
	let i = start - 1;
	while (i >= 0) {
		if (lines[i].trim() === "") {
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

/** The same walk, downwards from the last line of the table. */
function findMetaBelow(lines, end, re) {
	let i = end + 1;
	while (i < lines.length) {
		if (lines[i].trim() === "") {
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
			lines[i + 1].includes("-");
		if (isRow && nextSep) {
			const start = i;
			let j = i;
			while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") j++;
			blocks.push({ start, end: j - 1 });
			i = j;
		} else i++;
	}
	return blocks;
}

/** CodeMirror extension that hides a whole `%% table-title: ... %%` line. */
function buildTitleHider() {
	const hideDeco = Decoration.line({ class: "tt-hidden-comment" });
	const LINE_RE = /^\s*%%\s*table-(?:title|note):\s*[\s\S]*?%%\s*$/;

	return ViewPlugin.fromClass(
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
}

/**
 * Flatten computed styles onto a detached clone. The clone is serialised into an
 * SVG `foreignObject`, which has no access to the document's stylesheets, so
 * every value has to travel inline.
 */
function inlineStyles(src, dst, extra = "") {
	const cs = getComputedStyle(src);
	let css = "";
	for (let i = 0; i < cs.length; i++) {
		const p = cs[i];
		css += `${p}:${cs.getPropertyValue(p)};`;
	}
	dst.setAttribute("style", css + extra);
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
	inlineStyles(node, clone, "margin:0;");
	clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");

	const xml = new XMLSerializer().serializeToString(clone);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
		`<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`;
	const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

	const img = new Image();
	img.width = width;
	img.height = height;
	await new Promise((resolve, reject) => {
		img.onload = resolve;
		img.onerror = reject;
		img.src = svgUrl;
	});

	const canvas = createEl("canvas");
	canvas.width = Math.max(1, width * scale);
	canvas.height = Math.max(1, height * scale);
	const ctx = canvas.getContext("2d");
	ctx.scale(scale, scale);
	let bg = getComputedStyle(document.body).backgroundColor;
	if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "#ffffff";
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(img, 0, 0, width, height);

	return await new Promise((res) => canvas.toBlob(res, "image/png"));
}
