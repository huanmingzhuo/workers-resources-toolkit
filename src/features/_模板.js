'use strict';

/**
 * 新功能模块模板 —— 复制本文件、改名（例如 features/ini.js）即可开工。
 *
 * 这个文件不会被加载；复制出来的新文件要加进 extension.js 的 FEATURES 数组。
 *
 * ── 功能模块契约（权威定义就在这里）────────────────────────────
 *
 *   id                 必选   唯一标识
 *   displayName        必选   状态栏提示里显示的名字 —— 只是回退，
 *                            界面里实际显示的是 data/docs/<语言>/ui.json 的 `name`
 *   languageId         可选   要参与「打开文件时自动认类型」才填；
 *                            填了 core/detect.js 才会来问你的 detect()
 *   activate(context)  必选   注册本功能自己的 provider / 命令 / 设置监听
 *   detect(ctx)        可选   返回 0~100 的置信分；配合 languageId 使用
 *
 * ctx 里有什么（core/detect.js 组装，只用文档开头的文本）：
 *   ctx.head        开头若干行的文本
 *   ctx.fsPath      文件完整路径
 *   ctx.fileName    文件名
 *   ctx.languageId  当前语言 id
 *
 * ── 三条规矩 ────────────────────────────────────────────────
 *   1. 功能之间不许互相 require。要共用代码就放 src/core/，两边都引它。
 *   2. 每个功能自己管好自己的设置，键名统一挂在 wrsr.<功能>.* 下。
 *   3. 语言 id / scopeName 一旦发布就不能改 —— 用户的 files.associations 里写着它们。
 */

const vscode = require('vscode');

/** 必须和 package.json 里 contributes.languages 的 id 一致 */
const LANGUAGE_ID = 'replace-me';
const CONFIG_SECTION = 'wrsr.replace-me';

function activate(context) {
    // TODO: 注册 provider / 命令，把它们 push 进 context.subscriptions。
    // 例：
    // context.subscriptions.push(
    //     vscode.languages.registerHoverProvider(LANGUAGE_ID, {
    //         provideHover() { return undefined; }
    //     })
    // );
    void vscode;
    void CONFIG_SECTION;
}

/** 可选：要参与自动识别时才需要（同时要填 languageId） */
function detect(/* ctx */) {
    return 0;
}

module.exports = {
    id: LANGUAGE_ID,
    displayName: '替换成状态栏里显示的名字',
    languageId: LANGUAGE_ID,
    activate,
    detect
};
