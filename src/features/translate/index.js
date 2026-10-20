'use strict';

/**
 * 功能模块：翻译工作台
 *
 * 给翻译者用的：人工说明散在 `data/docs/<语言>/` 的 5 个文件里，这个模块把它们摊成一张表，
 * 在一个面板里翻。做筛选 / 搜索 / 只看缺失 / 逐条改 / 批量保存；
 * 不新增或删除键，不改 `sig`。
 *
 * 结构对齐由「添加语言…」负责（data.js 的 `addLocale()`）：照默认语言把键铺成空占位，
 * 所以每种语言结构一致。日常编辑只往空位里填字。
 *
 * 数据读写全在 data.js（纯逻辑），页面在 page.js。
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const data = require('./data');
const page = require('./page');
/** 模块本身：`load()` 在它身上（别和下面的命名空间视图搞混） */
const i18nCore = require('../../core/i18n');
/** 本模块命名空间的视图：只有 t() / has() / dump() / locale() */
const i18n = i18nCore.use('translate');

/** 本模块的界面文案目录 */
const UI_DIR = path.join(__dirname, 'data', 'docs');

/** 面板（只开一个，再点命令就激活它） */
let panel;

/** 当前语言对。目标语言默认选「不是默认语言」的第一个 */
let target = '';
let source = data.DEFAULT_LOCALE;

function currentLocale() {
    const raw = vscode.workspace.getConfiguration('wrsr').get('language', 'auto');
    if (!raw || raw === 'auto') { return vscode.env.language || ''; }
    return String(raw);
}

function loadUi() {
    return i18nCore.load('translate', UI_DIR, currentLocale());
}

/* ------------------------------------------------------------------ 数据 */

function post(msg) {
    if (panel) { panel.webview.postMessage(msg); }
}

function pickTarget(list) {
    const other = list.find(l => l !== source) || list.find(l => l !== data.DEFAULT_LOCALE);
    return other || data.DEFAULT_LOCALE;
}

/**
 * 认「工作区里含 src/features/pyrois/data/docs 的那个目录」为要编辑的仓库根；认不到返回 undefined。
 *
 * 这是开发者专用功能：
 *   ① 插件默认按自己的安装目录找文案文件，而翻译者改的是仓库那份 —— 不显式换根
 *      就会「面板里改了、仓库没动静」（改动落在装机目录，更新即丢）；
 *   ② 所以不回退到安装副本：认不到仓库就不开面板（`openPanel` 里拦），
 *      命令面板里那一条也只在 `wrsr.devRepo` 为真时可见（见 contributes.menus.commandPalette）。
 */
function resolveRoot() {
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const dir = folder.uri.fsPath;
        try {
            if (fs.existsSync(path.join(dir, 'src', 'features', 'pyrois', 'data', 'docs'))) { return dir; }
        } catch { /* 打不开就换下一个 */ }
    }
    return undefined;
}

/** 命令可见性用的上下文键：只有打开了插件仓库的工作区才为真 */
function updateDevContext() {
    vscode.commands.executeCommand('setContext', 'wrsr.devRepo', !!resolveRoot());
}

/** 读一份数据发给页面。localeList / fileList / 根目录一起带上，页面不用猜 */
function sendData() {
    data.setRoot(resolveRoot());     // 每次发数据前重认一次：工作区换了也能跟上
    const list = data.locales();
    if (!list.includes(source)) { source = list.includes(data.DEFAULT_LOCALE) ? data.DEFAULT_LOCALE : (list[0] || ''); }
    if (!list.includes(target) || target === source) { target = pickTarget(list); }

    const payload = data.load(target, source);
    payload.root = data.root();
    payload.rootFromWorkspace = true;   // 面板只可能在"认到仓库"时打开（见 openPanel）
    payload.localeList = list;
    payload.fileList = data.files().map(f => ({
        key: f.key,
        section: f.section,
        // 模块界面文案的标签带模块名（「BTF 文件 · 界面文案」），其余用一个固定键
        label: f.moduleName ? i18n.t(f.labelKey, f.moduleName) : i18n.t(f.labelKey)
    }));
    payload.sectionList = data.SECTIONS.map(s => ({ key: s.key, label: i18n.t(s.labelKey) }));
    payload.sectionStats = payload.sectionStats.map(s => Object.assign({ label: i18n.t(s.labelKey) }, s));
    post({ type: 'data', payload });
}

