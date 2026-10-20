'use strict';

/**
 * BTF 的自定义编辑器
 */

const vscode = require('vscode');
const format = require('./format');
const view = require('./view');
const commands = require('./commands');
const page = require('./editor-page');
/** 本模块的界面文案（由 index.js 装载） */
const i18n = require('../../core/i18n').use('btf');

/** 必须和 package.json 里 contributes.customEditors 的 viewType 一致 */
const VIEW_TYPE = 'wrsr.btf.viewer';

// 这里只记日志，不 throw（那会把整个插件带下去）。
for (const name of ['exportParsed', 'exportComparison']) {
    if (typeof commands[name] !== 'function') {
        console.error(`[btf] commands.${name} 没导出 —— 检查 src/features/btf/commands.js 的 module.exports`);
    }
}

/** 一次推给页面多少行 */
const CHUNK = 2000;

/** 校验提示在编辑器里最多列多少条 */
const MAX_PROBLEMS = 50;

/**
 * 一次对照最多往页面送多少行；
 */
const MAX_ROWS = 200000;

/** 热退出备份放哪（相对 storageUri） */
const BACKUP_DIR = 'btf-backup';

/** 超过这么多行就不再每敲一下重算列统计 */
const STATS_LIVE_LIMIT = 20000;

/* ------------------------------------------------------------------ 文件 */

function baseName(p) {
    const parts = String(p || '').split('/');
    return parts[parts.length - 1] || 'file';
}

function parentOf(uri) {
    const p = String(uri.path || '').replace(/\/[^/]*$/, '');
    return uri.with({ path: p || '/' });
}

function sameBytes(a, b) {
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
    return true;
}

/** 把解析结果重打包成 BTF 文件 */
function rebuild(parsed) {
    return format.build(parsed.entries.map(e => ({ id: e.id, text: e.text })));
}

/** 读一个 .btf 文件 */
async function loadFile(uri) {
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed = format.parse(raw);
    let mtime = 0;
    try { mtime = (await vscode.workspace.fs.stat(uri)).mtime; } catch { mtime = 0; }

    let byteStable = false;
    try { byteStable = sameBytes(rebuild(parsed), raw); } catch { byteStable = false; }

    return {
        uri,
        name: baseName(uri.path),
        path: view.label(uri),
        parsed,
        mtime,
        byteStable,
        lossy: parsed.stats.replacedChars || 0,
        edited: false,
        // 各自记一次，免得每次保存都弹
        confirmedLayout: false,
        confirmedLoss: false
    };
}

/** 候选的对照文件：同目录优先，再补上工作区里所有 `.btf`；已加载的不列。 */
async function findCandidates(primaryUri, loaded) {
    const found = new Map();
    const add = (uri) => {
        const key = uri.toString();
        if (!found.has(key) && !loaded.has(key)) { found.set(key, uri); }
    };

    try {
        const dir = parentOf(primaryUri);
        for (const [name, kind] of await vscode.workspace.fs.readDirectory(dir)) {
            if (kind === vscode.FileType.File && /\.btf$/i.test(name)) { add(vscode.Uri.joinPath(dir, name)); }
        }
    } catch {
        // 目录读不了就先跳过，下面还有工作区搜索
    }

    try {
        for (const uri of await vscode.workspace.findFiles('**/*.btf', null, 50)) { add(uri); }
    } catch {
        // 没有打开工作区文件夹时 findFiles 会抛，忽略即可
    }

    return Array.from(found.values());
}

async function pickComparisonFile(primaryUri, loaded) {
    const candidates = await findCandidates(primaryUri, loaded);
    const items = candidates.map(uri => ({
        label: '$(file) ' + baseName(uri.path),
        description: view.label(uri),
        uri
    }));
    items.push({
        label: '$(folder-opened) ' + i18n.t('pick.other'),
        description: i18n.t('pick.otherDesc'),
        manual: true
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: i18n.t('pick.addTitle'),
        placeHolder: i18n.t('pick.addPlaceholder'),
        matchOnDescription: true
    });
    if (!picked) { return undefined; }
    if (picked.uri) { return picked.uri; }

    return view.pickFile(i18n.t('pick.comparisonFile'), commands.btfFilters());
}

