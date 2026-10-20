'use strict';

/**
 * Pyrois 数据层 + 文档组装助手。
 *
 * 把本模块自带的数据读进来并对外提供查询：
 *   data/api.json      指令 / 结构体 / 常量 / 脚本函数（游戏 API 表）
 *   data/keywords.json 语言词表（if / for / define* …）
 *   data/docs/<语言>/  人工撰写的说明（经 docgen.js 按语言加载）
 *
 * api.json 取自游戏自带的 media_soviet/scripts/SOVIETInstructions.txt。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const docgen = require('./docgen');
/** 本模块的界面文案（由 docgen 装载） */
const i18n = require('../../core/i18n').use('pyrois');

/** 本模块自带的数据目录 */
const DATA_DIR = path.join(__dirname, 'data');

/* ------------------------------------------------------------------ 语言词表 */

/**
 * Pyrois 自己的词表，来自 data/keywords.json；说明在 data/docs/<语言>/keywords.json（docgen 加载）。
 *
 * 这些词不在游戏 API 表里（api.json 只有指令、结构体、常量、函数），所以单独放一张表：
 *
 *   control       控制关键字（语法规则 keyword.control）
 *   declarations  声明关键字（语法规则 keyword.other.declaration）
 *   types         内置类型（语法规则 storage.type）
 *   misc          其余语言词（main / include）
 *   docs          悬停 / 补全用的说明，sig = 签名，d = 一句说明
 *
 * 同目录的 pyrois.tmLanguage.json 里也有一份同样的词表，
 * 改词表时两处都要改，否则会「能补全但不高亮」。
 */
const keywords = {
    control: [],
    declarations: [],
    types: [],
    misc: [],
    docs: {}
};

function loadKeywords() {
    const file = path.join(DATA_DIR, 'keywords.json');
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        keywords.control = raw.control || [];
        keywords.declarations = raw.declarations || [];
        keywords.types = raw.types || [];
        keywords.misc = raw.misc || [];
        // 说明按语言来自 data/docs/<语言>/keywords.json（docgen 负责加载与回退）
        keywords.docs = docgen.getKeywordDocs();
    } catch (err) {
        console.error('[pyrois] 无法读取 data/keywords.json：', err);
    }
}

/* ------------------------------------------------------------------ API 数据 */

const api = {
    instructions: new Map(),
    structs: new Map(),
    constants: new Map(),
    functions: new Map()
};

let apiLoaded = false;

function loadApi() {
    if (apiLoaded) { return; }
    // 说明（含语言关键字说明）要先加载，loadKeywords 要从 docgen 取
    docgen.load(currentLocale());
    loadKeywords();
    const file = path.join(DATA_DIR, 'api.json');
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const it of raw.instructions || []) { api.instructions.set(it.name, it); }
        for (const st of raw.structs || []) { api.structs.set(st.name, st); }
        for (const c of raw.constants || []) { api.constants.set(c.name, c); }
        for (const f of raw.functions || []) { api.functions.set(f.name, f); }
        apiLoaded = true;
    } catch (err) {
        console.error('[pyrois] 无法读取 data/api.json：', err);
    }
}

/* ------------------------------------------------------------------ 语言选择 */

/** 当前语言：设置 `wrsr.language`，`auto` 时跟随 VS Code 显示语言；说明与界面文案共用 */
function currentLocale() {
    const raw = vscode.workspace.getConfiguration('wrsr').get('language', 'auto');
    if (!raw || raw === 'auto') { return vscode.env.language || ''; }
    return String(raw);
}

/** 语言设置变了：只重载说明，不重读 api.json */
function reloadDocs() {
    docgen.load(currentLocale());
    keywords.docs = docgen.getKeywordDocs();
}

/* ------------------------------------------------------------------ 签名 / 摘要 */

function signatureOfInstruction(it) {
    return `${it.name}(${it.params.map((t, i) => `arg${i + 1}: ${t}`).join(', ')})`;
}

function signatureOfFunction(fn) {
    const params = fn.params.map((p, i) => (p.name ? `${p.type} ${p.name}` : `${p.type} arg${i + 1}`));
    return `${fn.name}(${params.join(', ')}) → ${fn.returns}`;
}

function structSummary(st) {
    const fields = st.fields.map(f => `\`${f.type}${f.isArray ? '[]' : ''} ${f.name}\``).join(i18n.t('data.fieldSep'));
    return i18n.t('data.structSummary', st.name, st.id == null ? '?' : st.id, fields || i18n.t('data.noFields'));
}

/* ------------------------------------------------------------------ 文档内类型推断 */

