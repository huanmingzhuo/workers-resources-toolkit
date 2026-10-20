'use strict';

/**
 * 功能模块：Pyrois 脚本
 *
 * 语法高亮由同目录的 pyrois.tmLanguage.json 提供（不需要运行时代码）；
 * 本模块负责补全、悬停文档、大纲符号、代码折叠、定义跳转。
 * 逻辑在同目录的 data / completion / hover / outline / definition / docgen 里，本文件只做装配。
 *
 * 数据在本模块的 data/ 下（api.json 的内容取自游戏自带的
 * media_soviet/scripts/SOVIETInstructions.txt）。
 *
 * 内部按关注点拆开，本文件只做装配与契约导出：
 *   data.js         data/ 下 api.json / keywords.json 的加载与查询，按设置选说明语言，签名 / 摘要助手
 *   completion.js   补全
 *   hover.js        悬停文档
 *   outline.js      大纲符号 + 代码折叠
 *   definition.js   定义跳转（文件名参数 / 本文件内 / 游戏 API 表）
 *   docgen.js       按语言加载 data/docs/<语言>/ 里人工撰写的说明，缺条目回退默认语言
 *
 */

const vscode = require('vscode');

const data = require('./data');
const { stripComments } = require('./comments');
const { PyroisCompletionProvider } = require('./completion');
const { PyroisHoverProvider } = require('./hover');
const { PyroisSymbolProvider, PyroisFoldingProvider } = require('./outline');
const { PyroisDefinitionProvider } = require('./definition');

/* ------------------------------------------------------------ 功能入口契约 */

/** 模块契约见 src/features/_模板.js；设置项统一挂在 wrsr.<功能>.* 下 */

let activeDisposables = [];

function register() {
    for (const d of activeDisposables) { d.dispose(); }
    activeDisposables = [];

    const cfg = vscode.workspace.getConfiguration('wrsr.pyrois');

    if (cfg.get('completion.enable', true)) {
        activeDisposables.push(vscode.languages.registerCompletionItemProvider(
            'pyrois', new PyroisCompletionProvider(), '.', '@'));
    }
    if (cfg.get('hover.enable', true)) {
        activeDisposables.push(vscode.languages.registerHoverProvider('pyrois', new PyroisHoverProvider()));
    }
    if (cfg.get('outline.enable', true)) {
        activeDisposables.push(vscode.languages.registerDocumentSymbolProvider('pyrois', new PyroisSymbolProvider()));
    }
    if (cfg.get('definition.enable', true)) {
        activeDisposables.push(vscode.languages.registerDefinitionProvider('pyrois', new PyroisDefinitionProvider()));
    }
    activeDisposables.push(vscode.languages.registerFoldingRangeProvider('pyrois', new PyroisFoldingProvider()));
}

function activate(context) {
    data.loadApi();
    register();

    context.subscriptions.push(
        { dispose() { for (const d of activeDisposables) { d.dispose(); } } },
        vscode.workspace.onDidChangeConfiguration(e => {
            const lang = e.affectsConfiguration('wrsr.language');
            if (!lang && !e.affectsConfiguration('wrsr.pyrois')) { return; }
            // 换了语言要重载说明与界面文案，其余设置只需重新注册 provider
            if (lang) { data.reloadDocs(); }
            register();
        })
    );
}

/* ------------------------------------------------------------ 自动识别判据 */

/**
 * 打分：这个文件像不像 Pyrois 脚本（0~100）。
 */
function detect(ctx) {
    // 注释里常拿 include("x.txt") 举例，先去注释再判断
    const code = stripComments(ctx.head);

    // ① 官方每个脚本开头都有这句，最强判据
    if (/include\s*\(\s*["']SOVIETInstructions\.txt["']\s*\)/i.test(code)) { return 100; }

    // ② 开头就是 define* 声明（有些自制脚本省掉了 include）
    if (/^\s*define(Function|Variable|Array|Instruction|Struct)\s*\(/m.test(code)) { return 85; }

    // ③ 路径特征：scenarios 目录下的 .txt（单独一条不够，作加权）
    if (/[\\/]scenarios[\\/][^\\/]+[\\/][^\\/]*\.txt$/i.test(ctx.fsPath)) { return 40; }

    // ④ 文件名特征：游戏原版脚本的固定名字
    if (/^(base|Tutorial|Objective|ArrowOnErrors|InfoScript_.+)\.txt$/i.test(ctx.fileName)) { return 35; }

    return 0;
}

module.exports = {
    id: 'pyrois',
    displayName: 'Pyrois 脚本',
    languageId: 'pyrois',
    activate,
    detect
};
