'use strict';

/**
 * BTF 对照视图的页面（HTML + CSS + 页面脚本），只有 `shellHtml()` 一个出口。
 *
 * 与 editor.js 的分工：这个文件只知道"怎么画"，editor.js 负责"数据从哪来"。
 * 两者之间的协议（消息都用 `postMessage` 传，页面里不内联任何文件内容）：
 *
 *   插件 → 页面
 *     { type:'meta', columns:[{name,path,count,missing,empty,duplicated,problems}],
 *       primary, error, total, sent, truncated, problems:[{level,text}] }
 *     { type:'data', from, rows:[[id, 列0文本, 列1文本, …], …] }   一列一个文件，null = 缺失
 *     { type:'done', loaded }
 *     { type:'dirty', files:[bool, …] }      哪几列有未保存的改动（自己改的 / 别人改的都算）
 *     { type:'stats', columns:[…] }          列头统计重算（编辑之后"空 N"会变）
 *     { type:'select', row, col }            选中某一行（新增条目之后用它把光标送回那一格）
 *     { type:'notice', text }                一句话，显示在状态栏
 *     { type:'error', message }
 *
 *   页面 → 插件
 *     { type:'ready' } | { type:'reload' } | { type:'add' } | { type:'remove', index }
 *     { type:'edit', row, col, text }        改了一格（row 是对照表的行号，不是条目下标）
 *     { type:'addEntry', row, col }          在那一列的文件里新增这一行（id 取自该行，空译文）
 *     { type:'save' } | { type:'revert' }
 *     { type:'openText' } | { type:'export', kind:'csv'|'json' } | { type:'copy', text }
 */

/** 本模块的界面文案（整份字典会注入页面） */
const i18n = require('../../core/i18n').use('btf');

/** 行高（像素）。CSS 里的 .row 要跟着改 */
const ROW_H = 22;

/** 一个 id 列的宽度（像素） */
const ID_WIDTH = 92;

/** 每个语言列的最小宽度（像素） */
const MIN_COL_WIDTH = 200;

/** 视口外多画几行，滚动时不会露白 */
const OVERSCAN = 8;

