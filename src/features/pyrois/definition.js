'use strict';

/**
 * 定义跳转：Ctrl+点击 / F12 跳到定义。
 *
 * 三个来源：
 *   ⓪ 文件名参数：`include("SOVIETInstructions.txt")` 里的字符串，或
 *      `Script_Exists("TimeFlow.txt", r)` / `Script_StartNew("x.txt")` /
 *      `Script_DestroyByName("x.txt")` 的文件名参数，直接打开那个文件
 *   ① 本文件内的声明：defineVariable / defineFunction / defineStruct / defineStructVariable …
 *   ② 游戏自带的 API 表：顺着脚本开头的 include 找到那个文件，查 defineInstruction /
 *      defineStructVariable / defineStructInstruction
 *
 * 索引按「文档 + 版本号」缓存：文档没改就复用，改过才重建。
 * 本文件和 API 表用同一个 buildDefinitionIndex。
 */

const vscode = require('vscode');
const path = require('path');
const data = require('./data');
const { stripComments } = require('./comments');

const definitionIndexCache = new Map();
const apiUriCache = new Map();
const INDEX_CACHE_LIMIT = 50;

function buildDefinitionIndex(document) {
    const key = document.uri.toString() + ':' + document.version;
    const cached = definitionIndexCache.get(key);
    if (cached) { return cached; }

    const text = document.getText();
    const defs = new Map();      // 名字 → Location
    const members = new Map();   // "结构体.成员" → Location

    const put = (map, name, index) => {
        if (!name || map.has(name)) { return; }
        const at = Math.max(0, Math.min(index, text.length));
        map.set(name, new vscode.Location(document.uri, document.positionAt(at)));
    };

    let m;

    // defineVariable(int, i) / defineArray(int[1], xs) —— 抓第二个参数
    const reVar = /\bdefine(?:Variable|Array)\s*\(\s*[A-Za-z_]\w*\s*(?:\[[^\]]*\])?\s*,\s*([A-Za-z_]\w*)/g;
    while ((m = reVar.exec(text)) !== null) { put(defs, m[1], m.index + m[0].lastIndexOf(m[1])); }

    // defineFunction(name, ret, ...)
    const reFunc = /\bdefineFunction\s*\(\s*([A-Za-z_]\w*)/g;
    while ((m = reFunc.exec(text)) !== null) { put(defs, m[1], m.index + m[0].lastIndexOf(m[1])); }

    // 函数参数：defineFunction(name, ret, float:param, vec3:pos)
    const reFuncArgs = /\bdefineFunction\s*\(([^)]*)\)/g;
    while ((m = reFuncArgs.exec(text)) !== null) {
        const base = m.index + m[0].indexOf('(') + 1;
        let offset = 0;
        for (const piece of m[1].split(',')) {
            const colon = piece.indexOf(':');
            if (colon >= 0) {
                const pname = piece.slice(colon + 1).trim();
                if (/^[A-Za-z_]\w*$/.test(pname)) {
                    put(defs, pname, base + offset + piece.indexOf(pname, colon));
                }
            }
            offset += piece.length + 1;
        }
    }

    // defineStruct(Name, id)
    const reStruct = /\bdefineStruct\s*\(\s*([A-Za-z_]\w*)/g;
    while ((m = reStruct.exec(text)) !== null) { put(defs, m[1], m.index + m[0].lastIndexOf(m[1])); }

    // defineInstruction(name, opcode, ...)
    const reInstr = /\bdefineInstruction\s*\(\s*([A-Za-z_]\w*)/g;
    while ((m = reInstr.exec(text)) !== null) { put(defs, m[1], m.index + m[0].lastIndexOf(m[1])); }

    // defineStructVariable(Building, int, nType) / defineStructArray(...)
    const reField = /\bdefineStruct(?:Variable|Array)\s*\(\s*([A-Za-z_]\w*)\s*,\s*[A-Za-z_]\w*\s*,\s*([A-Za-z_]\w*)/g;
    while ((m = reField.exec(text)) !== null) { put(members, m[1] + '.' + m[2], m.index + m[0].lastIndexOf(m[2])); }

    // defineStructInstruction(Building, GetDataByIndex, 10000, ...)
    const reMethod = /\bdefineStructInstruction\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)/g;
    while ((m = reMethod.exec(text)) !== null) { put(members, m[1] + '.' + m[2], m.index + m[0].lastIndexOf(m[2])); }

    const index = { defs, members };
    if (definitionIndexCache.size > INDEX_CACHE_LIMIT) { definitionIndexCache.clear(); }
    definitionIndexCache.set(key, index);
    return index;
}

/** 猜 include 的文件可能在哪（候选路径，调用方逐个试）。 */
function candidateApiPaths(document, relative) {
    if (document.uri.scheme !== 'file') { return []; }
    const rel = relative.replace(/\\/g, '/');
    const startDir = path.dirname(document.uri.fsPath);
    const out = [];
    const seen = new Set();

    const push = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };

    let cur = startDir;
    for (let i = 0; i < 8; i++) {
        push(path.join(cur, rel));
        const parent = path.dirname(cur);
        if (parent === cur) { break; }
        cur = parent;
    }

    const lower = startDir.toLowerCase();
    const idx = lower.lastIndexOf('media_soviet');
    if (idx >= 0) { push(path.join(startDir.slice(0, idx), 'media_soviet', 'scripts', rel)); }

    // Steam 创意工坊：.../steamapps/workshop/content/<app>/<mod>/ → 游戏在同一个 steamapps/common/ 下
    const steam = /^(.*[\\/]steamapps)[\\/]workshop[\\/]/i.exec(startDir);
    if (steam) { push(path.join(steam[1], 'common', 'SovietRepublic', 'media_soviet', 'scripts', rel)); }

    return out;
}

/**
 * 把 include("文件名") 的名字解析成磁盘上真实存在的一个路径。
 * 候选位置由 candidateApiPaths 逐级向上给出；全都打不开就当这个 include 没有落点。
 */
async function resolveIncludedFile(document, relative) {
    for (const candidate of candidateApiPaths(document, relative)) {
        try {
            await vscode.workspace.openTextDocument(vscode.Uri.file(candidate));
            return candidate;
        } catch { /* 这个位置没有，试下一个 */ }
    }
    return undefined;
}

/**
 * 光标是否落在 include("文件名") 的引号内容里；是则返回那个文件名。
 */
function includeAt(document, position) {
    const line = document.lineAt(position.line).text;
    const re = /include\s*\(\s*(["'])([^"']+)\1\s*\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        const name = m[2];
        const start = m.index + m[0].indexOf(name);
        const end = start + name.length;
        if (position.character >= start && position.character <= end) { return name; }
    }
    return undefined;
}

/**
 * 光标是否落在某个指令的「文件名参数」字符串里；是则返回文件名。
 */
function scriptFileArgAt(document, position) {
    const line = document.lineAt(position.line).text;
    const re = /"(?:[^"\\]|\\.)*"/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (position.character < start || position.character > end) { continue; }

        const call = /([A-Za-z_]\w*)\s*\(\s*$/.exec(line.slice(0, start));
        if (!call) { return undefined; }

        const callName = call[1];
        const it = data.api.instructions.get(callName);
        if (!it || !/^Script_/.test(callName)) { return undefined; }
        if (!it.params.length || !/string/.test(it.params[0])) { return undefined; }

        return m[0].slice(1, -1) || undefined;
    }
    return undefined;
}

async function loadApiDocument(document) {
    const uriKey = document.uri.toString();
    if (apiUriCache.has(uriKey)) {
        const cached = apiUriCache.get(uriKey);
        return cached ? vscode.workspace.openTextDocument(cached).then(d => d, () => undefined) : undefined;
    }

    const m = /include\s*\(\s*["']([^"']+)["']\s*\)/.exec(stripComments(document.getText()));
    if (!m) { apiUriCache.set(uriKey, null); return undefined; }

    const found = await resolveIncludedFile(document, m[1]);
    if (!found) { apiUriCache.set(uriKey, null); return undefined; }

    apiUriCache.set(uriKey, vscode.Uri.file(found));
    return vscode.workspace.openTextDocument(vscode.Uri.file(found)).then(d => d, () => undefined);
}

class PyroisDefinitionProvider {

    async provideDefinition(document, position) {
        // ⓪ 文件名参数 —— include("x.txt") / Script_Exists("x.txt", r) / Script_StartNew("x.txt") …
        const fileArg = includeAt(document, position) || scriptFileArgAt(document, position);
        if (fileArg) {
            const file = await resolveIncludedFile(document, fileArg);
            return file
                ? new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0))
                : undefined;
        }

        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!range) { return undefined; }
        const word = document.getText(range);
        const line = document.lineAt(position.line).text;
        const before = line.slice(0, range.start.character);

        const local = buildDefinitionIndex(document);

        // ① obj.成员 —— 先推断 obj 的类型，再查「类型.成员」
        const member = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before);
        if (member) {
            const typeName = data.inferType(document, member[1]);
            if (typeName) {
                const key = typeName + '.' + word;
                const localHit = local.members.get(key);
                if (localHit) { return localHit; }
                for (const idx of await this.includeIndexes(document)) {
                    if (idx.members.has(key)) { return idx.members.get(key); }
                }
                const api = await this.apiIndex(document);
                if (api && api.members.has(key)) { return api.members.get(key); }
            }
            return undefined;   // 成员找不到就返回，不回退到全局同名
        }

        // ② 本文件内的定义
        if (local.defs.has(word)) { return local.defs.get(word); }

        // ③ include 的脚本里的定义
        for (const idx of await this.includeIndexes(document)) {
            if (idx.defs.has(word)) { return idx.defs.get(word); }
        }

        // ④ 游戏 API 表
        const api = await this.apiIndex(document);
        if (api && api.defs.has(word)) { return api.defs.get(word); }

        return undefined;
    }

    async apiIndex(document) {
        const apiDoc = await loadApiDocument(document);
        return apiDoc ? buildDefinitionIndex(apiDoc) : undefined;
    }

    /** include 的脚本各自建一份索引（文本有缓存，解析很快） */
    async includeIndexes(document) {
        const out = [];
        for (const name of data.includedNames(document)) {
            const text = await data.readIncluded(document, name);
            if (!text) { continue; }
            const fake = data.textDocument(text);
            fake.uri = vscode.Uri.joinPath(document.uri, '..', name);
            fake.version = Date.now();
            out.push(buildDefinitionIndex(fake));
        }
        return out;
    }
}

module.exports = { PyroisDefinitionProvider };