/** 扫描本文件的 defineStructVariable / defineStructArray / defineStructInstruction，收集结构体成员 */
function localStructMembers(document) {
    const map = new Map();
    const ensure = (s) => { if (!map.has(s)) { map.set(s, { fields: [], methods: [] }); } return map.get(s); };
    const text = document.getText();
    let m;

    const reField = /\bdefineStruct(Variable|Array)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = reField.exec(text)) !== null) {
        ensure(m[2]).fields.push({
            type: m[3] + (m[1] === 'Array' ? '[]' : ''),
            name: m[4],
            line: document.positionAt(m.index).line,
            doc: document
        });
    }

    const reMethod = /\bdefineStructInstruction\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(?:[^,)]*)([^)]*)\)/g;
    while ((m = reMethod.exec(text)) !== null) {
        ensure(m[1]).methods.push({
            name: m[2],
            params: m[3].split(',').map(s => s.trim()).filter(Boolean),
            line: document.positionAt(m.index).line,
            doc: document
        });
    }

    return map;
}

/** 推断某个变量在本文档中的类型 */
function inferType(document, varName) {
    const text = document.getText();
    const patterns = [
        /\bdefineVariable\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
        /\bdefineArray\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m[2] === varName) { return m[1]; }
        }
    }
    // 函数参数：defineFunction(name, ret, type:param, type:param)
    const reFn = /\bdefineFunction\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*,([^)]*)\)/g;
    let mf;
    while ((mf = reFn.exec(text)) !== null) {
        for (const piece of mf[1].split(',')) {
            const pm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(piece);
            if (pm && pm[2] === varName) { return pm[1]; }
        }
    }
    return undefined;
}

/**
 * 一次扫完本文件，收集 Mod 自己声明的符号：
 *   defineInstruction(名字, 操作码, 类型…)    → instructions
 *   defineFunction(名字, 返回类型, 类型:参数…) → functions
 *   defineVariable(类型, 名字) / defineArray(类型[n], 名字) → variables
 */
function localDeclarations(document) {
    const text = document.getText();
    const out = { instructions: new Map(), functions: new Map(), variables: new Map(), structs: new Map() };
    let m;

    const lineAt = (index) => document.positionAt(index).line;

    const reInstr = /\bdefineInstruction\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(?:[^,)]*)([^)]*)\)/g;
    while ((m = reInstr.exec(text)) !== null) {
        out.instructions.set(m[1], {
            name: m[1],
            params: m[2].split(',').map(s => s.trim()).filter(Boolean),
            line: lineAt(m.index),
            doc: document
        });
    }

    const reFn = /\bdefineFunction\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,([^)]*))?\)/g;
    while ((m = reFn.exec(text)) !== null) {
        const params = (m[3] || '').split(',').map(s => s.trim().split(':')[0]).filter(Boolean);
        out.functions.set(m[1], { name: m[1], returns: m[2], params, line: lineAt(m.index), doc: document });
    }

    const reVar = /\bdefine(Variable|Array)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)(\s*\[[^\]]*\])?\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
    while ((m = reVar.exec(text)) !== null) {
        out.variables.set(m[4], {
            name: m[4],
            type: m[2] + (m[1] === 'Array' ? '[]' : ''),
            line: lineAt(m.index),
            doc: document
        });
    }

    const reStruct = /\bdefineStruct\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([^,)]*)/g;
    while ((m = reStruct.exec(text)) !== null) {
        out.structs.set(m[1], { name: m[1], id: m[2].trim(), line: lineAt(m.index), doc: document });
    }

    return out;
}

/**
 * 取某行上方紧邻的注释，当作悬停里的说明。
 * `//` / `///` / `//!` 与 `/* */` / `/** *​/` / `/*! *​/` 都认（Doxygen 注释原样保留）。
 */
/* ------------------------------------------------------------------ include 链 */

/** 本文件 include 的文件名（跳过 SOVIETInstructions.txt，它的内容已在 api.json 里） */
function includedNames(document) {
    const out = [];
    const re = /\binclude\s*\(\s*["']([^"']+)["']\s*\)/g;
    const text = document.getText();
    let m;
    while ((m = re.exec(text)) !== null) {
        if (!/^SOVIETInstructions\.txt$/i.test(m[1])) { out.push(m[1]); }
    }
    return out;
}

