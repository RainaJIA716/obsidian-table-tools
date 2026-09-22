// Follows Obsidian's own interface language: Chinese when the app is in
// Chinese, English everywhere else. We only read the setting, never write it.

const STRINGS = {
	en: {
		commandName: "Process tables on this page",
		processed: (n) => `Processed ${n} table${n === 1 ? "" : "s"}`,
		captionPlaceholder: "+ Add a caption",
		notePlaceholder: "+ Add a note",
		copyAsImage: "Copy as image",
		copyAsMarkdown: "Copy as a Markdown table",
		copiedMarkdown: "Copied as a Markdown table",
		clipboardUnavailable: "Could not copy: the clipboard is unavailable",
		copyFailed: "Could not copy",
		renderingImage: "Rendering the image…",
		imageCopied: "Table image copied to the clipboard",
		imageSaved: (name) => `Clipboard unavailable, saved as ${name}`,
		imageFailed: "Could not render the image, please try again",
		cannotLocate: "Could not locate the table in the note, nothing was saved",
		editorExtensionFailed:
			"Table Tools: the editor extension that hides caption comments failed to load",
	},
	zh: {
		commandName: "处理当前页面的表格",
		processed: (n) => `已处理 ${n} 个表格`,
		captionPlaceholder: "＋ 添加表格标题",
		notePlaceholder: "＋ 添加备注",
		copyAsImage: "复制为图片",
		copyAsMarkdown: "复制为 Markdown 表格",
		copiedMarkdown: "已复制为 Markdown 表格",
		clipboardUnavailable: "复制失败：剪贴板不可用",
		copyFailed: "复制失败",
		renderingImage: "正在生成图片…",
		imageCopied: "表格图片已复制到剪贴板",
		imageSaved: (name) => `剪贴板不可用，已保存为 ${name}`,
		imageFailed: "生成图片失败，请重试",
		cannotLocate: "无法定位表格，未保存",
		editorExtensionFailed: "Table Tools: 隐藏标题注释的编辑器扩展加载失败",
	},
};

function pickLocale() {
	let lang = "en";
	try {
		lang = window.localStorage.getItem("language") || "en";
	} catch (e) {
		// Private mode or a locked-down container: fall back to English.
	}
	return lang.startsWith("zh") ? "zh" : "en";
}

const table = STRINGS[pickLocale()];

/** Look up a UI string; entries that take arguments are called with them. */
export function t(key, ...args) {
	const value = table[key];
	return typeof value === "function" ? value(...args) : value;
}
