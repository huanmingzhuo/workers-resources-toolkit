'use strict';

/**
 * BTF 模块的四条命令（注册在 index.js，webview 按钮也复用）。
 * 第一个参数可以是 Uri；没有就退到当前编辑器，再没有就弹文件选择框（见 view.resolveSourceUri）。
 */

const vscode = require('vscode');
const format = require('./format');
const view = require('./view');
/** 本模块的界面文案（由 index.js 装载） */
const i18n = require('../../core/i18n').use('btf');

/** 文件选择框的过滤器（标签跟随语言，每次现取） */
function btfFilters() {
    return { [i18n.t('filter.btf')]: ['btf'], [i18n.t('filter.allFiles')]: ['*'] };
}

/** 打开只读 BTF 视图 */
async function openView(input) {
    const source = await view.resolveSourceUri(input, {
        mustMatch: view.isBtfUri,
        placeHolder: i18n.t('cmd.open.placeholder'),
        filters: btfFilters()
    });
    if (!source) { return; }

    try {
        const doc = await vscode.workspace.openTextDocument(view.viewUriFor(source));
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
        vscode.window.showErrorMessage(i18n.t('cmd.open.failed', err.message));
    }
}

/**
 * 把内存里的解析结果导出成 JSON / CSV（不重新读盘，编辑器里改过的译文也算）。
 *
 * @param {'json'|'csv'} kind
 * @param {ReturnType<typeof format.parse>} parsed
 * @param {string} sourceLabel 写进 JSON 的 source 字段 / 给提示用
 * @param {vscode.Uri} [defaultUri]
 */
async function exportParsed(kind, parsed, sourceLabel, defaultUri) {
    const target = await vscode.window.showSaveDialog({
        saveLabel: i18n.t(kind === 'json' ? 'save.exportJson' : 'save.exportCsv'),
        defaultUri,
        filters: kind === 'json' ? { 'JSON': ['json'] } : { 'CSV': ['csv'] }
    });
    if (!target) { return; }

    const text = kind === 'json' ? format.toJson(parsed, { source: sourceLabel }) : format.toCsv(parsed);
    try {
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    } catch (err) {
        vscode.window.showErrorMessage(i18n.t('write.failed', err.message));
        return;
    }

    const where = view.label(target);
    vscode.window.showInformationMessage(parsed.problems.length
        ? i18n.t('export.doneWithProblems', parsed.entries.length, parsed.problems.length, where)
        : i18n.t('export.done', parsed.entries.length, where));
}

/** 从磁盘上的 .btf 导出（资源管理器右键 / 命令面板） */
async function exportData(input, kind) {
    const source = await view.resolveSourceUri(input, {
        mustMatch: view.isBtfUri,
        placeHolder: i18n.t('cmd.export.placeholder'),
        filters: btfFilters()
    });
    if (!source) { return; }

    let parsed;
    try {
        parsed = await view.readParsed(source);
    } catch (err) {
        vscode.window.showErrorMessage(i18n.t('cmd.export.readFailed', err.message));
        return;
    }

    const defaultUri = source.scheme === 'file'
        ? source.with({ path: source.path + '.' + kind })
        : undefined;
    await exportParsed(kind, parsed, view.label(source), defaultUri);
}

/** 从导出的 JSON 重建 .btf */
async function buildFromJson(input) {
    const jsonUri = await view.resolveSourceUri(input, {
        mustMatch: view.isJsonUri,
        placeHolder: i18n.t('cmd.build.placeholder'),
        filters: { 'JSON': ['json'] }
    });
    if (!jsonUri) { return; }

    let bytes;
    let count;
    try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(jsonUri)).toString('utf8');
        const entries = format.readEntriesJson(raw);
        count = entries.length;
        bytes = format.build(entries);
    } catch (err) {
        vscode.window.showErrorMessage(i18n.t('cmd.build.failed', err.message));
        return;
    }

    let defaultUri;
    if (jsonUri.scheme === 'file') {
        const base = jsonUri.path.replace(/\.json$/i, '');
        defaultUri = jsonUri.with({ path: /\.btf$/i.test(base) ? base : base + '.btf' });
    }

    const target = await vscode.window.showSaveDialog({
        saveLabel: i18n.t('save.buildBtf'),
        defaultUri,
        filters: { [i18n.t('filter.btf')]: ['btf'] }
    });
    if (!target) { return; }

    try {
        await vscode.workspace.fs.writeFile(target, bytes);
    } catch (err) {
        vscode.window.showErrorMessage(i18n.t('write.failed', err.message));
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        i18n.t('build.done', view.label(target), count, bytes.length), i18n.t('build.openView'));
    if (choice) { openView(target); }
}

/**
 * 导出多语言对照的 CSV（第一列 id，之后每列一个文件）。
 * 只在编辑器里用（多列时）；命令面板没有这个入口 —— 它依赖当前对照了哪几个文件。
 *
 * @param {string[]} columnNames 列名（文件名）
 * @param {Array<Array<number|string|null>>} rows mergeTranslations 的 rows
 * @param {vscode.Uri} [defaultUri]
 */
async function exportComparison(columnNames, rows, defaultUri) {
    const target = await vscode.window.showSaveDialog({
        saveLabel: i18n.t('save.exportComparisonCsv'),
        defaultUri,
        filters: { 'CSV': ['csv'] }
    });
    if (!target) { return; }

    try {
        await vscode.workspace.fs.writeFile(target, Buffer.from(format.toComparisonCsv(columnNames, rows), 'utf8'));
    } catch (err) {
        vscode.window.showErrorMessage(i18n.t('write.failed', err.message));
        return;
    }
    vscode.window.showInformationMessage(
        i18n.t('export.comparison.done', rows.length, columnNames.length, view.label(target)));
}

module.exports = {
    btfFilters,        // editor.js 的「添加对照语言」也用这份标签
    openView,
    exportData,
    exportParsed,      // 编辑器里的导出（内存内容，不重新读盘）
    buildFromJson,
    exportComparison
};