/** 把纯文本包成 TextDocument 的最小替身（解析只用到 getText / lineAt / positionAt） */
function textDocument(text) {
    const lines = text.split('\n');
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') { starts.push(i + 1); }
    }
    return {
        getText: () => text,
        lineCount: lines.length,
        lineAt: (i) => ({ text: lines[i] || '' }),
        positionAt: (offset) => {
            let lo = 0;
            let hi = starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (starts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
            }
            return new vscode.Position(lo, 0);
        }
    };
}

const includeCache = new Map();   // fsPath → { text, at }
const INCLUDE_CACHE_MS = 2000;

/** 读被 include 的文件（相对当前文件所在目录），2 秒缓存 */
async function readIncluded(document, name) {
    const uri = vscode.Uri.joinPath(document.uri, '..', name);
    const key = uri.fsPath;
    const hit = includeCache.get(key);
    if (hit && Date.now() - hit.at < INCLUDE_CACHE_MS) { return hit.text; }
    let text = '';
    try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
        text = '';
    }
    includeCache.set(key, { text, at: Date.now() });
    return text;
}

/** 本文件 + 一层 include 里声明的全部符号，本地优先 */
async function declarationsWithIncludes(document) {
    const own = localDeclarations(document);
    const out = {
        structs: new Map(own.structs),
        functions: new Map(own.functions),
        variables: new Map(own.variables),
        instructions: new Map(own.instructions),
        members: new Map(localStructMembers(document))
    };

    const mergeMap = (target, src) => {
        for (const [key, value] of src) {
            if (!target.has(key)) { target.set(key, value); }
        }
    };
    const mergeMembers = (target, src) => {
        for (const [name, m] of src) {
            if (!target.has(name)) { target.set(name, m); continue; }
            const t = target.get(name);
            t.fields = t.fields.concat(m.fields);
            t.methods = t.methods.concat(m.methods);
        }
    };

    for (const name of includedNames(document)) {
        const text = await readIncluded(document, name);
        if (!text) { continue; }
        const fake = textDocument(text);
        const decl = localDeclarations(fake);
        mergeMap(out.structs, decl.structs);
        mergeMap(out.functions, decl.functions);
        mergeMap(out.variables, decl.variables);
        mergeMap(out.instructions, decl.instructions);
        mergeMembers(out.members, localStructMembers(fake));
    }

    return out;
}

/**
 * 注释转 Markdown。识别 Doxygen 标签并把它们收成小节（参数 / 返回 / 备注 / 警告），
 * 没有标签的普通注释按原样保留换行。
 */
function doxygenMarkdown(text) {
    const plain = (s) => s.split('\n').map((l) => (l.trim() ? l.trim() + '  ' : '')).join('\n').trim();
    if (!text) { return ''; }
    if (!/@\w+/.test(text)) { return plain(text); }

    const brief = [];
    const params = [];
    const returns = [];
    const notes = [];
    const warnings = [];
    const sees = [];
    const examples = [];
    const deprecated = [];
    const todos = [];
    const authors = [];
    const versions = [];
    let current = 'brief';

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const m = /^@(\w+)\s*(.*)$/.exec(line);
        if (!m) {
            if (!line) { current = null; continue; }
            if (current === 'brief') { brief.push(line); }
            else if (current === 'param') { params[params.length - 1].text += ' ' + line; }
            else if (current === 'returns') { returns[returns.length - 1] += ' ' + line; }
            else if (current === 'notes') { notes[notes.length - 1] += ' ' + line; }
            else if (current === 'warnings') { warnings[warnings.length - 1] += ' ' + line; }
            else if (current === 'sees') { sees[sees.length - 1] += ' ' + line; }
            else if (current === 'examples') { examples[examples.length - 1] += ' ' + line; }
            else if (current === 'deprecated') { deprecated[deprecated.length - 1] += ' ' + line; }
            else if (current === 'todos') { todos[todos.length - 1] += ' ' + line; }
            else if (current === 'authors') { authors[authors.length - 1] += ' ' + line; }
            else if (current === 'versions') { versions[versions.length - 1] += ' ' + line; }
            continue;
        }

        const tag = m[1].toLowerCase();
        const rest = m[2].trim();
        if (tag === 'brief') {
            brief.push(rest);
            current = 'brief';
        } else if (tag === 'param' || tag === 'arg') {
            const pm = /^(\[[^\]]*\]\s*)?([A-Za-z_]\w*)\s*(?:[-–—]\s*)?(.*)$/.exec(rest);
            params.push(pm ? { name: pm[2], text: pm[3] } : { name: '', text: rest });
            current = 'param';
        } else if (tag === 'return' || tag === 'returns' || tag === 'retval') {
            returns.push(rest);
            current = 'returns';
        } else if (tag === 'note') {
            notes.push(rest);
            current = 'notes';
        } else if (tag === 'warning') {
            warnings.push(rest);
            current = 'warnings';
        } else if (tag === 'details') {
            brief.push(rest);
            current = 'brief';
        } else if (tag === 'see' || tag === 'sa') {
            sees.push(rest);
            current = 'sees';
        } else if (tag === 'example') {
            examples.push(rest);
            current = 'examples';
        } else if (tag === 'deprecated') {
            deprecated.push(rest);
            current = 'deprecated';
        } else if (tag === 'todo') {
            todos.push(rest);
            current = 'todos';
        } else if (tag === 'author') {
            authors.push(rest);
            current = 'authors';
        } else if (tag === 'version') {
            versions.push(rest);
            current = 'versions';
        } else {
            brief.push(line);
            current = 'brief';
        }
    }

    // 小节内的多行要补两个空格，否则 Markdown 会把它们并成一段
    const section = (key, lines) => (lines.length ? '**' + i18n.t(key) + '**\n' + lines.join('  \n') : '');
    const parts = [];
    if (brief.length) { parts.push(brief.join('  \n')); }
    if (params.length) {
        parts.push('**' + i18n.t('doxygen.params') + '**\n'
            + params.map((p) => (p.name ? `- \`${p.name}\` — ${p.text}` : `- ${p.text}`)).join('\n'));
    }
    for (const [key, lines] of [
        ['doxygen.returns', returns],
        ['doxygen.note', notes],
        ['doxygen.warning', warnings],
        ['doxygen.see', sees],
        ['doxygen.example', examples],
        ['doxygen.deprecated', deprecated],
        ['doxygen.todo', todos],
        ['doxygen.author', authors],
        ['doxygen.version', versions]
    ]) {
        const text = section(key, lines);
        if (text) { parts.push(text); }
    }
    return parts.join('\n\n');
}

