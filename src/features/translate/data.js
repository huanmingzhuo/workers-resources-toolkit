'use strict';

/**
 * 翻译工作台的数据层：把散在各处的文案摊成一张平表，负责写回与「添加语言」。
 * 不 require vscode、不碰 webview，纯读写逻辑，node 就能直接跑（自检用）。
 *
 * ## 三类文案（= 面板里的三个板块）
 *
 *   docs  说明数据
 *        src/features/pyrois/data/docs/<语言>/{instructions,constants,structs,keywords}.json
 *   ui    界面文案：每个功能模块一份
 *        src/features/<模块>/data/docs/<语言>/ui.json   ← 扫描发现
 *        src/core/ui/<语言>/ui.json
 *   manifest  清单文案：设置页说明、命令名、插件名
 *        package.nls.json（默认，英文）/ package.nls.<语言>.json
 *
 * ## 根目录由宿主指定
 *
 * 插件默认把安装目录当根，而翻译者要改的是仓库那份，所以宿主（index.js）负责调 `setRoot()`：
 * 先认工作区里含 `src/features/pyrois/data/docs` 的目录，找不到才退回安装目录，
 * 并把当前根目录显示在面板上。
 *
 * ## 写回
 *
 * 只碰被改的键：`_note` 与键序都不动；`JSON.stringify(v, null, 2)`，UTF-8 无 BOM。
 * 写不进去的要报出来：`save()` 返回 `{ written, skipped }`，skipped 带原因。
 */

const fs = require('fs');
const path = require('path');

/** 默认语言：新语言的原文与结构都取自它 */
const DEFAULT_LOCALE = 'zh-CN';

/** 当前编辑的根目录。默认是「本模块所在插件的根」，宿主负责改它 */
let ROOT = path.join(__dirname, '..', '..', '..');

function setRoot(dir) {
    if (dir) { ROOT = path.resolve(String(dir)); }
    return ROOT;
}
function root() { return ROOT; }
function featuresDir() { return path.join(ROOT, 'src', 'features'); }
function pyroisDocs() { return path.join(featuresDir(), 'pyrois', 'data', 'docs'); }
function coreUi() { return path.join(ROOT, 'src', 'core', 'ui'); }

/** 板块。面板先按它分大块，块内再按条目分小节 */
const SECTIONS = [
    { key: 'docs', labelKey: 'section.docs' },
    { key: 'ui', labelKey: 'section.ui' },
    { key: 'manifest', labelKey: 'section.manifest' }
];

/** 新建语言时，各说明文件顶上的 `_note` */
const HEADERS = {
    'instructions.json': 'Descriptions for low-level instructions and script functions. Key = name.',
    'constants.json': 'Descriptions for game constants. Key = constant name.',
    'structs.json': 'Descriptions for the fields and methods of structs. Grouped by struct: { "Building": { "nWorkersNum": "..." } }.',
    'keywords.json': 'Tooltip and completion docs for language keywords. Keys must exist in data/keywords.json (control / declarations / types / misc); a misspelled key will never show up. sig = signature, d = one-line description.',
    'ui.json': 'UI strings for hover / completion / outline. Key names are fixed; missing entries fall back to the default language. {0} is a placeholder.',
    'core-ui.json': 'UI strings for the core (status bar messages etc.). Key names are fixed; missing entries fall back to the default language. {0} is a placeholder.'
};

/* ------------------------------------------------------------------ 文件清单 */

/** 说明数据（pyrois 专有，形状特殊）。base 在 files() 里按当前 ROOT 算 */
const DOC_FILES = [
    { key: 'instructions', section: 'docs', name: 'instructions.json', kind: 'flat', labelKey: 'file.instructions' },
    { key: 'constants', section: 'docs', name: 'constants.json', kind: 'flat', labelKey: 'file.constants' },
    { key: 'structs', section: 'docs', name: 'structs.json', kind: 'structs', labelKey: 'file.structs' },
    { key: 'keywords', section: 'docs', name: 'keywords.json', kind: 'keywords', labelKey: 'file.keywords' }
];

/** 核心自己的界面文案 */
const CORE_FILE = { key: 'core-ui', section: 'ui', name: 'ui.json', kind: 'flat', labelKey: 'file.core-ui', noteKey: 'core-ui.json' };