/* ------------------------------------------------------------------ 面板 */

async function onMessage(msg) {
    if (!msg || !msg.type) { return; }
    try {
        if (msg.type === 'ready') { sendData(); return; }

        if (msg.type === 'reload') {
            const next = {
                source: msg.source == null ? source : String(msg.source),
                target: msg.target == null ? target : String(msg.target)
            };
            // 有未保存的改动时先问一句。这个确认必须在宿主做：
            // webview 里 `window.confirm` 不可用（VS Code 不提供），写了也是白写
            if (msg.dirty) {
                const ok = i18n.t('confirm.reloadOk');
                const pick = await vscode.window.showWarningMessage(
                    i18n.t('page.confirmReload'), { modal: true }, ok);
                if (pick !== ok) {
                    // 取消：只把下拉选回去 —— 不能重发数据，那会把未保存的改动一起清掉
                    post({ type: 'selection', source, target });
                    return;
                }
            }
            source = next.source;
            target = next.target;
            sendData();
            return;
        }

        if (msg.type === 'addLocale') {
            const name = await vscode.window.showInputBox({
                title: i18n.t('prompt.localeTitle'),
                prompt: i18n.t('prompt.locale'),
                placeHolder: 'vi-VN',
                validateInput: (value) => {
                    const s = String(value == null ? '' : value).trim();
                    if (!s) { return i18n.t('prompt.localeEmpty'); }
                    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s)) { return i18n.t('prompt.localeBad'); }
                    if (data.locales().some(l => l.toLowerCase() === s.toLowerCase())) {
                        return i18n.t('prompt.localeExists');
                    }
                    return undefined;
                }
            });
            if (name === undefined) { return; }   // 用户取消
            const result = data.addLocale(String(name).trim(), source);
            post({
                type: 'notice',
                text: i18n.t('notice.localeAdded', result.locale, result.created.length + result.aligned.length)
            });
            target = result.locale;   // 顺手切过去，接着就能翻
            sendData();
            return;
        }

        if (msg.type === 'syncKeys') {
            const preview = data.syncKeys({ from: source, dryRun: true });
            if (!preview.locales.length) {
                post({ type: 'notice', text: i18n.t('sync.none', source) });
                return;
            }

            const lines = preview.locales.map(item => {
                const bits = [];
                if (item.added.length) { bits.push(i18n.t('sync.added', item.added.length)); }
                if (item.removed.length) { bits.push(i18n.t('sync.removed', item.removed.length)); }
                return item.locale + '  ' + bits.join(i18n.t('sync.sep'));
            });
            const extras = preview.locales
                .filter(item => item.removed.length)
                .map(item => item.locale + '  ' + item.removed.slice(0, 8).join(', ')
                    + (item.removed.length > 8 ? ' …' : ''));

            const addOnly = i18n.t('sync.addOnly');
            const addAndRemove = i18n.t('sync.addAndRemove');
            const hasRemoved = preview.locales.some(item => item.removed.length);
            const buttons = hasRemoved ? [addOnly, addAndRemove] : [addOnly];

            let body = lines.join('\n');
            if (extras.length) {
                body += '\n\n' + i18n.t('sync.removedHint') + '\n' + extras.join('\n');
            }

            // 用模态框问：删除多余键会丢内容，不能点错就过去
            const pick = await vscode.window.showWarningMessage(
                i18n.t('sync.preview', source),
                { modal: true, detail: body },
                ...buttons);
            if (!pick) { return; }

            const result = data.syncKeys({ from: source, remove: pick === addAndRemove });
            const count = result.locales.reduce((n, item) => n + item.added.length + item.removed.length, 0);
            post({ type: 'notice', text: i18n.t('sync.done', result.locales.length, count) });
            sendData();
            return;
        }

        if (msg.type === 'save') {
            let result = { written: [], skipped: [] };
            try {
                result = data.save(target, msg.changes || []);
            } catch (err) {
                post({ type: 'error', message: i18n.t('notice.saveFailed', err && err.message ? err.message : String(err)) });
                return;
            }

            const n = result.written.length;
            if (result.skipped.length) {
                // 写不进去的必须说出来：静默不写是最坏的体验
                const detail = result.skipped.slice(0, 5)
                    .map(s => (s.group ? s.group + '.' : '') + s.key + '（' + i18n.t('reason.' + s.reason) + '）')
                    .join('、');
                post({
                    type: 'error',
                    message: i18n.t(n ? 'notice.partial' : 'notice.noneWritten', n, result.skipped.length, detail)
                });
            } else {
                post({ type: 'notice', text: i18n.t(n ? 'notice.saved' : 'notice.noChanges', n) });
            }
            sendData();   // 进度与「只看缺失」跟着变
            return;
        }

        if (msg.type === 'openFile') {
            const which = msg.which === 'source' ? 'source' : 'target';
            const locale = (which === 'source') ? (source || data.DEFAULT_LOCALE) : target;
            const full = data.filePath(msg.file, locale);
            if (!full || !fs.existsSync(full)) {
                post({ type: 'error', message: i18n.t('notice.fileMissing', full || String(msg.file)) });
                return;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            const line = findKeyLine(doc, msg.group, msg.key);
            if (line >= 0) {
                const pos = new vscode.Position(line, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } else {
                // 文件开了、但这个键不在里面（例如这门语言还没有这一条）—— 说清楚，别让人以为点错了
                post({ type: 'notice', text: i18n.t('notice.keyNotFound', msg.key, locale) });
            }
            return;
        }
    } catch (err) {
        post({ type: 'error', message: i18n.t('notice.failed', err && err.message ? err.message : String(err)) });
    }
}

