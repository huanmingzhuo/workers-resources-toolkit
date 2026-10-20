'use strict';

/**
 * 功能模块：BTF 文件
 *
 */

const path = require('path');
const vscode = require('vscode');
const i18n = require('../../core/i18n');
const view = require('./view');
const commands = require('./commands');
const editor = require('./editor');

/** 本模块的界面文案目录：`<语言>/ui.json` */
const UI_DIR = path.join(__dirname, 'data', 'docs');

/** 当前语言：共用设置 `wrsr.language`（`auto` 跟随显示语言） */
function currentLocale() {
    const raw = vscode.workspace.getConfiguration('wrsr').get('language', 'auto');
    if (!raw || raw === 'auto') { return vscode.env.language || ''; }
    return String(raw);
}

/** 装载本模块的界面文案（命名空间 `btf`） */
function loadUi() {
    return i18n.load('btf', UI_DIR, currentLocale());
}

function activate(context) {
    loadUi();

    const emitter = new vscode.EventEmitter();
    // 提供者要活到插件退出（内容变更事件挂在它身上），所以自己留一份引用负责释放
    const btfEditor = new editor.BtfEditorProvider(context);

    // 源文件被别的工具改了就重画文本视图
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.btf');
    const refresh = (uri) => emitter.fire(view.viewUriFor(uri));

    /** 重画所有已打开的文本视图（内容由 provider 现算） */
    const refreshViews = () => {
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === view.VIEW_SCHEME) { emitter.fire(doc.uri); }
        }
    };

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(view.VIEW_SCHEME, view.contentProvider(emitter)),
        vscode.window.registerCustomEditorProvider(editor.VIEW_TYPE, btfEditor, {
            // 保住 webview：切走标签页再回来时，搜索词、滚动位置、加好的对照列都还在
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false
        }),
        { dispose() { btfEditor.dispose(); } },
        vscode.commands.registerCommand('wrsr.btf.openView', commands.openView),
        // package.json 里绑在 Ctrl+S 上（仅当对照视图激活），转发给 VS Code 自己的保存
        vscode.commands.registerCommand('wrsr.btf.save', () =>
            vscode.commands.executeCommand('workbench.action.files.save')),
        vscode.commands.registerCommand('wrsr.btf.exportJson', (uri) => commands.exportData(uri, 'json')),
        vscode.commands.registerCommand('wrsr.btf.exportCsv', (uri) => commands.exportData(uri, 'csv')),
        vscode.commands.registerCommand('wrsr.btf.build', commands.buildFromJson),
        watcher,
        emitter,
        watcher.onDidChange(refresh),
        watcher.onDidCreate(refresh),
        vscode.workspace.onDidChangeConfiguration(e => {
            // 语言换了：重新装载文案。文本视图内容每次现算，重画即为新语言；
            // 对照视图的静态骨架要重建 HTML，见 relayoutAll()
            if (e.affectsConfiguration('wrsr.language')) {
                loadUi();
                refreshViews();
                btfEditor.relayoutAll();
                return;
            }
            // 显示上限之类的设置改了，已经开着的文本视图要重画
            if (e.affectsConfiguration(view.CONFIG)) { refreshViews(); }
        })
    );
}

module.exports = {
    id: 'btf',
    displayName: 'BTF 文件',
    // 没有 languageId：二进制文件读不出文本行，core/detect.js 的判据用不上（见文件头说明）
    activate
};