/* ------------------------------------------------------------------ 文档 */

/**
 * 一个自定义编辑器 = 一个 BtfDocument = 主文件 + 若干对照文件。
 */
class BtfDocument {
    constructor(uri, context, owner) {
        this.uri = uri;
        this.context = context;
        /** 拥有这个文档的提供者 —— 内容变更事件挂在它身上（见下面 BtfEditorProvider 的注释） */
        this.owner = owner;
        this.files = [];
        this.rows = [];
        this.columns = [];
        this.indexes = [];
        this.error = '';
        this.panel = undefined;
    }

    dispose() {
        this.panel = undefined;
        this.files = [];
        this.rows = [];
    }

    get dirty() {
        return this.files.some(f => f.edited);
    }

    /** 文档变了 → 让提供者去 fire（事件接口在提供者那边） */
    fire() {
        if (this.owner) { this.owner.fire(this); }
    }

    /* ---------------------------------------------------------- 加载 */

    async open() {
        try {
            this.files = [await loadFile(this.uri)];
        } catch (err) {
            this.error = err && err.message ? err.message : String(err);
            this.files = [];
        }
        this.merge();
    }

    /** 全部重读 */
    async reload() {
        const files = [];
        for (const file of this.files) {
            try {
                files.push(await loadFile(file.uri));
            } catch (err) {
                vscode.window.showWarningMessage(i18n.t('doc.reloadFailed', file.path, err.message));
                files.push(file);
            }
        }
        this.files = files;
        this.merge();
        this.sendAll();
    }

    async add(uri) {
        const loaded = new Set(this.files.map(f => f.uri.toString()));
        if (loaded.has(uri.toString())) {
            vscode.window.showInformationMessage(i18n.t('doc.alreadyAdded'));
            return;
        }
        let file;
        try {
            file = await loadFile(uri);
        } catch (err) {
            vscode.window.showErrorMessage(i18n.t('doc.addFailed', err.message));
            return;
        }
        this.files.push(file);
        this.merge();
        this.sendAll();
    }

    remove(index) {
        if (!Number.isInteger(index) || index <= 0 || index >= this.files.length) { return; }
        this.files.splice(index, 1);
        this.merge();
        this.sendAll();
    }

    /* ---------------------------------------------------------- 对照 */

    /** 按 id 对齐 */
    merge() {
        const merged = format.mergeTranslations(this.files.map(f => f.parsed));
        this.rows = merged.rows;
        this.indexes = merged.indexes;
        this.columns = merged.columns.map((stat, i) => Object.assign({
            name: this.files[i].name,
            path: this.files[i].path
        }, stat));
    }

    /** 只重算列头统计，不动表格数据 */
    recount() {
        if (this.rows.length > STATS_LIVE_LIMIT) { return; }
        this.merge();
        this.post({ type: 'stats', columns: this.columns });
    }

    /* ---------------------------------------------------------- 编辑 */

    /**
     * 页面把某一格改成了 text。`row` 是对照表行号，要经过 indexes 折回去；
     * 那一格是"缺失"（-1）时改不了，得先走 addEntry()。
     */
    edit(row, col, text) {
        const file = this.files[col];
        if (!file || !Number.isInteger(row) || row < 0 || row >= this.rows.length) { return; }
        const at = this.indexes[col] ? this.indexes[col][row] : -1;
        if (at === undefined || at < 0) { return; }
        const entry = file.parsed.entries[at];
        if (!entry || entry.text === text) { return; }

        entry.text = text;
        file.edited = true;
        this.rows[row][col + 1] = text;   // 导出用的就是这份
        this.post({ type: 'dirty', files: this.files.map(f => !!f.edited) });
        this.fire();
        this.recount();
    }

