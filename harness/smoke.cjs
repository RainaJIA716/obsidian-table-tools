// Smoke test for the Table Tools bundle: loads main.js against jsdom with the
// Obsidian API stubbed, then drives the real code paths.
const path = require("path");
const Module = require("module");
const { JSDOM } = require("jsdom");

const PLUGIN = path.join(__dirname, "..");

let failures = 0;
function check(label, cond, detail) {
	if (cond) console.log("  ok   " + label);
	else { failures++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}

// ---------- DOM ----------
const dom = new JSDOM(`<!doctype html><html><body>
<div class="markdown-preview-view"><div class="view-content">
<table><thead><tr><th>Team</th><th>People</th></tr></thead>
<tbody><tr><td>Design</td><td>4</td></tr><tr><td>Eng</td><td>11</td></tr>
<tr><td>Ops</td><td>3</td></tr></tbody></table>
</div></div></body></html>`, { pretendToBeVisual: true });

const { window } = dom;
global.window = window;
global.document = window.document;
global.MutationObserver = window.MutationObserver;
global.XMLSerializer = window.XMLSerializer;
global.Image = window.Image;
global.getComputedStyle = window.getComputedStyle.bind(window);
global.navigator = window.navigator;
global.HTMLElement = window.HTMLElement;

// ---------- Obsidian's DOM augmentations ----------
const P = window.HTMLElement.prototype;
function build(tag, o = {}) {
	const el = window.document.createElement(tag);
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	return el;
}
P.createEl = function (tag, o) { const e = build(tag, o); this.appendChild(e); return e; };
P.createDiv = function (o) { return this.createEl("div", o); };
P.createSpan = function (o) { return this.createEl("span", o); };
P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
P.setCssStyles = function (s) { for (const [k, v] of Object.entries(s)) this.style.setProperty(k, v); };
P.addClass = function (...c) { this.classList.add(...c); };
P.removeClass = function (...c) { this.classList.remove(...c); };
global.createEl = (tag, o) => build(tag, o);
global.createDiv = (o) => build("div", o);
global.createSpan = (o) => build("span", o);

// jsdom has no layout, so give rows a believable box.
let boxSeq = 0;
window.Element.prototype.getBoundingClientRect = function () {
	const isRow = this.tagName === "TR";
	const top = isRow ? 100 + (boxSeq++ % 3) * 40 : 100;
	return { top, left: 0, width: 400, height: isRow ? 40 : 200, right: 400, bottom: top + 40, x: 0, y: top };
};

// ---------- Module stubs ----------
const notices = [];
const iconsSet = [];
class Plugin {
	constructor(app) { this.app = app; this._ext = []; this._cmds = []; }
	registerEditorExtension(e) { this._ext.push(e); }
	registerMarkdownPostProcessor(f) { this._pp = f; }
	registerEvent() {}
	registerDomEvent(t, ev, fn) { t.addEventListener(ev, fn); }
	addCommand(c) { this._cmds.push(c); }
}
class Notice { constructor(msg) { notices.push(String(msg)); } }
const stubs = {
	obsidian: { Plugin, Notice, setIcon: (el, name) => { iconsSet.push(name); el.createSvg ? 0 : el.appendChild(build("svg")); } },
	"@codemirror/view": {
		ViewPlugin: { fromClass: (cls, spec) => ({ cls, spec }) },
		Decoration: { line: (o) => ({ line: o }) },
	},
	"@codemirror/state": { RangeSetBuilder: class { add() {} finish() { return "rangeset"; } } },
};
const origResolve = Module._load;
Module._load = function (req, parent, isMain) {
	if (stubs[req]) return stubs[req];
	return origResolve.apply(this, arguments);
};

// ---------- Fake vault ----------
const NOTE = [
	"# Notes",
	"",
	"| Team | People |",
	"| ---- | ------ |",
	"| Design | 4 |",
	"| Eng | 11 |",
	"| Ops | 3 |",
	"",
	"tail paragraph",
].join("\n");
const file = { path: "Notes.md" };
let vaultContent = NOTE;
const app = {
	workspace: {
		getActiveFile: () => file,
		on: () => ({}),
		onLayoutReady: (f) => f(),
	},
	vault: {
		read: async () => vaultContent,
		modify: async (_f, c) => { vaultContent = c; },
		createBinary: async () => {},
	},
};

// ---------- Run ----------
(async () => {
	const TableTools = require(path.join(PLUGIN, "main.js"));
	const Ctor = TableTools.default || TableTools;
	console.log("\n[load]");
	check("bundle exports a constructor", typeof Ctor === "function", typeof Ctor);

	const plugin = new Ctor(app);
	await plugin.onload();
	check("onload completed without throwing", true);
	check("registered an editor extension", plugin._ext.length === 1);
	check("registered one command", plugin._cmds.length === 1, JSON.stringify(plugin._cmds.map((c) => c.name)));
	check("command name is English", /^Process tables/.test(plugin._cmds[0].name), plugin._cmds[0].name);

	console.log("\n[enhance]");
	const table = document.querySelector("table");
	plugin.enhance(table, null);
	const wrapper = document.querySelector(".tt-wrapper");
	check("wrapper created", !!wrapper);
	check("table moved inside the wrapper", wrapper && wrapper.querySelector("table") === table);
	check("table marked done", table.classList.contains("tt-done"));

	const nums = [...wrapper.querySelectorAll(".tt-rownum")].map((s) => s.textContent);
	check("one row number per body row", nums.length === 3, JSON.stringify(nums));
	check("numbers are 1,2,3", nums.join(",") === "1,2,3", nums.join(","));
	check("row numbers positioned inline", !!wrapper.querySelector(".tt-rownum").style.top);

	const btns = wrapper.querySelectorAll(".tt-btn");
	check("two toolbar buttons", btns.length === 2, String(btns.length));
	check("buttons got lucide icons", iconsSet.join(",") === "image,copy", iconsSet.join(","));
	check("buttons have aria-labels", [...btns].every((b) => b.getAttribute("aria-label")));

	check("caption element present", !!wrapper.querySelector(".tt-title"));
	check("note element present", !!wrapper.querySelector(".tt-note"));
	check("placeholders are English", wrapper.querySelector(".tt-title").dataset.ph === "+ Add a caption",
		wrapper.querySelector(".tt-title").dataset.ph);
	check("element order caption→table→numbers→note→toolbar",
		[...wrapper.children].map((c) => c.tagName === "TABLE" ? "TABLE" : c.className.split(" ")[0]).join("|") ===
		"tt-meta|TABLE|tt-numlayer|tt-meta|tt-toolbar",
		[...wrapper.children].map((c) => c.tagName === "TABLE" ? "TABLE" : c.className.split(" ")[0]).join("|"));

	console.log("\n[copy as markdown]");
	let copied = null;
	global.navigator.clipboard = { writeText: async (t) => { copied = t; } };
	Object.defineProperty(window, "navigator", { value: global.navigator, configurable: true });
	wrapper.dataset.ttTitle = "Q3 headcount";
	wrapper.dataset.ttNote = "excludes contractors";
	plugin.copyAsMarkdown(table, wrapper);
	await new Promise((r) => setTimeout(r, 10));
	check("clipboard received markdown", !!copied);
	check("caption included in bold", copied && copied.startsWith("**Q3 headcount**"), JSON.stringify(copied));
	check("separator row present", copied && copied.includes("| --- | --- |"));
	check("note included in italics", copied && copied.trim().endsWith("*excludes contractors*"));
	check("notice was English", notices.includes("Copied as a Markdown table"), JSON.stringify(notices));

	console.log("\n[write caption back into the note]");
	await plugin.writeMeta(table, null, "title", "Q3 headcount");
	check("caption comment written above the table",
		vaultContent.includes("%% table-title: Q3 headcount %%"), vaultContent);
	const lines = vaultContent.split("\n");
	const ti = lines.findIndex((l) => l.includes("table-title"));
	const tb = lines.findIndex((l) => l.startsWith("| Team"));
	check("caption sits above the table", ti >= 0 && ti < tb, `title@${ti} table@${tb}`);
	check("table rows untouched", vaultContent.includes("| Design | 4 |") && vaultContent.includes("| Ops | 3 |"));

	await plugin.writeMeta(table, null, "note", "excludes contractors");
	check("note comment written", vaultContent.includes("%% table-note: excludes contractors %%"));
	const l2 = vaultContent.split("\n");
	const ni = l2.findIndex((l) => l.includes("table-note"));
	const lastRow = l2.findIndex((l) => l.startsWith("| Ops"));
	check("note sits below the table", ni > lastRow, `note@${ni} lastrow@${lastRow}`);

	const readBack = await plugin.readMeta(table, null, "title");
	check("caption reads back", readBack === "Q3 headcount", JSON.stringify(readBack));
	const readNote = await plugin.readMeta(table, null, "note");
	check("note reads back", readNote === "excludes contractors", JSON.stringify(readNote));

	await plugin.writeMeta(table, null, "title", "");
	check("clearing the caption removes the comment", !vaultContent.includes("table-title"), vaultContent);
	check("clearing did not eat the table", vaultContent.includes("| Design | 4 |"));

	console.log("\n[unload]");
	plugin.onunload();
	check("wrapper removed", !document.querySelector(".tt-wrapper"));
	check("table returned to the document", !!document.querySelector("table"));
	check("done marker cleared", !document.querySelector("table").classList.contains("tt-done"));

	console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("\n harness threw:", e); process.exit(1); });
