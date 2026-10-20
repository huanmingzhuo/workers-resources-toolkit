'use strict';

/**
 * 去掉 Pyrois 注释，只留代码（字符串保留）。
 * 脚本开头常有整段注释，里面又常拿 include("x.txt") 举例，
 * 不去注释会把注释里的那行当成真代码。
 */
function stripComments(text) {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        if (text[i] === '/' && text[i + 1] === '/') {
            i += 2;
            while (i < n && text[i] !== '\n') { i++; }
            out += ' ';
        } else if (text[i] === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
            i = Math.min(n, i + 2);
            out += ' ';
        } else if (text[i] === '"' || text[i] === "'") {
            // 字符串整体照抄：include 的文件名就在里面
            const q = text[i];
            out += text[i];
            i++;
            while (i < n && text[i] !== q && text[i] !== '\n') { out += text[i]; i++; }
            if (i < n && text[i] === q) { out += text[i]; i++; }
        } else {
            out += text[i];
            i++;
        }
    }
    return out;
}

module.exports = { stripComments };