    /**
     * 给某一列新增一条：id 取自带的那一行，文本先留空。
     * 只做"补上这一行"，不造新 id（那要先回答 id 从哪来、插在第几条）。
     *
     * 插入位置按对照表的 id 顺序走：找到该文件里第一个排在这一行之后的条目，插在它前面。
     * `entries[].index` 是推导出来的，插完必须重排，否则 indexes 会指错。
     */
    addEntry(row, col) {
        const file = this.files[col];
        if (!file || !Number.isInteger(row) || row < 0 || row >= this.rows.length) { return false; }
        const id = this.rows[row][0];
        if (file.parsed.entries.some(e => e.id === id)) {
            this.notice(i18n.t('entry.exists', id));
            return false;
        }

        const order = new Map(this.rows.map((r, i) => [r[0], i]));
        const mine = order.get(id);
        let at = file.parsed.entries.length;             // 默认接在末尾
        for (let i = 0; i < file.parsed.entries.length; i++) {
            const p = order.get(file.parsed.entries[i].id);
            if (p !== undefined && p > mine) { at = i; break; }
        }

        file.parsed.entries.splice(at, 0, {
            index: 0, id, charOffset: 0, length: 0, text: '', textByteOffset: 0, terminated: true
        });
        file.parsed.entries.forEach((e, i) => { e.index = i; });
        file.edited = true;

        this.merge();
        this.sendAll();                 // 表格数据整份重发（行内容变了，页面那份要跟上）
        this.post({ type: 'select', row, col });   // 加完直接把这一行重新选中，光标放进新格子
        this.fire();
        this.notice(i18n.t('entry.added', file.name, id));
        return true;
    }

    /* ---------------------------------------------------------- 保存 */

    /**
     * 闸 ①：这个文件不是标准布局 —— 覆盖保存会把文本区重排（内容不变、字节变）。
     * 写到新文件时不用问
     */
    async confirmLayout(file, toTarget) {
        if (toTarget || file.byteStable || file.confirmedLayout) { return true; }
        const ok = i18n.t('confirm.layoutOk');
        const pick = await vscode.window.showWarningMessage(
            i18n.t('confirm.layout', file.name), { modal: true }, ok);
        if (pick !== ok) { return false; }
        file.confirmedLayout = true;
        return true;
    }

    /**
     * 闸 ②：解析时有损失 —— 落单的 UTF-16 码元已经被换成 U+FFFD
     */
    async confirmLoss(file) {
        if (!file.lossy || file.confirmedLoss) { return true; }
        const ok = i18n.t('confirm.lossOk');
        const pick = await vscode.window.showWarningMessage(
            i18n.t('confirm.loss', file.name, file.lossy), { modal: true }, ok);
        if (pick !== ok) { return false; }
        file.confirmedLoss = true;
        return true;
    }

    /** 打开之后磁盘上的文件被别人改过？那就别默默覆盖 */
    async confirmFresh(file) {
        if (!file.mtime) { return true; }
        let now = 0;
        try { now = (await vscode.workspace.fs.stat(file.uri)).mtime; } catch { return true; }
        if (!now || now === file.mtime) { return true; }
        const ok = i18n.t('confirm.overwrite');
        const pick = await vscode.window.showWarningMessage(
            i18n.t('confirm.fresh', file.name), { modal: true }, ok);
        return pick === ok;
    }

