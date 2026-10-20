'use strict';

/**
 * 悬停文档：指令 / 结构体 / 常量 / 脚本函数 / 结构体字段与方法、语言关键字，
 * 显示签名与说明；没写的符号只显示签名。说明取自 docgen，界面固定文字走 i18n。
 */

const vscode = require('vscode');
const data = require('./data');
const docgen = require('./docgen');
const i18n = require('../../core/i18n').use('pyrois');

/** 本地符号的悬停：签名 + 定义处上方的注释（没有注释就退回一句说明） */
function localHover(decl, signature, fallbackKey) {
    const body = ['```pyrois', signature, '```'];
    body.push(data.leadingComment(decl.doc, decl.line) || i18n.t(fallbackKey));
    return new vscode.MarkdownString(body.join('\n\n'));
}

class PyroisHoverProvider {

    async provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
        if (!range) { return undefined; }
        const decls = await data.declarationsWithIncludes(document);
        const word = document.getText(range);
        const line = document.lineAt(position.line).text;
        const before = line.slice(0, range.start.character);

        // obj.field
        const member = /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(before);
        if (member) {
            const structName = data.inferType(document, member[1]);
            const st = structName && data.api.structs.get(structName);
            if (st) {
                const field = st.fields.find(f => f.name === word);
                if (field) {
                    const body = [`\`${field.type}${field.isArray ? '[]' : ''} ${field.name}\``, i18n.t('hover.fieldOf', st.name)];
                    data.pushDoc(body, docgen.describeMember(st.name, field));
                    return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
                }
                const method = st.methods.find(m => m.name === word);
                if (method) {
                    const body = [`\`\`\`pyrois`, `${st.name}.${method.name}(${method.params.map((t, i) => `arg${i + 1}: ${t}`).join(', ')})`, `\`\`\``];
                    data.pushDoc(body, docgen.describeMember(st.name, method));
                    return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
                }
            }

            const localMembers = structName && decls.members.get(structName);
            if (localMembers) {
                const field = localMembers.fields.find(f => f.name === word);
                if (field) {
                    const body = [`\`${field.type} ${field.name}\``];
                    const comment = data.leadingComment(field.doc || document, field.line);
                    if (comment) { body.push(comment); }
                    return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
                }
                const method = localMembers.methods.find(m => m.name === word);
                if (method) {
                    const body = ['```pyrois', `${structName}.${method.name}(${method.params.map((t, i) => `arg${i + 1}: ${t}`).join(', ')})`, '```'];
                    const comment = data.leadingComment(method.doc || document, method.line);
                    if (comment) { body.push(comment); }
                    return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
                }
            }
        }

        if (data.api.instructions.has(word)) {
            const it = data.api.instructions.get(word);
            const body = [`\`\`\`pyrois`, data.signatureOfInstruction(it), `\`\`\``, i18n.t('hover.instructionOpcode', it.opcode)];
            data.pushDoc(body, docgen.describeInstruction(it));
            return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
        }

        const localFn = decls.functions.get(word);
        if (localFn) {
            return new vscode.Hover(localHover(localFn, data.signatureOfFunction(localFn), 'data.localFunction'), range);
        }

        const localVar = decls.variables.get(word);
        if (localVar) {
            const body = [`\`${localVar.type} ${localVar.name}\``];
            const comment = data.leadingComment(localVar.doc || document, localVar.line);
            if (comment) { body.push(comment); }
            return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
        }

        const localInstr = decls.instructions.get(word);
        if (localInstr) {
            return new vscode.Hover(localHover(localInstr, data.signatureOfInstruction(localInstr), 'data.localInstruction'), range);
        }

        if (data.api.structs.has(word)) {
            return new vscode.Hover(new vscode.MarkdownString(data.structSummary(data.api.structs.get(word))), range);
        }

        const localStruct = decls.structs.get(word);
        if (localStruct) {
            const body = [`\`struct ${localStruct.name}\`（id ${localStruct.id || '?'}）`];
            const comment = data.leadingComment(localStruct.doc || document, localStruct.line);
            if (comment) { body.push(comment); }
            return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
        }

        if (data.api.constants.has(word)) {
            const c = data.api.constants.get(word);
            const body = [`\`${c.type} ${c.name}\``, i18n.t('hover.constant')];
            data.pushDoc(body, docgen.describeConstant(c));
            return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
        }

        if (data.api.functions.has(word)) {
            const fn = data.api.functions.get(word);
            const body = [`\`\`\`pyrois`, data.signatureOfFunction(fn), `\`\`\``, i18n.t('hover.scriptFunction')];
            data.pushDoc(body, docgen.describeFunction(fn));
            return new vscode.Hover(new vscode.MarkdownString(body.join('\n\n')), range);
        }

        if (data.keywords.types.includes(word)) {
            return new vscode.Hover(new vscode.MarkdownString(i18n.t('hover.builtinType', word)), range);
        }

        // 语言关键字（define* / if / for / include / main …）
        const kwDoc = data.keywords.docs[word];
        if (kwDoc) {
            return new vscode.Hover(data.keywordMarkdown(kwDoc), range);
        }

        return undefined;
    }
}

module.exports = { PyroisHoverProvider };