/** 清单文案按模块拆成几条（`prefix` 决定这条收哪些键，`''` = 通用） */
const MANIFEST_FILES = [
    { key: 'manifest-general', section: 'manifest', kind: 'nls', prefix: '', labelKey: 'file.manifest.general' },
    { key: 'manifest-pyrois', section: 'manifest', kind: 'nls', prefix: 'pyrois', labelKey: 'file.manifest.pyrois' },
    { key: 'manifest-btf', section: 'manifest', kind: 'nls', prefix: 'btf', labelKey: 'file.manifest.btf' },
    { key: 'manifest-translate', section: 'manifest', kind: 'nls', prefix: 'translate', labelKey: 'file.manifest.translate' }
];

/** 清单文案里，一个键属于哪个模块（按键名里出现的模块名判断，`''` = 通用） */
function manifestGroupOf(key) {
    const k = key.toLowerCase();
    for (const module of ['pyrois', 'btf', 'translate']) {
        if (k.indexOf(module) >= 0) { return module; }
    }
    return '';
}

/** 扫出各功能模块自己的界面文案：src/features/<模块>/data/docs/<语言>/ui.json */
function moduleUiFiles() {
    const out = [];
    let dirs = [];
    try {
        dirs = fs.readdirSync(featuresDir(), { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
    } catch {
        return out;
    }

    for (const name of dirs) {
        const base = path.join(featuresDir(), name, 'data', 'docs');
        const defaultUi = path.join(base, DEFAULT_LOCALE, 'ui.json');
        if (!fs.existsSync(defaultUi)) { continue; }

        let moduleName = name;
        try {
            const dict = JSON.parse(fs.readFileSync(defaultUi, 'utf8'));
            if (dict && typeof dict.name === 'string' && dict.name) { moduleName = dict.name; }
        } catch { /* 读不了就退回目录名 */ }

        out.push({
            key: name + '-ui',
            section: 'ui',
            base,
            name: 'ui.json',
            kind: 'flat',
            labelKey: 'file.moduleUi',
            moduleName
        });
    }
    return out;
}

/** 全部条目。base 每次都按当前 ROOT 算（宿主换根之后立刻生效） */
function files() {
    const docs = pyroisDocs();
    const core = coreUi();
    const list = DOC_FILES.map(f => Object.assign({ base: docs }, f));
    list.push(Object.assign({ base: core }, CORE_FILE));
    return list.concat(moduleUiFiles(), MANIFEST_FILES);
}

/* ------------------------------------------------------------------ 路径 */

/** 清单文案的文件名：默认那份是英文，中文那份叫 zh-cn */
function manifestFileName(locale) {
    const loc = String(locale || '').toLowerCase();
    if (loc === 'en' || loc.indexOf('en-') === 0) { return 'package.nls.json'; }
    if (loc === 'zh-cn' || loc === 'zh-hans') { return 'package.nls.zh-cn.json'; }
    return 'package.nls.' + loc + '.json';
}

/** 某条在某个语言下的完整路径（清单那类特殊：语言写在文件名里） */
function filePath(fileKey, locale) {
    const file = files().find(f => f.key === fileKey);
    if (!file) { return undefined; }
    if (file.kind === 'nls') { return path.join(ROOT, manifestFileName(locale)); }
    return path.join(file.base, locale, file.name);
}

/** 现有语言目录：所有 base 目录下的子目录取并集 */
function locales() {
    const out = [];
    for (const file of files()) {
        if (file.kind === 'nls') { continue; }
        let entries = [];
        try { entries = fs.readdirSync(file.base, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isDirectory() && out.indexOf(e.name) === -1) { out.push(e.name); }
        }
    }
    out.sort((a, b) => (a === DEFAULT_LOCALE ? -1 : (b === DEFAULT_LOCALE ? 1 : a.localeCompare(b))));
    return out;
}

/* ------------------------------------------------------------------ 读 */

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            console.error('[translate] 文案文件格式有错，已按空处理：' + file + ' —— ' + err.message);
        }
        return null;
    }
}

/** 一个值里能显示的文字（字符串 / { d } / { sig, d } 都归一成文字） */
function textOf(value, kind) {
    if (value == null) { return ''; }
    if (typeof value === 'string') { return value; }
    if (kind === 'keywords') {
        return value.d ? String(value.d) : '';
    }
    return value.d ? String(value.d) : '';
}

/** `_note` 之外的键，按文件里的顺序 */
function keysOf(obj) {
    if (!obj || typeof obj !== 'object') { return []; }
    return Object.keys(obj).filter(k => k !== '_note');
}

/**
 * 摊平一个语言：返回条目数组 + 每条/每板块的统计。
 *
 * 顺序以目标语言文件自己的键序为准（翻译者正在填的就是这份），
 * 源语言里多出来、目标语言缺的键追加在后面。
 */
