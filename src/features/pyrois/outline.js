'use strict';

/**
 * 文档结构：大纲符号（函数 / 结构体字段与方法）与代码折叠（按 {} 配对）。
 */

const vscode = require('vscode');
const i18n = require('../../core/i18n').use('pyrois');

/**
 * 从 from 起，找到与第一个 `{` 配对的 `}` 之后的位置。
 * 找不到 `{` 返回 -1；括号不闭合就返回文本末尾。
 */
function findBodyEnd(text, from) {
    const open = text.indexOf('{', from);
    if (open === -1) { return -1; }
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') { depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0) { return i + 1; }
        }
    }
    return text.length;
}

/* ------------------------------------------------------------------ 大纲符号 */

class PyroisSymbolProvider {

    provideDocumentSymbols(document) {
        const text = document.getText();
        const symbols = [];

        const reStruct = /\bdefineStruct\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(\d+)\s*\)/g;
        let m;
        while ((m = reStruct.exec(text)) !== null) {
            const name = m[1];
            const start = document.positionAt(m.index);
            const end = document.positionAt(m.index + m[0].length);
            const children = [];
            const reField = new RegExp(`\\bdefineStruct(?:Variable|Array)\\s*\\(\\s*${name}\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)`, 'g');
            let f;
            while ((f = reField.exec(text)) !== null) {
                const fr = new vscode.Range(document.positionAt(f.index), document.positionAt(f.index + f[0].length));
                children.push(new vscode.DocumentSymbol(f[2], f[1], vscode.SymbolKind.Field, fr, fr));
            }
            const reMethod = new RegExp(`\\bdefineStructInstruction\\s*\\(\\s*${name}\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*,\\s*\\d+`, 'g');
            let mm;
            while ((mm = reMethod.exec(text)) !== null) {
                const mr = new vscode.Range(document.positionAt(mm.index), document.positionAt(mm.index + mm[0].length));
                children.push(new vscode.DocumentSymbol(mm[1], i18n.t('outline.method'), vscode.SymbolKind.Method, mr, mr));
            }
            symbols.push(new vscode.DocumentSymbol(name, i18n.t('outline.struct', m[2]), vscode.SymbolKind.Struct,
                new vscode.Range(start, end), new vscode.Range(start, end), children));
        }

        const reFn = /\bdefineFunction\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,([^)]*))?\)/g;
        while ((m = reFn.exec(text)) !== null) {
            const name = m[1];
            const returns = m[2];
            const params = (m[3] || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => s.replace(':', ' '))
                .join(', ');
            const start = document.positionAt(m.index);
            const bodyEnd = findBodyEnd(text, reFn.lastIndex);
            const end = document.positionAt(bodyEnd === -1 ? m.index + m[0].length : bodyEnd);
            symbols.push(new vscode.DocumentSymbol(
                name,
                `(${params}) → ${returns}`,
                vscode.SymbolKind.Function,
                new vscode.Range(start, end),
                new vscode.Range(start, document.positionAt(m.index + m[0].length))
            ));
        }

        return symbols;
    }
}

/* ------------------------------------------------------------------ 折叠 */

/** 折叠标记：`//region 名字` / `//endregion`（`//#region` 也认） */
const REGION_START = /^\s*\/\/\s*#?region\b/;
const REGION_END = /^\s*\/\/\s*#?endregion\b/;

class PyroisFoldingProvider {

    provideFoldingRanges(document) {
        const ranges = [];
        const stack = [];
        const regions = [];
        for (let lineNo = 0; lineNo < document.lineCount; lineNo++) {
            const line = document.lineAt(lineNo).text;

            // 自己的 provider 会盖掉内置的 folding.markers，所以 //region 要自己认
            if (REGION_START.test(line)) {
                regions.push(lineNo);
            } else if (REGION_END.test(line)) {
                const start = regions.pop();
                if (start !== undefined && lineNo > start) {
                    ranges.push(new vscode.FoldingRange(start, lineNo, vscode.FoldingRangeKind.Region));
                }
            }

            const cleaned = line.replace(/\\./g, '').replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
            for (const ch of cleaned) {
                if (ch === '{') { stack.push(lineNo); }
                else if (ch === '}' && stack.length) {
                    const start = stack.pop();
                    if (lineNo > start) { ranges.push(new vscode.FoldingRange(start, lineNo, vscode.FoldingRangeKind.Region)); }
                }
            }
        }
        return ranges;
    }
}

module.exports = { PyroisSymbolProvider, PyroisFoldingProvider };
