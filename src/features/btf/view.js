'use strict';

/**
 * BTF 模块的「地址与来源」层：源文件 ↔ 只读视图地址的换算、取文件、读文件、视图内容。
 *
 * 视图是虚拟文本：源文件放在 query 里，地址挂 `wrsr-btf:` 协议、后缀固定 `.btfview`
 * （靠后缀套上 `btf` 语言，见 package.json）。这样视图和真实文件不会撞车。
 */

const vscode = require('vscode');
const format = require('./format');
/** 本模块的界面文案（由 index.js 装载） */
const i18n = require('../../core/i18n').use('btf');

/** 视图的虚拟协议。视图地址形如 wrsr-btf:/sovietChinese.btf.btfview?<源文件 uri> */
const VIEW_SCHEME = 'wrsr-btf';

/** 视图地址的后缀 —— 靠它套上 `btf` 语言（高亮）；package.json 里也是这样声明的 */
const VIEW_SUFFIX = '.btfview';

/** 本模块的设置命名空间 */
const CONFIG = 'wrsr.btf';

/* ------------------------------------------------------------------ 地址换算 */

function isBtfUri(uri) {
    return !!uri && /\.btf$/i.test(uri.path || '');
}

function isJsonUri(uri) {
    return !!uri && /\.json$/i.test(uri.path || '');
}

function baseName(p) {
    const parts = String(p || '').split('/');
    return parts[parts.length - 1] || 'file';
}

/** 源文件 → 视图地址。源文件放在 query 里，所以视图地址本身不会和真实文件撞车 */
function viewUriFor(source) {
    // 文件名里出现 ? # 会破坏 uri 的 path/query 分界，替换掉（只影响标签页标题）
    const safeName = baseName(source.path).replace(/[?#]/g, '_');
    return vscode.Uri.from({
        scheme: VIEW_SCHEME,
        path: '/' + safeName + VIEW_SUFFIX,
        query: encodeURIComponent(source.toString())
    });
}

/** 视图地址 → 源文件。认不出来返回 undefined */
function sourceUriFromView(viewUri) {
    const raw = viewUri && viewUri.query;
    if (!raw) { return undefined; }
    try {
        const uri = vscode.Uri.parse(decodeURIComponent(raw));
        return uri.scheme === VIEW_SCHEME ? undefined : uri;
    } catch {
        return undefined;
    }
}

/** 给人看的文件名。虚拟地址（非 file）回退成完整 uri */
function label(uri) {
    return uri.scheme === 'file' && uri.fsPath ? uri.fsPath : uri.toString();
}

/* ------------------------------------------------------------------ 设置 */

/** 文本视图的显示上限。设置里 0 或负数 = 不限 */
function maxEntries() {
    const n = Number(vscode.workspace.getConfiguration(CONFIG).get('view.maxEntries', 20000));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ------------------------------------------------------------------ 取文件 */

function pickFile(placeHolder, filters) {
    const folders = vscode.workspace.workspaceFolders;
    return vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: placeHolder,
        defaultUri: folders && folders.length ? folders[0].uri : undefined,
        filters
    }).then(list => (list && list.length ? list[0] : undefined));
}

/**
 * 命令的参数 → 要处理的源文件：
 *   1. 资源管理器 / webview 传来的 uri
 *   2. 当前文本编辑器：如果打开的就是视图，从 query 反解出源文件
 *   3. 都没有就弹文件选择框
 */
async function resolveSourceUri(input, options) {
    const opt = options || {};
    let candidate;
    if (input instanceof vscode.Uri) {
        candidate = input;
    } else if (vscode.window.activeTextEditor) {
        candidate = vscode.window.activeTextEditor.document.uri;
    }

    if (candidate) {
        const source = candidate.scheme === VIEW_SCHEME ? sourceUriFromView(candidate) : candidate;
        if (source && (!opt.mustMatch || opt.mustMatch(source))) { return source; }
    }
    return pickFile(opt.placeHolder || i18n.t('pick.file'), opt.filters);
}

/** 读一个 .btf 并解析（解析本身不抛异常，只有 IO 会） */
async function readParsed(sourceUri) {
    return format.parse(await vscode.workspace.fs.readFile(sourceUri));
}

/* ------------------------------------------------------------------ 视图内容 */

/** 只读视图的 content provider。内容每次现算：源文件变了 fire 一下 emitter 就重画。 */
function contentProvider(emitter) {
    return {
        onDidChange: emitter.event,
        async provideTextDocumentContent(uri) {
            const source = sourceUriFromView(uri);
            if (!source) {
                return i18n.t('view.broken');
            }
            try {
                const parsed = await readParsed(source);
                return format.toTextReport(parsed, { source: label(source), maxEntries: maxEntries() });
            } catch (err) {
                return i18n.t('view.readFailed',
                    err && err.message ? err.message : String(err), label(source));
            }
        }
    };
}

module.exports = {
    VIEW_SCHEME,
    CONFIG,
    isBtfUri,
    isJsonUri,
    viewUriFor,
    label,
    pickFile,
    resolveSourceUri,
    readParsed,
    contentProvider
};