const STYLE = `
:root { color-scheme: light dark; --row-h: ${ROW_H}px; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}
header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
h1 { font-size: 1em; margin: 0; font-weight: 600; }
.path { opacity: .75; font-family: var(--vscode-editor-font-family, monospace); font-size: .9em; word-break: break-all; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
button {
  font-family: inherit; font-size: .92em; padding: 3px 9px; border-radius: 3px; cursor: pointer;
  border: 1px solid transparent;
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.22));
  color: var(--vscode-button-secondaryForeground, inherit);
}
button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
button:hover { filter: brightness(1.15); }
button:disabled { opacity: .5; cursor: default; filter: none; }
input[type=search] {
  font-family: inherit; font-size: .95em; padding: 3px 8px; border-radius: 3px; min-width: 240px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
}
input[type=search]:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
label.chk { display: inline-flex; align-items: center; gap: 4px; font-size: .92em; opacity: .9; white-space: nowrap; }
.count { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; opacity: .8; }
.count.bad { color: var(--vscode-editorError-foreground, #f14c4c); opacity: 1; }
.headwrap { flex: none; overflow: hidden; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.headrow { display: grid; grid-template-columns: var(--cols); width: max-content; }
.headrow > div { padding: 4px 8px; font-size: .92em; overflow: hidden; }
.headrow .hname { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.headrow .hname span.t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.headrow .stat { font-weight: 400; opacity: .75; font-family: var(--vscode-editor-font-family, monospace); font-size: .88em; white-space: nowrap; }
.headrow .stat.bad { color: var(--vscode-editorWarning-foreground, #cca700); opacity: 1; }
.headrow button.rm { padding: 0 5px; font-size: 1em; line-height: 1.2; background: transparent; }
.wrap { flex: 1 1 auto; overflow: auto; position: relative; }
.spacer { position: relative; width: 100%; }
.rows { position: absolute; top: 0; left: 0; }
.row { display: grid; grid-template-columns: var(--cols); width: max-content; height: var(--row-h); }
.row > div {
  padding: 0 8px; line-height: var(--row-h); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  border-bottom: 1px solid rgba(128,128,128,.12);
  font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px);
}
.row { cursor: default; }
.row:hover > div { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
.row.sel > div { background: var(--vscode-list-activeSelectionBackground, rgba(0,127,212,.35)); }
.cell.id { text-align: right; opacity: .8; }
.cell.miss { opacity: .45; font-style: italic; }
.cell.empty { opacity: .55; font-style: italic; }
mark { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.45)); color: inherit; }
/* 详情面板与表格之间的拖拽条：高度由用户拖，拖完一直记住（重建面板不会丢） */
.dresize { flex: none; display: none; height: 6px; cursor: ns-resize; position: relative; }
.dresize.on { display: block; }
.dresize::after {
  content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 1px;
  background: var(--vscode-panel-border, rgba(128,128,128,.35));
}
.dresize:hover::after, .dresize.drag::after { background: var(--vscode-focusBorder, #007fd4); height: 2px; }
.details {
  flex: none; display: none; max-height: 50vh; overflow: auto; padding: 6px 12px 10px;
  background: var(--vscode-editorWidget-background, transparent);
}
.details.on { display: block; }
.dhead { display: flex; align-items: center; gap: 8px; margin: 2px 0 6px; }
.dhead b { font-family: var(--vscode-editor-font-family, monospace); }
.dblock { margin: 0 0 8px; }
.dname { display: flex; align-items: center; gap: 6px; font-size: .9em; opacity: .8; margin-bottom: 2px; }
.dtext.none {
  padding: 4px 8px; border-radius: 3px; opacity: .6; font-style: italic;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
}
textarea {
  display: block; width: 100%; box-sizing: border-box; min-height: 0;
  /* 高度由 autoGrow() 按内容给，不让人手拖 */
  resize: none; overflow-y: auto; overflow-x: hidden;
  padding: 4px 8px; border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: .95em; line-height: 1.45;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
}
textarea:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
.dot { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); opacity: 1; }
.status {
  flex: none; padding: 4px 12px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  font-size: .9em; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.status.bad { color: var(--vscode-editorError-foreground, #f14c4c); opacity: 1; }
.hint { margin-top: 6px; font-size: .9em; opacity: .8; }
`;