    /** 写一个文件。`target` 给了就是"另存为"，不碰原文件、也不改它的未保存状态 */
    async writeFile(file, target) {
        let bytes;
        try {
            bytes = rebuild(file.parsed);
        } catch (err) {
            vscode.window.showErrorMessage(i18n.t('write.rebuildFailed', file.name, err.message));
            return false;
        }

        const uri = target || file.uri;
        if (!(await this.confirmLayout(file, !!target))) { return false; }
        if (!(await this.confirmLoss(file))) { return false; }
        if (!target && !(await this.confirmFresh(file))) { return false; }

        try {
            await vscode.workspace.fs.writeFile(uri, bytes);
        } catch (err) {
            vscode.window.showErrorMessage(i18n.t('write.targetFailed', view.label(uri), err.message));
            return false;
        }

        if (!target) {
            file.raw = bytes;
            file.byteStable = true;
            file.lossy = 0;
            file.edited = false;
            // 重写后内存里的 charOffset / length 已不准，拿写出去的字节重新解析；
            // 条目顺序不变，rows / indexes 重算后与页面那份一致。
            try { file.parsed = format.parse(bytes); } catch { /* parse 不抛异常，这里只是保险 */ }
            this.merge();
            this.recount();
            try { file.mtime = (await vscode.workspace.fs.stat(uri)).mtime; } catch { /* 无所谓 */ }
        }
        return true;
    }

    /** 保存所有改过的文件。返回真正写盘的个数 */
    async saveAll() {
        let written = 0;
        let skipped = 0;
        for (const file of this.files) {
            if (!file.edited) { continue; }
            if (await this.writeFile(file)) { written++; } else { skipped++; }
        }
        if (written || skipped) {
            this.recount();
            this.post({ type: 'dirty', files: this.files.map(f => !!f.edited) });
            this.notice(skipped
                ? i18n.t('save.savedSome', written, skipped)
                : i18n.t('save.savedAll', written));
        }
        return written;
    }

    /**
     * 「另存为」：把主文件当前内容写到目标路径，原文件与对照列不动
     * （多文件对照下语义是"导出一份 .btf"）。
     */
    async saveAs(target) {
        const primary = this.files[0];
        if (!primary) { return; }
        if (!(await this.writeFile(primary, target))) { return; }
        this.notice(i18n.t('save.savedAs', view.label(target)));

        // 「另存为」会让 VS Code 以为存过了；原文件里那些改动其实还没落盘，把脏标恢复回来
        if (this.dirty) {
            setTimeout(() => { if (this.dirty) { this.fire(); } }, 0);
        }
    }

    /* ---------------------------------------------------------- 热退出备份 */

    backupDir() {
        const base = this.context.storageUri || this.context.globalStorageUri;
        return vscode.Uri.joinPath(base, BACKUP_DIR);
    }