function load(targetLocale, sourceLocale) {
    const target = targetLocale || DEFAULT_LOCALE;
    const source = sourceLocale || (target === DEFAULT_LOCALE ? '' : DEFAULT_LOCALE);
    const entries = [];
    const stats = [];

    for (const file of files()) {
        const targetObj = readJson(filePath(file.key, target)) || {};
        // 原文一律取「原文语言」那份 —— 清单那类也一样。
        // （清单只是"语言写在文件名里"，不是"原文固定英文"。写死英文的结果就是
        //   原文 zh-CN / 译文 en-US 时两边都显示英文 —— 那是读错了文件，不是设计。）
        const sourceObj = source ? (readJson(filePath(file.key, source)) || {}) : targetObj;

        const rows = [];
        const sigOf = (v) => (v && typeof v === 'object' && v.sig) ? String(v.sig) : '';
        const pushFlat = (key, group, s, t) => {
            const text = textOf(t, file.kind);
            rows.push({
                id: file.key + ':' + (group ? group + '.' + key : key),
                file: file.key,
                group: group || '',
                key,
                source: textOf(s, file.kind),
                target: text,
                // 关键字行的签名：译文那份优先，没有就退回原文那份
                sig: file.kind === 'keywords' ? (sigOf(t) || sigOf(s)) : '',
                filled: text.trim().length > 0
            });
        };

        if (file.kind === 'structs') {
            const groups = [];
            for (const g of keysOf(sourceObj)) { if (groups.indexOf(g) === -1) { groups.push(g); } }
            for (const g of keysOf(targetObj)) { if (groups.indexOf(g) === -1) { groups.push(g); } }
            for (const g of groups) {
                const targetGroup = targetObj[g] || {};
                const sourceGroup = sourceObj[g] || {};
                const members = [];
                for (const m of keysOf(sourceGroup)) { if (members.indexOf(m) === -1) { members.push(m); } }
                for (const m of keysOf(targetGroup)) { if (members.indexOf(m) === -1) { members.push(m); } }
                for (const m of members) { pushFlat(m, g, sourceGroup[m], targetGroup[m]); }
            }
        } else if (file.kind === 'nls') {
            const keys = [];
            for (const k of keysOf(sourceObj)) { if (keys.indexOf(k) === -1) { keys.push(k); } }
            for (const k of keysOf(targetObj)) { if (keys.indexOf(k) === -1) { keys.push(k); } }
            for (const k of keys) {
                if (manifestGroupOf(k) !== file.prefix) { continue; }
                pushFlat(k, '', sourceObj[k], targetObj[k]);
            }
        } else {
            const keys = [];
            for (const k of keysOf(sourceObj)) { if (keys.indexOf(k) === -1) { keys.push(k); } }
            for (const k of keysOf(targetObj)) { if (keys.indexOf(k) === -1) { keys.push(k); } }
            for (const k of keys) { pushFlat(k, '', sourceObj[k], targetObj[k]); }
        }

        entries.push(...rows);
        stats.push({
            file: file.key,
            section: file.section,
            label: file.labelKey,
            total: rows.length,
            filled: rows.filter(r => r.filled).length
        });
    }

    const sectionStats = SECTIONS.map(s => {
        const mine = stats.filter(x => x.section === s.key);
        return {
            key: s.key,
            labelKey: s.labelKey,
            total: mine.reduce((n, x) => n + x.total, 0),
            filled: mine.reduce((n, x) => n + x.filled, 0)
        };
    }).filter(s => s.total > 0);

    return {
        root: ROOT,
        target,
        source,
        entries,
        stats,
        sectionStats,
        total: entries.length,
        filled: entries.filter(e => e.filled).length
    };
}

/* ------------------------------------------------------------------ 写 */

/**
 * 把改动应用到一个对象上。写不进去的记进 `skipped`（附原因），不静默跳过。
 * 原因码：no-group（结构体分组不存在）/ no-key（目标文件里没有这个键）。
 */
