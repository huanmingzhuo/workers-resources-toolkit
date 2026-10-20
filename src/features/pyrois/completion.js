'use strict';

/**
 * 补全：语言关键字 / 内置类型 / 结构体 / 底层指令 / 游戏常量 / 脚本函数，
 * 以及 `obj.` 触发的成员补全。
 * 数据取自 data.js，说明取自 docgen.js；界面固定文字走 i18n（跟说明同语言）。
 */

const vscode = require('vscode');
const data = require('./data');
const docgen = require('./docgen');
const snippets = require('./snippets');
const i18n = require('../../core/i18n').use('pyrois');

/** Doxygen 标签（顺序即补全列表顺序） */
const DOXYGEN_TAGS = ['brief', 'param', 'return', 'retval', 'note', 'warning', 'see', 'example', 'deprecated', 'todo', 'author', 'version'];

/** 光标是否落在注释里：行注释看本行，块注释看前面最近的起止符 */
function isInComment(document, position) {
    const line = document.lineAt(position.line).text.slice(0, position.character);
    if (line.indexOf('//') >= 0) { return true; }
    const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    return before.lastIndexOf('/*') > before.lastIndexOf('*/');
}

/** 注释里的标签补全（替换范围从已输入的 `@` 开始，否则会补出两个 @） */
function doxygenItems(position, typed) {
    const start = new vscode.Position(position.line, position.character - typed.length);
    const range = new vscode.Range(start, position);
    return DOXYGEN_TAGS.map((tag) => {
        const item = new vscode.CompletionItem('@' + tag, vscode.CompletionItemKind.Keyword);
        item.detail = i18n.t('doxygen.tag.' + tag);
        item.insertText = '@' + tag + ' ';
        item.range = range;
        return item;
    });
}

class PyroisCompletionProvider {

    async provideCompletionItems(document, position) {
        const line = document.lineAt(position.line).text.slice(0, position.character);

        // ---- 注释里的 Doxygen 标签（输 @ 就列，不再混普通补全）
        const at = /@[A-Za-z_]*$/.exec(line);
        if (at && isInComment(document, position)) {
            return doxygenItems(position, at[0]);
        }

        const decls = await data.declarationsWithIncludes(document);

        // ---- 成员补全：obj.<cursor>
        const member = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*[A-Za-z_0-9]*$/.exec(line);
        if (member) {
            let typeName = data.inferType(document, member[1]);
            if (!typeName) {
                const v = decls.variables.get(member[1]);
                if (v) { typeName = v.type.replace(/\[\]$/, ''); }
            }
            const apiStruct = typeName && data.api.structs.get(typeName);
            const localMembers = typeName && decls.members.get(typeName);
            if (!apiStruct && !localMembers) { return []; }

            // 官方结构体成员 + 本文件里给它加的字段 / 方法，合并成一个列表
            const items = apiStruct ? this.structMembers(apiStruct) : [];
            if (localMembers) {
                for (const f of localMembers.fields) {
                    const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Field);
                    item.detail = f.type;
                    item.documentation = new vscode.MarkdownString(i18n.t('completion.localField', f.type));
                    items.push(item);
                }
                for (const mth of localMembers.methods) {
                    const item = new vscode.CompletionItem(mth.name, vscode.CompletionItemKind.Method);
                    item.detail = mth.params.length ? `${mth.name}(${mth.params.join(', ')})` : mth.name;
                    items.push(item);
                }
            }
            return items;
        }

        const items = [];

        // ---- 代码片段（骨架）
        items.push(...snippets.snippetItems());

        // ---- 声明关键字
        for (const kw of data.keywords.declarations) {
            const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            item.detail = i18n.t('completion.declaration');
            const doc = data.keywords.docs[kw];
            if (doc) { item.documentation = data.keywordMarkdown(doc); }
            items.push(item);
        }
        for (const kw of data.keywords.control.concat(data.keywords.misc)) {
            const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            const doc = data.keywords.docs[kw];
            if (doc) { item.detail = doc.sig; item.documentation = data.keywordMarkdown(doc); }
            items.push(item);
        }

