    'use strict';

    /**
     * 文件类型识别
     *
     * 这个游戏的文件没有独占后缀，类型判定只能靠「路径 + 内容」判断。
     *
     * 文档打开时依次询问各功能模块的 `detect(ctx)`，取最高分；超过阈值就切换语言。
     *
     * 注意：只有同时带了 `languageId` 的功能模块才会被询问（见下面 consider 里的判断）——
     * 契约见 src/features/_模板.js。
     *
     */

    const vscode = require('vscode');
    const i18n = require('./i18n');

    /** 核心自己的界面文案（src/core/ui/<语言>/ui.json，由 extension.js 装载） */
    const coreUi = i18n.use('core');

    /** 允许被自动接管的语言 id。不在这个集合里的一律不动 */
    const UPGRADABLE = new Set(['plaintext', 'ini', 'properties', '']);

    /**
     * 只看开头这么多行
     * 不能太少，否则会误判；也不能太多，否则会漏判。
     */
    const HEAD_LINES = 100;

    /** 置信度阈值 */
    const MIN_SCORE = 60;

    let features = [];
    const decided = new WeakSet();

    function enabled() {
        return vscode.workspace.getConfiguration('wrsr.detect').get('enable', true);
    }

    /**
     * 只读开头若干行。
     */
    function readHead(doc) {
        const n = Math.min(HEAD_LINES, doc.lineCount);
        const lines = [];
        for (let i = 0; i < n; i++) { lines.push(doc.lineAt(i).text); }
        return lines.join('\n');
    }

    function consider(doc) {
        if (!enabled()) { return; }
        if (!doc || doc.uri.scheme !== 'file') { return; }
        if (decided.has(doc)) { return; }

        if (!UPGRADABLE.has(doc.languageId)) { decided.add(doc); return; }

        const parts = doc.uri.path.split('/');
        const ctx = {
            head: readHead(doc),
            fsPath: doc.uri.fsPath || '',
            fileName: parts[parts.length - 1] || '',
            languageId: doc.languageId
        };

        let best = null;
        for (const feature of features) {
            if (typeof feature.detect !== 'function' || !feature.languageId) { continue; }
            const score = feature.detect(ctx) || 0;
            if (score > 0 && (!best || score > best.score)) {
                best = { feature, score };
            }
        }

        decided.add(doc);
        if (!best || best.score < MIN_SCORE) { return; }
        if (best.feature.languageId === doc.languageId) { return; }

        // 状态栏那句也要多语言：功能模块的名字取它自己命名空间里的 `name`
        const featureUi = i18n.use(best.feature.id);
        const shownName = featureUi.has('name') ? featureUi.t('name') : best.feature.displayName;

        vscode.languages.setTextDocumentLanguage(doc, best.feature.languageId).then(
            () => vscode.window.setStatusBarMessage(coreUi.t('detect.autoSwitched', shownName), 4000),
            () => { /* 切换失败不值得打扰用户，静默即可 */ }
        );
    }

    function initialize(context, featureList) {
        features = featureList;

        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(consider)
        );

        // 插件激活时已经开着的那些文档也要过一遍
        for (const doc of vscode.workspace.textDocuments) { consider(doc); }
    }

    module.exports = { initialize, consider };