function applyChanges(file, obj, list, skipped) {
    let touched = false;
    for (const c of list) {
        const text = c.text == null ? '' : String(c.text);
        if (file.kind === 'structs') {
            const group = obj[c.group];
            if (!group || typeof group !== 'object') {
                skipped.push({ file: file.key, group: c.group, key: c.key, reason: 'no-group' });
                continue;
            }
            const old = group[c.key];
            const next = text;
            if (JSON.stringify(old) === JSON.stringify(next)) { continue; }
            group[c.key] = next;
            touched = true;
        } else {
            const old = obj[c.key];
            if (old === undefined) {
                skipped.push({ file: file.key, group: '', key: c.key, reason: 'no-key' });
                continue;
            }
            let next;
            if (file.kind === 'keywords') {
                const sig = (old && typeof old === 'object' && old.sig) ? old.sig : '';
                next = { sig, d: text };
            } else {
                next = text;
            }
            if (JSON.stringify(old) === JSON.stringify(next)) { continue; }
            obj[c.key] = next;
            touched = true;
        }
    }
    return touched;
}

/**
 * 把改动写回文件。`changes` 里的每项：{ file, group, key, text }。
 * 返回 `{ written, skipped }`：written 是写过的文件路径，skipped 是没写进去的键 + 原因。
 */
function save(targetLocale, changes) {
    const written = [];
    const skipped = [];
    const byFile = new Map();
    for (const c of changes || []) {
        if (!byFile.has(c.file)) { byFile.set(c.file, []); }
        byFile.get(c.file).push(c);
    }

    for (const [fileKey, list] of byFile) {
        const file = files().find(f => f.key === fileKey);
        if (!file) {
            for (const c of list) { skipped.push({ file: fileKey, group: c.group, key: c.key, reason: 'no-file' }); }
            continue;
        }
        const full = filePath(fileKey, targetLocale);

        if (file.kind === 'nls') {
            // 目标语言还没有清单文件时，以默认那份为底新建一份（值先留空）
            const obj = readJson(full) || buildSkeleton(file, readJson(filePath(fileKey, 'en')) || {});
            if (applyChanges(file, obj, list, skipped)) {
                fs.writeFileSync(full, JSON.stringify(obj, null, 2) + '\n', 'utf8');
                written.push(full);
            }
            continue;
        }

        const obj = readJson(full);
        if (!obj) {
            for (const c of list) { skipped.push({ file: fileKey, group: c.group, key: c.key, reason: 'no-file' }); }
            continue;
        }
        if (applyChanges(file, obj, list, skipped)) {
            fs.writeFileSync(full, JSON.stringify(obj, null, 2) + '\n', 'utf8');
            written.push(full);
        }
    }

    return { written, skipped };
}

/* ------------------------------------------------------------------ 添加语言 */

/** 这个条目在某个语言下的文件是否已经存在 */
function hasLocaleFile(file, locale) {
    return fs.existsSync(filePath(file.key, locale));
}

/** 以 `from` 为底做出空骨架（值留空、键序照抄、`_note` 用英文表头） */
function buildSkeleton(file, from) {
    const out = {};
    const noteKey = file.noteKey || file.name;
    // `_note` 一律用英文表头：新语言的读者未必看得懂默认语言（zh-CN）的说明
    if (HEADERS[noteKey] || HEADERS[file.name]) {
        out._note = HEADERS[noteKey] || HEADERS[file.name];
    } else if (from && typeof from._note === 'string' && from._note) {
        out._note = from._note;
    }

    if (file.kind === 'structs') {
        for (const g of keysOf(from)) {
            const group = {};
            for (const m of keysOf(from[g])) { group[m] = ''; }
            out[g] = group;
        }
    } else {
        for (const k of keysOf(from)) {
            out[k] = (file.kind === 'keywords') ? { sig: '', d: '' } : '';
        }
    }
    return out;
}

/**
 * 给一门新语言把结构一次铺齐：每份文件都按默认语言（清单按英文那份）的键序建好、值为空；
 * 已存在的文件只补缺的键，已写的内容不动。返回 { locale, created:[…], aligned:[…] }。
 */