function leadingComment(document, line) {
    const out = [];
    let i = line - 1;

    // 行注释（含 Doxygen 的 /// 与 Qt 风格的 //!）
    while (i >= 0) {
        const text = document.lineAt(i).text.trim();
        if (!text.startsWith('//')) { break; }
        if (/^\/\/\s*#?endregion\b/i.test(text)) { break; }
        if (/^\/\/\s*#?region\b/i.test(text)) {
            out.unshift(text.replace(/^\/\/\s*#?region\b\s*/, ''));
            return doxygenMarkdown(out.join('\n'));
        }
        out.unshift(text.replace(/^\/\/[/!]?\s?/, ''));
        i--;
    }
    if (out.length) { return doxygenMarkdown(out.join('\n')); }

    // 块注释：上一行必须是 */ 结尾，向上找开头
    if (line === 0) { return ''; }
    if (!document.lineAt(line - 1).text.trim().endsWith('*/')) { return ''; }

    let start = -1;
    for (let j = line - 1; j >= 0 && j >= line - 200; j--) {
        if (/^\/(\*+|\*+!)/.test(document.lineAt(j).text.trim())) { start = j; break; }
    }
    if (start < 0) { return ''; }

    for (let j = start; j < line; j++) {
        let text = document.lineAt(j).text.trim();
        if (j === start) { text = text.replace(/^\/\*+!?/, ''); }
        if (j === line - 1) { text = text.replace(/\*\/$/, ''); }
        text = text.replace(/^\*\s?/, '').trim();
        if (text) { out.push(text); }
    }
    return doxygenMarkdown(out.join('\n'));
}

/* ------------------------------------------------------------------ 文档组装 */

/**
 * 把说明追加进文档段落。
 * 没有任何说明时什么都不追加，悬停里就只剩签名。
 */
function pushDoc(body, info) {
    if (!info) { return; }
    body.push(info.text);
}

/** 关键字的悬停 / 补全文档：代码块签名 + 一句说明（说明来自 data/docs/<语言>/keywords.json） */
function keywordMarkdown(doc) {
    const parts = [];
    if (doc.sig) { parts.push(['```pyrois', doc.sig, '```'].join('\n')); }
    if (doc.d) { parts.push(doc.d); }
    return new vscode.MarkdownString(parts.join('\n\n'));
}

module.exports = {
    api,
    keywords,
    loadApi,
    reloadDocs,
    signatureOfInstruction,
    signatureOfFunction,
    structSummary,
    localStructMembers,
    localDeclarations,
    declarationsWithIncludes,
    includedNames,
    textDocument,
    readIncluded,
    leadingComment,
    inferType,
    pushDoc,
    keywordMarkdown
};