/**
 * 找某个键在 JSON 文本里的行号（找不到返回 -1）。
 * 结构体是嵌套写法：先定位分组名，再从它之后找成员名 —— 否则会撞上别处同名的键。
 */
function findKeyLine(doc, group, key) {
    const needle = '"' + key + '"';
    let from = 0;
    if (group) {
        const g = '"' + group + '"';
        for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.indexOf(g) >= 0) { from = i; break; }
        }
    }
    for (let i = from; i < doc.lineCount; i++) {
        if (doc.lineAt(i).text.indexOf(needle) >= 0) { return i; }
    }
    return -1;
}

function openPanel() {
    // 开发者专用：没打开插件仓库就不开面板 —— 绝不回退到装机副本，那只会让人白改一场
    if (!resolveRoot()) {
        vscode.window.showErrorMessage(i18n.t('notice.noRepo'));
        return;
    }
    if (panel) { panel.reveal(undefined, false); return; }

    panel = vscode.window.createWebviewPanel(
        'wrsr.translate',
        i18n.t('panel.title'),
        vscode.ViewColumn.One,
        // 保住 webview：切走标签页再回来时，搜索词、选中行、没保存的改动都还在
        { enableScripts: true, retainContextWhenHidden: true }
    );
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    panel.webview.html = page.shellHtml(panel.webview, nonce, i18n);
    panel.webview.onDidReceiveMessage(onMessage);
    panel.onDidDispose(() => { panel = undefined; });
}

/** 语言设置变了：重装文案。面板开着就重画一遍（静态骨架上的字要重建才会变） */
function onLanguageChanged() {
    loadUi();
    if (!panel) { return; }
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    panel.title = i18n.t('panel.title');
    panel.webview.html = page.shellHtml(panel.webview, nonce, i18n);
}

function activate(context) {
    loadUi();
    updateDevContext();      // 命令可见性：只有打开了插件仓库的窗口才显示这条命令
    context.subscriptions.push(
        vscode.commands.registerCommand('wrsr.translate.open', openPanel),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('wrsr.language')) { onLanguageChanged(); }
        }),
        // 换了工作区（比如刚打开仓库）：命令可见性 + 根目录都要重认
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            updateDevContext();
            if (panel) { sendData(); }
        })
    );
}

module.exports = {
    id: 'translate',
    displayName: '翻译工作台',
    // 没有 languageId：它不参与「打开文件时自动认类型」，只提供一条命令
    activate
};