function addLocale(locale, from) {
    const target = String(locale || '').trim();
    if (!target) { throw new Error('locale is empty'); }
    const base = from || DEFAULT_LOCALE;

    const created = [];
    const aligned = [];

    for (const file of files()) {
        if (file.kind === 'nls') { continue; }
        const full = filePath(file.key, target);
        const existing = readJson(full);
        if (!existing) {
            const fromObj = readJson(filePath(file.key, base)) || {};
            const skeleton = buildSkeleton(file, fromObj);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
            created.push(full);
            continue;
        }
        const fromObj = readJson(filePath(file.key, base)) || {};
        const merged = buildSkeleton(file, fromObj);
        let added = 0;
        const copyInto = (dst, src) => {
            for (const k of Object.keys(src)) {
                if (k === '_note') { continue; }
                if (dst[k] === undefined) { dst[k] = src[k]; added++; }
            }
        };
        if (file.kind === 'structs') {
            for (const g of keysOf(merged)) {
                if (existing[g] === undefined) { existing[g] = {}; added++; }
                copyInto(existing[g], merged[g]);
            }
        } else {
            copyInto(existing, merged);
        }
        if (added) {
            fs.writeFileSync(full, JSON.stringify(existing, null, 2) + '\n', 'utf8');
            aligned.push(full);
        }
    }

    if (!hasLocaleFile(MANIFEST_FILES[0], target)) {
        const en = readJson(filePath('manifest-general', 'en')) || {};
        const skeleton = {};
        for (const k of keysOf(en)) { skeleton[k] = ''; }
        if (keysOf(skeleton).length) {
            const full = filePath('manifest-general', target);
            fs.writeFileSync(full, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
            created.push(full);
        }
    }

    return { locale: target, created, aligned };
}

/* ------------------------------------------------------------------ 键同步 */

/**
 * 把默认语言的键集合同步到其他语言。
 *
 * 差集（默认语言有、目标语言没有）补空占位，追加在文件末尾，已有译文不动；
 * 多余键（目标语言有、默认语言没有）只在 `remove` 为真时删除，否则只报出来 ——
 * 那可能是默认语言漏加的，直接删会把内容弄丢。
 *
 * 只处理 docs / ui 这类文件；清单文案的语言写在文件名里，不在此列。
 * 目标语言缺整份文件时跳过，交给「添加语言…」。
 *
 * @param {{ from?: string, dryRun?: boolean, remove?: boolean }} [options]
 * @returns {{ from: string, locales: Array<{ locale: string, added: string[], removed: string[], files: number }> }}
 */
function syncKeys(options) {
    const opt = options || {};
    const base = opt.from || DEFAULT_LOCALE;
    const dryRun = !!opt.dryRun;
    const remove = !!opt.remove;

    const out = [];
    for (const locale of locales()) {
        if (locale === base) { continue; }

        const added = [];
        const removed = [];
        let fileCount = 0;

        for (const file of files()) {
            if (file.kind === 'nls') { continue; }
            const full = filePath(file.key, locale);
            const existing = readJson(full);
            if (!existing) { continue; }
            const fromObj = readJson(filePath(file.key, base)) || {};
            let touched = false;

            if (file.kind === 'structs') {
                for (const g of keysOf(fromObj)) {
                    const srcGroup = fromObj[g];
                    if (!srcGroup || typeof srcGroup !== 'object') { continue; }
                    let dstGroup = existing[g];
                    if (!dstGroup || typeof dstGroup !== 'object') {
                        dstGroup = {};
                        if (!dryRun) { existing[g] = dstGroup; }
                    }
                    for (const m of keysOf(srcGroup)) {
                        if (dstGroup[m] === undefined) {
                            added.push(g + '.' + m);
                            if (!dryRun) { dstGroup[m] = ''; touched = true; }
                        }
                    }
                }
                for (const g of keysOf(existing)) {
                    const dstGroup = existing[g];
                    if (!dstGroup || typeof dstGroup !== 'object') { continue; }
                    const srcGroup = fromObj[g] || {};
                    for (const m of keysOf(dstGroup)) {
                        if (srcGroup[m] === undefined) {
                            removed.push(g + '.' + m);
                            if (remove && !dryRun) { delete dstGroup[m]; touched = true; }
                        }
                    }
                }
            } else {
                for (const k of keysOf(fromObj)) {
                    if (existing[k] === undefined) {
                        added.push(k);
                        if (!dryRun) {
                            existing[k] = (file.kind === 'keywords') ? { sig: '', d: '' } : '';
                            touched = true;
                        }
                    }
                }
                for (const k of keysOf(existing)) {
                    if (fromObj[k] === undefined) {
                        removed.push(k);
                        if (remove && !dryRun) { delete existing[k]; touched = true; }
                    }
                }
            }

            if (!dryRun && touched) {
                fs.writeFileSync(full, JSON.stringify(existing, null, 2) + '\n', 'utf8');
                fileCount++;
            }
        }

        if (added.length || removed.length) {
            out.push({ locale, added, removed, files: fileCount });
        }
    }

    return { from: base, locales: out };
}

module.exports = {
    DEFAULT_LOCALE,
    SECTIONS,
    setRoot,
    root,
    files,
    locales,
    filePath,
    load,
    save,
    addLocale,
    syncKeys,
    textOf
};
