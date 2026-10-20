'use strict';

/**
 * Pyrois 代码片段（骨架）。原来在 snippets.json 里，但静态文件没法按语言翻译，
 * 所以搬进代码：说明走 i18n（键在 data/docs/<语言>/ui.json），body 与语言无关。
 */

const vscode = require('vscode');
const i18n = require('../../core/i18n').use('pyrois');

/** 说明的键是 `snippet.<name>`；prefix 是触发词，body 是展开后的内容（一个元素一行） */
const SNIPPETS = [
    {
        name: 'include',
        prefix: ['inc', 'include'],
        body: ['include("SOVIETInstructions.txt");']
    },
    {
        name: 'defineVariable',
        prefix: ['defvar', 'variable'],
        body: ['defineVariable(${1|int,float,char,string,vec2,vec3,vec4,Building,Vehicle,Person,Resources,Window|}, ${2:name});']
    },
    {
        name: 'defineArray',
        prefix: ['defarr', 'array'],
        body: ['defineArray(${1:int}[${2:1}], ${3:name});']
    },
    {
        name: 'defineFunction',
        prefix: ['deffn', 'function', 'main'],
        body: ['defineFunction(${1:name}, ${2:void})', '{', '\t$0', '}']
    },
    {
        name: 'defineFunctionParams',
        prefix: ['deffnp', 'functionp'],
        body: ['defineFunction(${1:name}, ${2:float}, ${3:float}:${4:param})']
    },
    {
        name: 'defineStruct',
        prefix: ['defstruct', 'struct'],
        body: ['defineStruct(${1:Name}, ${2:100})', '{', '\tdefineStructVariable(${1:Name}, ${3:int}, ${4:field});', '\t$0', '}']
    },
    {
        name: 'defineStructVariable',
        prefix: ['defsvar', 'structvar'],
        body: ['defineStructVariable(${1:Name}, ${2:int}, ${3:field});']
    },
    {
        name: 'defineStructArray',
        prefix: ['defsarr', 'structarr'],
        body: ['defineStructArray(${1:Name}, ${2:int}, ${3:field});']
    },
    {
        name: 'defineStructInstruction',
        prefix: ['defsinst', 'structinst', 'method'],
        body: ['defineStructInstruction(${1:Building}, ${2:GetDataByIndex}, ${3:10000}, ${4:int});']
    },
    {
        name: 'defineInstruction',
        prefix: ['definst', 'instruction'],
        body: ['defineInstruction(${1:name}, ${2:900}, ${3:float}, ${4:float});']
    },
    {
        name: 'if',
        prefix: ['if'],
        body: ['if (${1:condition})', '{', '\t$0', '}']
    },
    {
        name: 'ifelse',
        prefix: ['ifelse', 'ife'],
        body: ['if (${1:condition})', '{', '\t${2}', '}', 'else', '{', '\t$0', '}']
    },
    {
        name: 'elseif',
        prefix: ['elseif', 'elif'],
        body: ['elseif (${1:condition})']
    },
    {
        name: 'for',
        prefix: ['for'],
        body: ['for (${1:i}=0, ${1:i}<${2:n}, ${1:i}=${1:i}+1)', '{', '\t$0', '}']
    },
    {
        name: 'while',
        prefix: ['while'],
        body: ['while (${1:condition})', '{', '\t$0', '}']
    },
    {
        name: 'region',
        prefix: ['region'],
        body: ['//region ${1:section}', '$0', '//endregion']
    },
    {
        name: 'endregion',
        prefix: ['endregion', 'endr'],
        body: ['//endregion']
    }
];

/** 生成补全项。label 用第一个前缀，其余前缀靠 filterText 也能命中 */
function snippetItems() {
    return SNIPPETS.map((s) => {
        const item = new vscode.CompletionItem(s.prefix[0], vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(s.body.join('\n'));
        item.filterText = s.prefix.join(' ');
        item.detail = i18n.t('snippet.' + s.name);
        return item;
    });
}

module.exports = { snippetItems };