/** 页面骨架。数据一律用 postMessage 送，页面里不内联任何文件内容 */
function shellHtml(webview, nonce) {
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`
    ].join('; ');

    // webview 里 require 不到宿主的东西，所以整份文案表注进页面；
    // `<` 转义成 \u003c，避免文案里的 `</script>` 提前截断内联脚本。
    const uiJson = JSON.stringify(i18n.dump()).replace(/</g, '\\u003c');

    const script = `
(function () {
    var vscode = acquireVsCodeApi();
    var ROW_H = ${ROW_H}, ID_WIDTH = ${ID_WIDTH}, MIN_COL = ${MIN_COL_WIDTH}, OVERSCAN = ${OVERSCAN};
    var UI = ${uiJson};

    /** 按 {0} {1} … 取文案，查不到显示键名 */
    function T(key) {
        var text = UI[key];
        if (text === undefined) { return String(key); }
        for (var i = 1; i < arguments.length; i++) {
            text = text.split('{' + (i - 1) + '}').join(String(arguments[i]));
        }
        return text;
    }

    var $ = function (id) { return document.getElementById(id); };
    var wrap = $('wrap'), spacer = $('spacer'), rowsEl = $('rows'), headwrap = $('headwrap'),
        headrow = $('headrow'), details = $('details'), statusEl = $('status'), countEl = $('count'),
        pathEl = $('path'), hintEl = $('hint'), dresize = $('dresize');

    /* ---------------------------------------------------------- 编辑框高度 */

    /** 让文本框按内容长高（上限 40% 窗口高，再高就在框里滚） */
    function autoGrow(ta) {
        if (!ta || !ta.parentNode) { return; }
        var max = Math.max(140, Math.round(window.innerHeight * 0.4));
        ta.style.height = 'auto';
        var need = ta.scrollHeight + 2;
        ta.style.height = Math.min(need, max) + 'px';
        ta.style.overflowY = need > max ? 'auto' : 'hidden';
    }

    /** 面板高度变了 / 窗口变了：里面所有文本框重新量一遍 */
    function growAll() {
        var areas = details.getElementsByTagName('textarea');
        for (var i = 0; i < areas.length; i++) { autoGrow(areas[i]); }
    }

    var S = {
        columns: [], rows: [], view: [], total: 0, sent: 0, truncated: false, primary: '',
        query: '', useRegex: false, regex: null, regexError: '', onlyMissing: false,
        selected: -1, loaded: 0, done: false, dirty: []
    };

    /* ---------------------------------------------------------- 搜索 */

    function escapeRegExp(s) { return String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }

    /** 把搜索框 + 「正则」勾选编译成 S.regex（编译失败就记在 S.regexError 里） */
    function compileQuery() {
        S.regexError = '';
        S.regex = null;
        if (!S.useRegex || !S.query) { return; }
        try {
            S.regex = new RegExp(S.query, 'i');
        } catch (err) {
            S.regexError = String(err.message || err);
        }
    }

    function hasMissing(row) {
        for (var c = 0; c < S.columns.length; c++) {
            var v = row[c + 1];
            if (v === null || v === undefined || v === '') { return true; }
        }
        return false;
    }

    /**
     * 重算筛选结果（S.view 存的是 S.rows 的下标）。
     * 匹配 id 与所有列的译文；勾「只看缺失」时还要有任一列为空 / 缺失。
     * 正则写错时不筛文本，只在计数处提示。
     */
    function applyFilter(resetScroll) {
        var q = S.query;
        var re = S.useRegex ? S.regex : null;
        var brokenRegex = !!q && S.useRegex && !re;
        var lower = (q && !S.useRegex) ? q.toLowerCase() : '';
        var view = [];

        for (var i = 0; i < S.rows.length; i++) {
            var row = S.rows[i];
            if (S.onlyMissing && !hasMissing(row)) { continue; }

            if (q && !brokenRegex) {
                var hit = false;
                if (re) {
                    if (re.test(String(row[0]))) { hit = true; }
                    for (var c = 0; !hit && c < S.columns.length; c++) {
                        var v = row[c + 1];
                        if (v && re.test(v)) { hit = true; }
                    }
                } else if (lower) {
                    if (String(row[0]).toLowerCase().indexOf(lower) >= 0) { hit = true; }
                    for (var d = 0; !hit && d < S.columns.length; d++) {
                        var t = row[d + 1];
                        if (t && t.toLowerCase().indexOf(lower) >= 0) { hit = true; }
                    }
                }
                if (!hit) { continue; }
            }
            view.push(i);
        }

        S.view = view;
        if (resetScroll) { wrap.scrollTop = 0; }
        updateCount();
        render();
    }

    function updateCount() {
        var filtered = S.query || S.onlyMissing;
        var text = filtered
            ? T('page.count.filtered', S.view.length, S.total)
            : T('page.count.total', S.total);
        if (S.columns.length > 1) { text += T('page.count.columns', S.columns.length); }
        if (!S.done) { text += T('page.count.loading', S.loaded); }
        countEl.textContent = text;
        countEl.className = 'count' + (S.regexError ? ' bad' : '');
        if (S.regexError) { countEl.textContent = T('page.count.regexError', S.regexError); }
    }

    /** 「保存」「放弃修改」只在有未保存改动时可点 */
    function updateButtons() {
        var any = false;
        for (var i = 0; i < S.dirty.length; i++) { if (S.dirty[i]) { any = true; break; } }
        var save = $('btn-save');
        save.disabled = !any;
        save.title = any ? T('page.saveTitle.on') : T('page.saveTitle.off');
        $('btn-revert').disabled = !any;
    }

    /* ---------------------------------------------------------- 画表 */

    function computeGrid() {
        var width = Math.max(wrap.clientWidth || 0, 600);
        var cols = Math.max(S.columns.length, 1);
        var avail = Math.max(width - ID_WIDTH, cols * MIN_COL);
        var w = Math.max(MIN_COL, Math.floor(avail / cols));
        document.documentElement.style.setProperty('--cols', ID_WIDTH + 'px repeat(' + cols + ', ' + w + 'px)');
    }

    function paint(el, text) {
        el.textContent = '';
        if (text == null) { return; }
        if (!S.query) { el.textContent = text; return; }
        var pattern;
        try {
            pattern = S.regex
                ? new RegExp(S.regex.source, 'gi')
                : new RegExp(escapeRegExp(S.query), 'gi');
        } catch (err) { el.textContent = text; return; }
        var last = 0, guard = 0, m;
        while ((m = pattern.exec(text)) !== null) {
            if (guard++ > 500) { break; }
            var at = m.index, len = m[0].length;
            if (at > last) { el.appendChild(document.createTextNode(text.slice(last, at))); }
            if (len > 0) {
                var mark = document.createElement('mark');
                mark.textContent = m[0];
                el.appendChild(mark);
                last = at + len;
            } else {
                last = at;
                pattern.lastIndex = at + 1;
            }
        }
        if (last < text.length) { el.appendChild(document.createTextNode(text.slice(last))); }
    }

    function buildRow(i) {
        var row = S.rows[i];
        var div = document.createElement('div');
        div.className = 'row' + (i === S.selected ? ' sel' : '');
        var id = document.createElement('div');
        id.className = 'cell id';
        paint(id, String(row[0]));
        div.appendChild(id);
        for (var c = 0; c < S.columns.length; c++) {
            var v = row[c + 1];
            var cell = document.createElement('div');
            if (v === null || v === undefined) {
                cell.className = 'cell miss';
                cell.textContent = '—';
                cell.title = T('page.cell.missingTitle', row[0]);
            } else if (v === '') {
                cell.className = 'cell empty';
                cell.textContent = T('page.cell.empty');
                cell.title = T('page.cell.emptyTitle', row[0]);
            } else {
                cell.className = 'cell';
                paint(cell, v);
                cell.title = v;
            }
            div.appendChild(cell);
            if (v !== null && v !== undefined) {
                // 双击某一格 → 选中该行并直接把光标放进对应文本框
                (function (rowIndex, colIndex) {
                    cell.addEventListener('dblclick', function () { select(rowIndex, colIndex); });
                }(i, c));
            } else {
                // 双击"缺"的那一格 → 直接给这个文件新增这一条（加完自动选中，可以马上打字）
                (function (rowIndex, colIndex) {
                    cell.addEventListener('dblclick', function () { askAddEntry(rowIndex, colIndex); });
                }(i, c));
            }
        }
        div.addEventListener('click', function () { select(i); });
        return div;
    }

    var pending = false;
    function render() {
        pending = false;
        spacer.style.height = (S.view.length * ROW_H) + 'px';
        var top = wrap.scrollTop;
        var need = Math.ceil((wrap.clientHeight || 400) / ROW_H) + OVERSCAN * 2;
        var first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
        var count = Math.min(S.view.length - first, need);
        if (count <= 0) { rowsEl.textContent = ''; return; }
        rowsEl.style.transform = 'translateY(' + (first * ROW_H) + 'px)';
        var frag = document.createDocumentFragment();
        for (var k = 0; k < count; k++) { frag.appendChild(buildRow(S.view[first + k])); }
        rowsEl.textContent = '';
        rowsEl.appendChild(frag);
    }

    function schedule() {
        if (pending) { return; }
        pending = true;
        window.requestAnimationFrame(render);
    }

    /* ---------------------------------------------------------- 表头 */

    function renderHead() {
        headrow.textContent = '';
        var first = document.createElement('div');
        var label = document.createElement('div');
        label.className = 'hname';
        var t = document.createElement('span');
        t.className = 't';
        t.textContent = 'id';
        label.appendChild(t);
        first.appendChild(label);
        headrow.appendChild(first);

        S.columns.forEach(function (col, index) {
            var cell = document.createElement('div');
            var name = document.createElement('div');
            name.className = 'hname';
            var span = document.createElement('span');
            span.className = 't';
            span.textContent = col.name;
            span.title = col.path || col.name;
            name.appendChild(span);
            if (S.dirty[index]) {
                var dot = document.createElement('span');
                dot.className = 'dot';
                dot.textContent = '●';
                dot.title = T('page.col.dirty');
                name.appendChild(dot);
            }
            if (index > 0) {
                var rm = document.createElement('button');
                rm.className = 'rm';
                rm.textContent = '×';
                rm.title = T('page.col.remove');
                rm.addEventListener('click', function () { vscode.postMessage({ type: 'remove', index: index }); });
                name.appendChild(rm);
            }
            cell.appendChild(name);

            var stat = document.createElement('div');
            stat.className = 'stat' + (col.problems ? ' bad' : '');
            var parts = [T('page.stat.entries', col.count)];
            if (col.missing) { parts.push(T('page.stat.missing', col.missing)); }
            if (col.empty) { parts.push(T('page.stat.empty', col.empty)); }
            if (col.duplicated) { parts.push(T('page.stat.duplicated', col.duplicated)); }
            if (col.problems) { parts.push(T('page.stat.problems', col.problems)); }
            stat.textContent = parts.join(' · ');
            cell.appendChild(stat);
            headrow.appendChild(cell);
        });
    }

    /* ---------------------------------------------------------- 详情 */

    /* ---------------------------------------------------------- 编辑 */

    // 打字期间不发消息，停手 400ms 再发；换格 / 失焦时立刻把挂着的改动发出去
    var editTimer = null;
    var editPending = null;

    function onEditInput(ta) {
        var row = Number(ta.dataset.row);
        var col = Number(ta.dataset.col);
        if (S.rows[row]) { S.rows[row][col + 1] = ta.value; }   // 本地先记下：筛选、导出、表格都靠它
        autoGrow(ta);
        if (editPending && (editPending.row !== row || editPending.col !== col)) { flushEdit(); }
        editPending = { row: row, col: col, text: ta.value };
        if (editTimer) { window.clearTimeout(editTimer); }
        editTimer = window.setTimeout(flushEdit, 400);
        schedule();   // 把上面表格里那一行也刷新一下
    }

    function flushEdit() {
        if (editTimer) { window.clearTimeout(editTimer); editTimer = null; }
        if (!editPending) { return; }
        var pending = editPending;
        editPending = null;
        vscode.postMessage({ type: 'edit', row: pending.row, col: pending.col, text: pending.text });
    }

    /** 给某一列新增这一条（宿主插入后回 select，把光标送回新格子） */
    function askAddEntry(rowIndex, colIndex) {
        flushEdit();
        vscode.postMessage({ type: 'addEntry', row: rowIndex, col: colIndex });
    }

    function select(i, focusCol) {
        flushEdit();          // 换行之前先把上一格挂着的改动发出去
        S.selected = i;
        var row = S.rows[i];
        details.textContent = '';

        var head = document.createElement('div');
        head.className = 'dhead';
        var strong = document.createElement('b');
        strong.textContent = 'id ' + row[0];
        head.appendChild(strong);
        var note = document.createElement('span');
        note.className = 'stat';
        note.textContent = T('page.detail.note');
        head.appendChild(note);
        details.appendChild(head);

        S.columns.forEach(function (col, c) {
            var v = row[c + 1];
            var block = document.createElement('div');
            block.className = 'dblock';

            var line = document.createElement('div');
            line.className = 'dname';
            var nm = document.createElement('span');
            nm.textContent = col.name;
            line.appendChild(nm);
            if (S.dirty[c]) {
                var dot = document.createElement('span');
                dot.className = 'dot';
                dot.textContent = T('page.detail.dirty');
                line.appendChild(dot);
            }
            if (v !== null && v !== undefined && v !== '') {
                var copy = document.createElement('button');
                copy.textContent = T('page.detail.copy');
                copy.title = T('page.detail.copyTitle');
                copy.addEventListener('click', function () { vscode.postMessage({ type: 'copy', text: v }); });
                line.appendChild(copy);
            }
            block.appendChild(line);

            if (v === null || v === undefined) {
                var none = document.createElement('div');
                none.className = 'dtext none';
                none.appendChild(document.createTextNode(T('page.detail.missing', row[0]) + ' '));
                var addBtn = document.createElement('button');
                addBtn.textContent = T('page.addEntry');
                addBtn.title = T('page.addEntryTitle', row[0]);
                addBtn.addEventListener('click', function () { askAddEntry(i, c); });
                none.appendChild(addBtn);
                block.appendChild(none);
            } else {
                var area = document.createElement('textarea');
                area.rows = 3;
                area.spellcheck = false;
                area.value = v;
                area.dataset.row = String(i);
                area.dataset.col = String(c);
                area.title = T('page.detail.areaTitle');
                area.addEventListener('input', function () { onEditInput(area); });
                area.addEventListener('blur', flushEdit);
                block.appendChild(area);
                if (focusCol === c) {
                    // 双击某一格 → 直接跳到对应的文本框
                    window.setTimeout(function () { area.focus(); area.select(); }, 0);
                }
            }
            details.appendChild(block);
        });

        details.classList.add('on');
        dresize.classList.add('on');
        growAll();   // 文本框挂进 DOM 之后才量得准（换行宽度依赖实际布局）
        render();
    }

    /* ---------------------------------------------------------- 消息 */

    window.addEventListener('message', function (event) {
        var msg = event.data || {};
        if (msg.type === 'meta') {
            S.columns = msg.columns || [];
            S.primary = msg.primary || '';
            S.total = msg.total || 0;
            S.sent = msg.sent == null ? S.total : msg.sent;
            S.truncated = !!msg.truncated;
            S.rows = [];
            S.view = [];
            S.loaded = 0;
            S.done = false;
            S.selected = -1;
            details.classList.remove('on');
            dresize.classList.remove('on');
            details.textContent = '';
            pathEl.textContent = S.primary;
            statusEl.className = 'status';
            statusEl.textContent = S.truncated
                ? T('page.status.truncated', S.sent, S.total)
                : (msg.problems && msg.problems.length
                    ? T('page.status.problems', msg.problems.length)
                    : '');
            hintEl.textContent = S.columns.length < 2 ? T('page.hint.add') : '';
            renderHead();
            computeGrid();
            updateCount();
            updateButtons();
            render();
        } else if (msg.type === 'dirty') {
            // 只更新列头与按钮，不重建详情面板（用户可能正在文本框里打字）
            S.dirty = msg.files || [];
            renderHead();
            updateButtons();
        } else if (msg.type === 'stats') {
            if (msg.columns) { S.columns = msg.columns; renderHead(); }
        } else if (msg.type === 'select') {
            // 新增条目后用它：把那一行重新选中、光标放进对应格子
            if (typeof msg.row === 'number' && S.rows[msg.row]) { select(msg.row, msg.col); }
        } else if (msg.type === 'notice') {
            statusEl.className = 'status';
            statusEl.textContent = msg.text || '';
        } else if (msg.type === 'data') {
            var rows = msg.rows || [];
            for (var i = 0; i < rows.length; i++) { S.rows.push(rows[i]); }
            S.loaded = S.rows.length;
            // 每收一批就重筛一次；大文件会多扫几遍，小文件实时刷新更好看
            if (S.rows.length <= 5000) { applyFilter(false); } else { updateCount(); }
        } else if (msg.type === 'done') {
            S.done = true;
            S.loaded = msg.loaded == null ? S.rows.length : msg.loaded;
            applyFilter(false);
        } else if (msg.type === 'error') {
            statusEl.className = 'status bad';
            statusEl.textContent = T('page.error.open', msg.message);
        }
    });

    /* ---------------------------------------------------------- 交互 */

    var input = $('q');
    var timer = null;
    input.addEventListener('input', function () {
        if (timer) { window.clearTimeout(timer); }
        timer = window.setTimeout(function () {
            S.query = input.value.trim();
            compileQuery();
            applyFilter(true);
        }, 120);
    });

    input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            input.value = '';
            S.query = '';
            compileQuery();
            applyFilter(true);
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            step(e.key === 'ArrowDown' ? 1 : -1);
        }
    });

    /** 选中上/下一条（在筛选结果里走，不是原始行号） */
    function step(delta) {
        if (!S.view.length) { return; }
        var at = S.view.indexOf(S.selected);
        var next = at < 0 ? (delta > 0 ? 0 : S.view.length - 1) : at + delta;
        if (next < 0 || next >= S.view.length) { return; }
        var row = S.view[next];
        select(row);
        var top = next * ROW_H, bottom = top + ROW_H;
        if (top < wrap.scrollTop) { wrap.scrollTop = top; }
        else if (bottom > wrap.scrollTop + wrap.clientHeight) { wrap.scrollTop = bottom - wrap.clientHeight + ROW_H; }
        schedule();
    }

    $('chk-regex').addEventListener('change', function (e) {
        S.useRegex = e.target.checked;
        compileQuery();
        applyFilter(true);
    });
    $('chk-missing').addEventListener('change', function (e) {
        S.onlyMissing = e.target.checked;
        applyFilter(true);
    });

    $('btn-save').addEventListener('click', function () {
        flushEdit();   // 别把刚打完还没发出去的那一笔落下
        vscode.postMessage({ type: 'save' });
    });
    $('btn-revert').addEventListener('click', function () {
        vscode.postMessage({ type: 'revert' });
    });
    $('btn-add').addEventListener('click', function () { vscode.postMessage({ type: 'add' }); });
    $('btn-reload').addEventListener('click', function () { vscode.postMessage({ type: 'reload' }); });
    $('btn-text').addEventListener('click', function () { vscode.postMessage({ type: 'openText' }); });
    $('btn-json').addEventListener('click', function () { vscode.postMessage({ type: 'export', kind: 'json' }); });
    $('btn-csv').addEventListener('click', function () { vscode.postMessage({ type: 'export', kind: 'csv' }); });
    $('btn-copy').addEventListener('click', function () {
        var lines = [['id'].concat(S.columns.map(function (c) { return c.name; })).join('\\t')];
        for (var k = 0; k < S.view.length; k++) {
            var row = S.rows[S.view[k]];
            var cells = [String(row[0])];
            for (var c = 0; c < S.columns.length; c++) {
                var v = row[c + 1];
                cells.push(v === null || v === undefined ? '' : String(v).replace(/[\\t\\r\\n]+/g, ' '));
            }
            lines.push(cells.join('\\t'));
        }
        vscode.postMessage({ type: 'copy', text: lines.join('\\r\\n') });
    });

    document.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey)) { return; }
        var key = String(e.key).toLowerCase();
        if (key === 'f') {
            e.preventDefault();
            input.focus();
            input.select();
            return;
        }
        if (key === 's') {
            // webview 里的按键不一定能传到 VS Code 的快捷键系统，所以自己接一道；
            // 那边 package.json 里也绑了 activeCustomEditorId 的 Ctrl+S，两条路都通到同一个保存
            e.preventDefault();
            flushEdit();
            vscode.postMessage({ type: 'save' });
        }
    });

    wrap.addEventListener('scroll', function () {
        headwrap.scrollLeft = wrap.scrollLeft;
        schedule();
    });
    window.addEventListener('resize', function () { computeGrid(); growAll(); schedule(); });

    /* ---------------------------------------------------------- 拖高编辑区 */

    // 高度记在元素上，换行 / 重建面板都不会丢
    (function () {
        var dragging = null;

        function endDrag() {
            if (!dragging) { return; }
            dragging = null;
            dresize.classList.remove('drag');
            growAll();   // 编辑区高了 / 矮了，里面的框按新宽度重新量
        }

        dresize.addEventListener('mousedown', function (e) {
            if (e.button !== 0) { return; }
            dragging = { y: e.clientY, height: details.getBoundingClientRect().height };
            dresize.classList.add('drag');
            e.preventDefault();   // 别顺手选中表格里的字
        });

        window.addEventListener('mousemove', function (e) {
            if (!dragging) { return; }
            // 鼠标在 webview 外松开收不到 mouseup，用按键状态兜底，否则会一直粘着拖
            if (e.buttons === 0) { endDrag(); return; }
            var limit = Math.round(window.innerHeight * 0.85);
            var want = dragging.height + (dragging.y - e.clientY);   // 往上拖 = 变高
            details.style.maxHeight = 'none';
            details.style.height = Math.max(60, Math.min(want, limit)) + 'px';
        });

        window.addEventListener('mouseup', endDrag);
        window.addEventListener('blur', endDrag);
    }());

    vscode.postMessage({ type: 'ready' });
}());`;

    return `<!DOCTYPE html>