    /** 只备份改过的文件（按 id 贴回去，文件被换过也不会错位） */
    async backup() {
        const payload = {
            files: this.files.filter(f => f.edited).map(f => ({
                uri: f.uri.toString(),
                entries: f.parsed.entries.map(e => ({ id: e.id, text: e.text }))
            }))
        };
        const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        const dir = this.backupDir();
        await vscode.workspace.fs.createDirectory(dir);
        const target = vscode.Uri.joinPath(dir, id + '.json');
        await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(payload), 'utf8'));
        return {
            id,
            delete() { vscode.workspace.fs.delete(target).then(() => { /* 删掉就算了 */ }, () => { /* 已经没了也行 */ }); }
        };
    }

    async restoreBackup(backupId) {
        try {
            const target = vscode.Uri.joinPath(this.backupDir(), backupId + '.json');
            const raw = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
            const payload = JSON.parse(raw);
            for (const item of payload.files || []) {
                const file = this.files.find(f => f.uri.toString() === item.uri);
                if (!file) { continue; }
                const byId = new Map();
                for (const e of item.entries) { if (!byId.has(e.id)) { byId.set(e.id, e.text); } }
                for (const entry of file.parsed.entries) {
                    if (byId.has(entry.id) && byId.get(entry.id) !== entry.text) {
                        entry.text = byId.get(entry.id);
                        file.edited = true;
                    }
                }
                // 备份里有、文件里没有的 id：这次会话新增的条目，同样补回去（接在末尾即可）
                let added = false;
                for (const e of item.entries) {
                    if (!file.parsed.entries.some(x => x.id === e.id)) {
                        file.parsed.entries.push({
                            index: 0, id: e.id, charOffset: 0, length: 0,
                            text: e.text, textByteOffset: 0, terminated: true
                        });
                        file.edited = true;
                        added = true;
                    }
                }
                if (added) { file.parsed.entries.forEach((e, i) => { e.index = i; }); }
            }
            this.merge();
        } catch {
            // 备份读不到（被清了 / 文件没了）就当没这回事，损失只是那点没保存的改动
        }
    }

    /* ---------------------------------------------------------- 与页面对话 */

    attach(panel) {
        this.panel = panel;
    }

    detach(panel) {
        if (this.panel === panel) { this.panel = undefined; }
    }

    post(msg) {
        if (this.panel) { this.panel.webview.postMessage(msg); }
    }

    notice(text) {
        this.post({ type: 'notice', text });
    }

    /** meta（列与统计）→ 分块 rows → done → 脏标 */
    sendAll() {
        const primary = this.files[0];
        const total = this.rows.length;
        const sent = Math.min(total, MAX_ROWS);
        this.post({
            type: 'meta',
            primary: primary ? primary.path : '',
            total,
            sent,
            truncated: total > sent,
            columns: this.columns,
            problems: primary
                ? primary.parsed.problems.slice(0, MAX_PROBLEMS).map(p => ({ level: p.level, text: p.text }))
                : []
        });
        if (this.error) {
            this.post({ type: 'error', message: this.error });
        }
        for (let from = 0; from < sent; from += CHUNK) {
            this.post({ type: 'data', from, rows: this.rows.slice(from, Math.min(from + CHUNK, sent)) });
        }
        this.post({ type: 'done', loaded: sent });
        this.post({ type: 'dirty', files: this.files.map(f => !!f.edited) });
    }
}

/* ------------------------------------------------------------------ 提供者 */

/**
 * 可编辑自定义编辑器的提供者。
 * `onDidChangeCustomDocument` 必须在提供者上（VS Code 打开编辑器时会订阅它，放错地方就打不开）。
 * 事件本身带 `document`，所以多个文档共用一个 emitter。
 */
class BtfEditorProvider {
    constructor(context) {
        this.context = context;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeCustomDocument = this.emitter.event;
        /** 开着的面板 → 它的 nonce。语言换了要按新文案重建 HTML */
        this.panels = new Map();
    }

    dispose() {
        this.panels.clear();
        this.emitter.dispose();
    }

    /** 文档内容变了（编辑 / 保存 / 还原都算） */
    fire(document) {
        this.emitter.fire({ document });
    }

    /**
     * 语言换了：重建已打开对照视图的 HTML（骨架文案是宿主侧翻译的）。
     * 表格数据由页面重新发 `ready` 后补上；已关掉的面板写 html 会抛，忽略。
     */
    relayoutAll() {
        for (const [panel, nonce] of this.panels) {
            try { panel.webview.html = page.shellHtml(panel.webview, nonce); } catch { /* 面板已经没了 */ }
        }
    }

    async openCustomDocument(uri, openContext) {
        const document = new BtfDocument(uri, this.context, this);
        await document.open();
        if (openContext && openContext.backupId) {
            await document.restoreBackup(openContext.backupId);
        }
        return document;
    }

