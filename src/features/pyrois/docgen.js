'use strict';

/**
 * 人工说明：按语言查 `data/docs/<语言>/` 里的说明文字。
 *
 * 缺条目回退到默认语言（`zh-CN`），再找不到就返回 undefined（悬停里只显示签名）。
 *
 * 加载先垫默认语言，再用请求语言覆盖同键条目；目录匹配在 `core/i18n.js`。
 *
 * ## 目录约定
 *
 *     instructions.json   键 = 指令名 / 脚本函数名
 *     constants.json      键 = 常量名
 *     structs.json        按结构体分组：键 = 结构体名 → 成员名（字段与方法）
 *     keywords.json       键 = 语言关键字名，值是 { sig, d }（关键字不在游戏 API 表里）
 *     ui.json             键 = 界面文案（悬停 / 补全 / 大纲里的固定文字），交给 core/i18n
 *
 * 除 keywords.json 外，值是字符串，或者 `{ "d": "说明" }`。
 * 值为空字符串表示「还没写」，会被忽略。
 */

const fs = require('fs');
const path = require('path');
const i18n = require('../../core/i18n');

/** 说明目录根，每个语言一个子目录（用 __dirname 定位，不依赖插件安装路径） */
const DOCS_DIR = path.join(__dirname, 'data', 'docs');

/** 默认语言：缺条目回退到它 */
const DEFAULT_LOCALE = i18n.DEFAULT_LOCALE;

/** 本模块界面文案的命名空间 */
const UI_NAMESPACE = 'pyrois';

/**
 * 文件头的注释键。JSON 写不了注释，所以约定用它；运行时跳过它，不当成符号。
 *
 * 不能改成「只要以 `_` 开头就算注释」：`api.json` 里确实有以 `_` 开头的真实符号
 * （常量 `__IsDebugKey_Func_HlpVar_`、字段 `Resources._Resources_reserved_16_` … `_19_`），
 * 用前缀判断会把它们的说明一起吃掉。所以只认这一个键。
 */
const NOTE_KEY = '_note';

let docs = new Map();          // API 说明：键 → { text, by }
let keywordDocs = new Map();   // 语言关键字说明：键 → { sig, d }
let localeName = DEFAULT_LOCALE;

/* ---------------------------------------------------------------- 读取 */

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.error('[pyrois] 说明文件格式有错，已跳过：' + file + ' —— ' + err.message);
        return null;
    }
}

/** 读一份键值说明文件，写进 map（同键后写覆盖先写） */
function readDocFile(file, map) {
    const raw = readJson(file);
    if (!raw) { return; }
    for (const key of Object.keys(raw)) {
        if (key === NOTE_KEY) { continue; }
        const value = raw[key];
        const entry = typeof value === 'string' ? { text: value } : (value && { text: value.d });
        if (!entry || !entry.text) { continue; }
        map.set(key, entry);
    }
}

/**
 * 读结构体说明。它和别的说明文件不同，是按结构体嵌套的：
 *
 *     { "Building": { "nWorkersNum": "…", "nType": "…" } }
 *
 * 装进 map 时拍平成 `"Building.nWorkersNum"`（查询用的就是这种键）。
 */
function readStructFile(file, map) {
    const raw = readJson(file);
    if (!raw) { return; }
    for (const structName of Object.keys(raw)) {
        if (structName === NOTE_KEY) { continue; }
        const group = raw[structName];
        if (!group || typeof group !== 'object') { continue; }
        for (const memberName of Object.keys(group)) {
            const value = group[memberName];
            const entry = typeof value === 'string' ? { text: value } : (value && { text: value.d });
            if (!entry || !entry.text) { continue; }
            map.set(structName + '.' + memberName, entry);
        }
    }
}

/** 读一份语言关键字说明文件（值是 { sig, d }） */
function readKeywordDocFile(file, map) {
    const raw = readJson(file);
    if (!raw) { return; }
    for (const key of Object.keys(raw)) {
        if (key === NOTE_KEY) { continue; }
        const value = raw[key];
        // 签名或说明写了一个就收
        if (!value || (!value.sig && !value.d)) { continue; }
        map.set(key, { sig: value.sig || '', d: value.d || '' });
    }
}

/** 读一个语言目录下的全部说明 */
function readLocaleDir(dir, apiMap, kwMap) {
    readDocFile(path.join(dir, 'instructions.json'), apiMap);
    readDocFile(path.join(dir, 'constants.json'), apiMap);
    readStructFile(path.join(dir, 'structs.json'), apiMap);
    readKeywordDocFile(path.join(dir, 'keywords.json'), kwMap);
}

/* ---------------------------------------------------------------- 加载 */

/**
 * 加载说明。requestedLocale 由 data.js 给出（设置里的具体语言，auto 已被解析掉）。
 * 先读默认语言垫底，再用请求语言覆盖同键条目。
 */
function load(requestedLocale) {
    const apiMap = new Map();
    const kwMap = new Map();

    const matched = i18n.matchLocale(DOCS_DIR, requestedLocale);
    const chain = [];
    if (matched) { chain.push(matched); }
    if (chain.indexOf(DEFAULT_LOCALE) === -1) { chain.push(DEFAULT_LOCALE); }

    // 低优先级在前，高优先级覆盖它
    for (let i = chain.length - 1; i >= 0; i--) {
        readLocaleDir(path.join(DOCS_DIR, chain[i]), apiMap, kwMap);
    }

    docs = apiMap;
    keywordDocs = kwMap;
    localeName = matched || DEFAULT_LOCALE;

    // 界面文案（悬停 / 补全 / 大纲里的固定文字）跟着说明的语言一起切
    i18n.load(UI_NAMESPACE, DOCS_DIR, requestedLocale);
}

/* -------------------------------------------------------------- 对外接口 */

/** 查说明，没有就返回 undefined */
function lookup(key) {
    const curated = docs.get(key);
    return curated ? { text: curated.text } : undefined;
}

function describeMember(structName, member) {
    return lookup(structName + '.' + member.name);
}

function describeInstruction(instruction) {
    return lookup(instruction.name);
}

function describeConstant(constant) {
    return lookup(constant.name);
}

/** 查脚本函数说明（sin / cos / DistancePoints …）。和指令共用 instructions.json */
function describeFunction(fn) {
    return lookup(fn.name);
}

/** 语言关键字说明（键 → { sig, d }），供 data.js 装进 keywords.docs */
function getKeywordDocs() {
    const out = {};
    for (const [key, value] of keywordDocs) { out[key] = value; }
    return out;
}

module.exports = {
    load,
    describeMember,
    describeInstruction,
    describeConstant,
    describeFunction,
    getKeywordDocs
};
