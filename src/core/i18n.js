'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 界面文案：按语言加载、按命名空间取用。
 *
 * 加载时先垫默认语言（`zh-CN`）再用目标语言覆盖同键条目，翻译了多少显示多少；
 * `t()` 的 `{0}` / `{1}` 是占位符，查不到就原样返回 key。
 *
 * 核心文案在 `src/core/ui/<语言>/ui.json`，各功能模块的在自己目录的
 * `data/docs/<语言>/ui.json`；命名空间把键隔开。
 */

/** 默认语言：缺条目回退到它 */
const DEFAULT_LOCALE = 'zh-CN';

/** 文件头的注释键，读 ui.json 时跳过 */
const NOTE_KEY = '_note';

const store = Object.create(null);   // 命名空间 → { 键: 文案 }
const locales = Object.create(null); // 命名空间 → 实际装载的语言目录名

/** 取某个命名空间的文案入口 */
function use(namespace) {
    const ns = String(namespace || 'app');
    return {
        /** 整体替换本命名空间的文案 */
        set(map) {
            const dict = Object.create(null);
            if (map) {
                for (const key of Object.keys(map)) {
                    if (typeof map[key] === 'string' && map[key]) { dict[key] = map[key]; }
                }
            }
            store[ns] = dict;
        },

        has(key) {
            const dict = store[ns];
            return !!dict && Object.prototype.hasOwnProperty.call(dict, key);
        },

        t(key, ...args) {
            const dict = store[ns];
            const text = (dict && Object.prototype.hasOwnProperty.call(dict, key)) ? dict[key] : key;
            if (!args.length) { return text; }
            return String(text).replace(/\{(\d+)\}/g,
                (m, i) => (args[Number(i)] === undefined ? m : String(args[Number(i)])));
        },

        /** 整份文案的浅拷贝，给 webview 用 */
        dump() {
            return Object.assign({}, store[ns]);
        },

        /** 实际装载的语言目录名（如 `zh-CN`） */
        locale() {
            return locales[ns] || DEFAULT_LOCALE;
        }
    };
}

/** baseDir 下现有哪些语言目录 */
function localeDirs(baseDir) {
    try {
        return fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    } catch {
        return [];
    }
}

/**
 * 把语言标识匹配到实际存在的目录名（忽略大小写，`en-US` 也能落到 `en`）。
 * 匹配不到返回 `null`。
 */
function matchLocale(baseDir, requested) {
    if (!requested) { return null; }
    const want = String(requested).toLowerCase();
    const dirs = localeDirs(baseDir);

    let hit = dirs.find(d => d.toLowerCase() === want);
    if (hit) { return hit; }

    const base = want.split('-')[0];
    if (!base) { return null; }
    hit = dirs.find(d => d.toLowerCase() === base);
    if (hit) { return hit; }
    hit = dirs.find(d => d.toLowerCase().split('-')[0] === base);
    return hit || null;
}

/**
 * 加载一个命名空间的文案（按语言链合并）；返回实际匹配到的语言目录名。
 */
function load(namespace, baseDir, requested) {
    const matched = matchLocale(baseDir, requested);
    const chain = [];
    if (matched) { chain.push(matched); }
    if (chain.indexOf(DEFAULT_LOCALE) === -1) { chain.push(DEFAULT_LOCALE); }

    const dict = {};
    for (let i = chain.length - 1; i >= 0; i--) {   // 低优先级在前，高优先级覆盖
        const file = path.join(baseDir, chain[i], 'ui.json');
        let raw = null;
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            if (err && err.code !== 'ENOENT') {
                console.error('[i18n] ui.json 格式有错，已跳过：' + file + ' —— ' + err.message);
            }
        }
        if (!raw) { continue; }
        for (const key of Object.keys(raw)) {
            if (key === NOTE_KEY) { continue; }
            if (typeof raw[key] === 'string' && raw[key]) { dict[key] = raw[key]; }
        }
    }

    const locale = matched || DEFAULT_LOCALE;
    locales[String(namespace || 'app')] = locale;
    use(namespace).set(dict);
    return locale;
}

module.exports = { use, load, matchLocale, DEFAULT_LOCALE };