<html lang="${i18n.locale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="title">
    <h1>${i18n.t('page.title')}</h1>
    <span class="path" id="path"></span>
  </div>
  <div class="toolbar">
    <input type="search" id="q" placeholder="${i18n.t('page.search')}" spellcheck="false">
    <label class="chk"><input type="checkbox" id="chk-regex">${i18n.t('page.regex')}</label>
    <label class="chk"><input type="checkbox" id="chk-missing">${i18n.t('page.onlyMissing')}</label>
    <span class="count" id="count"></span>
    <span style="flex:1"></span>
    <button class="primary" id="btn-save" disabled>${i18n.t('page.save')}</button>
    <button id="btn-revert">${i18n.t('page.revert')}</button>
    <button id="btn-add">${i18n.t('page.add')}</button>
    <button id="btn-text">${i18n.t('page.openText')}</button>
    <button id="btn-json">${i18n.t('page.exportJson')}</button>
    <button id="btn-csv">${i18n.t('page.exportCsv')}</button>
    <button id="btn-copy">${i18n.t('page.copy')}</button>
    <button id="btn-reload">${i18n.t('page.reload')}</button>
  </div>
  <div class="hint" id="hint"></div>
</header>
<div class="headwrap" id="headwrap"><div class="headrow" id="headrow"></div></div>
<div class="wrap" id="wrap">
  <div class="spacer" id="spacer"><div class="rows" id="rows"></div></div>
</div>
<div class="dresize" id="dresize" title="${i18n.t('page.resizeTitle')}"></div>
<div class="details" id="details"></div>
<div class="status" id="status"></div>
<script nonce="${nonce}">
${script}
</script>
</body>
</html>
`;
}

module.exports = { shellHtml };