        // ---- 内置类型。vec3 / mat4x4 这类本身就是结构体，交给下面的结构体循环列，
        for (const t of data.keywords.types) {
            if (data.api.structs.has(t)) { continue; }
            const item = new vscode.CompletionItem(t, vscode.CompletionItemKind.TypeParameter);
            item.detail = i18n.t('completion.builtinType');
            items.push(item);
        }
        for (const st of data.api.structs.values()) {
            const item = new vscode.CompletionItem(st.name, vscode.CompletionItemKind.Struct);
            item.detail = i18n.t('completion.struct', st.id == null ? '?' : st.id);
            item.documentation = new vscode.MarkdownString(data.structSummary(st));
            items.push(item);
        }

        // ---- 底层指令。`return` / `returnVoid` 这类名字同时也是语言关键字
        for (const it of data.api.instructions.values()) {
            if (data.keywords.docs[it.name]) { continue; }
            const item = new vscode.CompletionItem(it.name, vscode.CompletionItemKind.Function);
            item.detail = i18n.t('completion.instruction', it.opcode == null ? '?' : it.opcode);
            const body = [`\`\`\`pyrois`, data.signatureOfInstruction(it), `\`\`\``];
            data.pushDoc(body, docgen.describeInstruction(it));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }

        // ---- 本文件（含 include 的脚本）里 Mod 自己声明的符号：函数 / 变量 / 指令 / 结构体
        for (const st of decls.structs.values()) {
            if (data.api.structs.has(st.name)) { continue; }
            const item = new vscode.CompletionItem(st.name, vscode.CompletionItemKind.Struct);
            item.detail = i18n.t('completion.struct', st.id || '?');
            const comment = data.leadingComment(document, st.line);
            if (comment) { item.documentation = new vscode.MarkdownString(comment); }
            items.push(item);
        }

        for (const fn of decls.functions.values()) {
            if (data.api.functions.has(fn.name) || data.keywords.docs[fn.name]) { continue; }
            const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
            item.detail = i18n.t('data.localFunction');
            const body = ['```pyrois', data.signatureOfFunction(fn), '```'];
            body.push(data.leadingComment(document, fn.line) || i18n.t('data.localFunction'));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }
        for (const v of decls.variables.values()) {
            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Variable);
            item.detail = v.type;
            const comment = data.leadingComment(document, v.line);
            if (comment) { item.documentation = new vscode.MarkdownString(comment); }
            items.push(item);
        }
        for (const it of decls.instructions.values()) {
            if (data.api.instructions.has(it.name)) { continue; }
            const item = new vscode.CompletionItem(it.name, vscode.CompletionItemKind.Function);
            item.detail = i18n.t('data.localInstruction');
            const body = ['```pyrois', data.signatureOfInstruction(it), '```'];
            body.push(data.leadingComment(document, it.line) || i18n.t('data.localInstruction'));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }

        // ---- 游戏常量
        for (const c of data.api.constants.values()) {
            const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Constant);
            item.detail = c.type;
            const body = [`\`${c.type} ${c.name}\``];
            data.pushDoc(body, docgen.describeConstant(c));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }

        // ---- 游戏自带脚本函数（sin / cos / DistancePoints ...）
        for (const fn of data.api.functions.values()) {
            const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
            item.detail = i18n.t('completion.returns', fn.returns);
            const body = [`\`\`\`pyrois`, data.signatureOfFunction(fn), `\`\`\``];
            data.pushDoc(body, docgen.describeFunction(fn));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }

        return items;
    }

    structMembers(st) {
        const items = [];
        for (const f of st.fields) {
            const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Field);
            item.detail = `${f.type}${f.isArray ? '[]' : ''}`;
            const body = [`\`${f.type}${f.isArray ? '[]' : ''} ${f.name}\``];
            data.pushDoc(body, docgen.describeMember(st.name, f));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }
        for (const mth of st.methods) {
            const item = new vscode.CompletionItem(mth.name, vscode.CompletionItemKind.Method);
            item.detail = `${mth.name}(${mth.params.join(', ')})`;
            const body = [`\`\`\`pyrois`, `${st.name}.${mth.name}(${mth.params.map((t, i) => `arg${i + 1}: ${t}`).join(', ')})`, `\`\`\``];
            data.pushDoc(body, docgen.describeMember(st.name, mth));
            item.documentation = new vscode.MarkdownString(body.join('\n\n'));
            items.push(item);
        }
        return items;
    }
}

module.exports = { PyroisCompletionProvider };