    async resolveCustomEditor(document, panel) {
        const nonce = String(Math.random()).slice(2) + String(Date.now());
        panel.webview.options = { enableScripts: true };
        this.panels.set(panel, nonce);      // 语言换了要按它重建 HTML（见 relayoutAll）
        panel.webview.html = page.shellHtml(panel.webview, nonce);
        document.attach(panel);

        /** 一条消息的处理，抽出来是为了统一接异常（见下面 onDidReceiveMessage） */
        const handle = async (msg) => {
            switch (msg.type) {
                /** 页面加载好（或切回标签页） */
                case 'ready':
                    document.sendAll();
                    // 从备份恢复出来的改动：现在才让 VS Code 知道它是脏的
                    if (document.dirty) { document.fire(); }
                    break;

                case 'edit':
                    document.edit(Number(msg.row), Number(msg.col), msg.text == null ? '' : String(msg.text));
                    break;

                case 'addEntry':
                    document.addEntry(Number(msg.row), Number(msg.col));
                    break;

                case 'save':
                    await document.saveAll();
                    break;

                case 'revert': {
                    if (document.dirty) {
                        const ok = i18n.t('revert.ok');
                        const pick = await vscode.window.showWarningMessage(
                            i18n.t('revert.confirm'), { modal: true }, ok);
                        if (pick !== ok) { return; }
                    }
                    await document.reload();
                    document.notice(i18n.t('revert.done'));
                    break;
                }

                case 'reload': {
                    if (document.dirty) {
                        const ok = i18n.t('reload.ok');
                        const pick = await vscode.window.showWarningMessage(
                            i18n.t('reload.confirm'), { modal: true }, ok);
                        if (pick !== ok) { return; }
                    }
                    await document.reload();
                    break;
                }

                case 'add': {
                    if (!document.files.length) { return; }
                    const loaded = new Set(document.files.map(f => f.uri.toString()));
                    const uri = await pickComparisonFile(document.files[0].uri, loaded);
                    if (uri) { await document.add(uri); }
                    break;
                }

                case 'remove':
                    document.remove(Number(msg.index));
                    break;

                case 'openText':
                    if (document.files.length) {
                        vscode.commands.executeCommand('wrsr.btf.openView', document.files[0].uri);
                    }
                    break;

                case 'export': {
                    if (!document.files.length) { return; }
                    const primary = document.files[0];
                    if (msg.kind === 'json' || document.files.length < 2) {
                        // JSON 是单文件格式；只有一列时 CSV 也是单文件的。
                        // 注意这里导出的是内存里的内容 —— 刚改过、还没保存的也算
                        const defaultUri = primary.uri.scheme === 'file'
                            ? primary.uri.with({ path: primary.uri.path + '.' + msg.kind })
                            : undefined;
                        await commands.exportParsed(msg.kind, primary.parsed, primary.path, defaultUri);
                        return;
                    }
                    const suffix = i18n.t('export.comparisonSuffix');
                    const base = primary.uri.scheme === 'file'
                        ? primary.uri.with({ path: primary.uri.path.replace(/\.btf$/i, '') + suffix })
                        : undefined;
                    await commands.exportComparison(document.columns.map(c => c.name), document.rows, base);
                    break;
                }

                case 'copy':
                    if (typeof msg.text === 'string' && msg.text) {
                        vscode.env.clipboard.writeText(msg.text).then(
                            () => vscode.window.setStatusBarMessage(i18n.t('copy.ok'), 2500),
                            () => vscode.window.showWarningMessage(i18n.t('copy.failed')));
                    }
                    break;

                default:
                    break;
            }
        };

        // 这个回调抛异常没人接，用户看到的就是"点了没反应"，所以统一接住并报出来。
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || !msg.type) { return; }
            try {
                await handle(msg);
            } catch (err) {
                const text = err && err.message ? err.message : String(err);
                const hint = /is not a function/.test(text) ? i18n.t('error.moduleHint') : '';
                vscode.window.showErrorMessage(i18n.t('error.prefix', text, hint));
                document.notice(i18n.t('error.action', text));
            }
        });

        panel.onDidDispose(() => { this.panels.delete(panel); document.detach(panel); });
    }

    /* --- VS Code 的保存 / 还原 / 备份三件套 --- */

    saveCustomDocument(document) {
        return document.saveAll().then(() => undefined);
    }

    saveCustomDocumentAs(document, destination) {
        return document.saveAs(destination);
    }

    revertCustomDocument(document) {
        return document.reload();
    }

    backupCustomDocument(document) {
        return document.backup();
    }
}

module.exports = { VIEW_TYPE, BtfEditorProvider };
