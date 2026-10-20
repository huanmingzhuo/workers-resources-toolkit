'use strict';

/**
 * 插件入口
 *
 * 只做三件事：初始化公共基础设施、装载核心文案、注册各功能模块。各功能自己负责
 * 补全 / 悬停 / 命令 / 设置，互不依赖。
 *
 * 加一个新功能三步走（契约见 src/features/_模板.js，漏填 / 填错只会静默失效）：
 *   1. 复制 src/features/_模板.js、改名成 <名字>.js，把契约字段填上
 *   2. 在下面的 FEATURES 数组里加一行 require('./features/<名字>')
 *   3. 在 package.json 的 contributes 里声明它贡献什么
 *
 * 契约字段：id / displayName / activate 必选，languageId / detect 可选。
 *
 * 界面文案跟随 `wrsr.language`（`auto` = 显示语言）：核心的在 `src/core/ui/`，
 * 模块的在自己目录的 `data/docs/<语言>/ui.json`。
 *
 * 已发布后不要改：语言 id（如 pyrois）、scopeName（如 source.pyrois）——
 * 用户的 files.associations 里写着它们。
 */

const path = require('path');
const vscode = require('vscode');

const detect = require('./core/detect');
const i18n = require('./core/i18n');

const FEATURES = [
    require('./features/pyrois'),    // Pyrois 脚本语言
    require('./features/btf'),       // BTF 文件（只读视图 / 结构校验 / 导出）
    require('./features/translate'), // 翻译工作台（给人工说明的翻译者用，一条命令开面板）

    // —— 以下是规划中的功能，实现时取消注释并新建对应文件 ——
    // require('./features/ini'),     // 游戏 ini 方言（building.ini / workshopconfig.ini / script.ini）
    // require('./features/model'),   // NMF / NAF / BBOX 二进制结构查看
    // require('./features/check'),   // Mod 工程检查 / 校验命令
];

/** 核心的界面文案目录 */
const CORE_UI_DIR = path.join(__dirname, 'core', 'ui');

/** 当前语言：设置 `wrsr.language`，`auto` 时跟随 VS Code 的显示语言 */
function currentLocale() {
    const raw = vscode.workspace.getConfiguration('wrsr').get('language', 'auto');
    if (!raw || raw === 'auto') { return vscode.env.language || ''; }
    return String(raw);
}

function loadCoreTexts() {
    i18n.load('core', CORE_UI_DIR, currentLocale());
}

function activate(context) {
    loadCoreTexts();

    // 识别服务是公共设施：游戏文件没有独占后缀，所有功能都靠它判断类型
    detect.initialize(context, FEATURES);

    for (const feature of FEATURES) {
        feature.activate(context);
    }

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('wrsr.language')) { loadCoreTexts(); }
    }));
}

function deactivate() { }

module.exports = { activate, deactivate };
