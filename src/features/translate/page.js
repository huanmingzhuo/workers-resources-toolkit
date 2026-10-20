'use strict';

/**
 * 翻译工作台的页面（HTML + CSS + 页面脚本），只有 `shellHtml()` 一个出口。
 *
 * 与 index.js 的分工：这个文件只知道"怎么画"，数据从哪来、往哪写全在 index.js / data.js。
 *
 * ## 消息协议（都用 postMessage，页面里不内联任何数据文件）
 *
 *   插件 → 页面
 *     { type:'data', payload }              整份数据（切换语言 / 点重新读取后重发）
 *     { type:'notice', text }                状态栏一句话
 *     { type:'error', message }              状态栏红字
 *
 *   页面 → 插件
 *     { type:'ready' }                       页面加载好，请把数据发过来
 *     { type:'reload', target, source }      换语言对，重新读
 *     { type:'save', changes:[{file,group,key,text}, …] }   只发改过的键
 *
 * 数据总共一千多条，直接全画；筛选就是对已加载的数组过一遍，用不着虚拟滚动。
 */

/** 行高（像素）。CSS 里的 .row 要跟着改 */
const ROW_H = 26;

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
h1 { font-size: 1em; margin: 0 0 8px; font-weight: 600; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
button {
  font-family: inherit; font-size: .92em; padding: 3px 9px; border-radius: 3px; cursor: pointer;
  border: 1px solid transparent;
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.22));
  color: var(--vscode-button-secondaryForeground, inherit);
}
button.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
button:disabled { opacity: .5; cursor: default; }
input[type=search], select {
  font-family: inherit; font-size: .95em; padding: 3px 8px; border-radius: 3px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
}
input[type=search] { min-width: 220px; }
label.chk { display: inline-flex; align-items: center; gap: 4px; font-size: .92em; opacity: .9; white-space: nowrap; }
.count { font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; opacity: .8; }
.root {
  margin-top: 3px; font-size: .85em; opacity: .7; word-break: break-all;
  font-family: var(--vscode-editor-font-family, monospace);
}
.root.fallback { opacity: 1; color: var(--vscode-editorWarning-foreground, #cca700); }
.headrow, .row { display: grid; grid-template-columns: 34% 33% 33%; width: 100%; }
.headrow { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.headrow > div { padding: 4px 8px; font-size: .92em; font-weight: 600; overflow: hidden; }
.wrap { flex: 1 1 auto; overflow: auto; }
.row > div {
  padding: 2px 8px; line-height: calc(var(--row-h) - 4px); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  border-bottom: 1px solid rgba(128,128,128,.12);
  font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px);
}
.row { cursor: default; }
.row:hover > div { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
.row.sel > div { background: var(--vscode-list-activeSelectionBackground, rgba(0,127,212,.35)); }
.cell.key { opacity: .9; }
.cell.miss { opacity: .45; font-style: italic; }
.sec, .filehead { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.sec {
  padding: 6px 8px; font-weight: 600;
  background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,.16));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
}
.filehead {
  padding: 4px 8px 4px 20px; font-size: .92em;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
  border-bottom: 1px solid rgba(128,128,128,.18);
}
.sec .arrow, .filehead .arrow { opacity: .7; width: 1em; }
.sec .hcount, .filehead .hcount {
  margin-left: auto; font-weight: 400; opacity: .75;
  font-family: var(--vscode-editor-font-family, monospace); font-size: .88em;
}
.sec:hover, .filehead:hover { filter: brightness(1.12); }
.ctxmenu {
  position: fixed; z-index: 60; min-width: 160px; padding: 4px 0; border-radius: 4px;
  background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, inherit);
  border: 1px solid var(--vscode-menu-border, rgba(128,128,128,.35));
  box-shadow: 0 2px 10px rgba(0,0,0,.4);
}
.ctxitem { padding: 4px 12px; cursor: pointer; font-size: .95em; }
.ctxitem:hover { background: var(--vscode-menu-selectionBackground, rgba(0,127,212,.35)); }
/* 编辑区高度：与 BTF 对照视图用同一套（常显一条 1px 细线，悬停/拖动变蓝加粗） */
.dresize { flex: none; display: none; height: 6px; cursor: ns-resize; position: relative; }
.dresize.on { display: block; }
.dresize::after {
  content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 1px;
  background: var(--vscode-panel-border, rgba(128,128,128,.35));
}
.dresize:hover::after, .dresize.drag::after { background: var(--vscode-focusBorder, #007fd4); height: 2px; }
.details {
  flex: none; display: none; height: 240px; max-height: 50vh; overflow: auto; padding: 6px 12px 10px;
  background: var(--vscode-editorWidget-background, transparent);
}
.details.on { display: flex; flex-direction: column; }
.dhead { display: flex; align-items: center; gap: 8px; margin: 2px 0 6px; }
.dhead b { font-family: var(--vscode-editor-font-family, monospace); }
.dname { font-size: .9em; opacity: .8; margin-bottom: 2px; }
.src {
  padding: 4px 8px; border-radius: 3px; margin-bottom: 8px; white-space: pre-wrap;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
}
.dtext.none { font-style: italic; opacity: .6; }
textarea {
  display: block; width: 100%; flex: 1 1 auto; min-height: 60px; resize: none;
  padding: 4px 8px; border-radius: 3px;
  font-family: var(--vscode-editor-font-family, monospace); font-size: .95em; line-height: 1.45;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
}
.status {
  flex: none; padding: 4px 12px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  font-size: .9em; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.status.bad { color: var(--vscode-editorError-foreground, #f14c4c); opacity: 1; }
`;

/** 页面骨架。数据一律用 postMessage 送，页面里不内联任何数据文件 */
function shellHtml(webview, nonce, i18n) {
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`
    ].join('; ');

    // webview 里 require 不到插件宿主的东西，所以整份文案表注进页面。
    // `<` 转义成 \u003c：万一某条文案里有 `</script>`，也不至于把内联脚本提前截断
    const uiJson = JSON.stringify(i18n.dump()).replace(/</g, '\\u003c');

    const script = `
(function () {
    var vscode = acquireVsCodeApi();
    var UI = ${uiJson};

    /** 按 {0} {1} … 取文案；查不到就把键名显示出来（一眼能看出漏了） */
    function T(key) {
        var text = UI[key];
        if (text === undefined) { return String(key); }
        for (var i = 1; i < arguments.length; i++) {
            text = text.split('{' + (i - 1) + '}').join(String(arguments[i]));
        }
        return text;
    }

    var $ = function (id) { return document.getElementById(id); };
    var rowsEl = $('rows'), details = $('details'), statusEl = $('status'),
        countEl = $('count'), targetSel = $('target'), sourceSel = $('source'),
        fileSel = $('file'), qEl = $('q'), onlyMissingEl = $('chk-missing');

    var S = {
        data: null,        // 宿主发来的整份数据
        view: [],          // 当前筛选结果（下标数组）
        byFile: {},        // 文件 key → 可见条目的下标数组（画表时按板块分组用）
        selected: -1,
        edits: {},         // id → 新译文（只存改过的）
        dirtyCount: 0,
        collapsed: {}      // 'sec:xxx' / 'file:xxx' → true 表示折叠
    };

    /* ---------------------------------------------------------- 画表 */

    function statOf(key) {
        var list = (S.data && S.data.stats) || [];
        for (var i = 0; i < list.length; i++) { if (list[i].file === key) { return list[i]; } }
        return null;
    }

    function rowShown(e) {
        var q = qEl.value.trim().toLowerCase();
        if (onlyMissingEl.checked && e.filled) { return false; }
        if (fileSel.value && e.file !== fileSel.value) { return false; }
        if (!q) { return true; }
        return (e.key + ' ' + e.group + ' ' + e.source + ' ' + e.target).toLowerCase().indexOf(q) >= 0;
    }

    function applyFilter() {
        S.view = [];
        S.byFile = {};
        for (var i = 0; i < S.data.entries.length; i++) {
            var e = S.data.entries[i];
            if (!rowShown(e)) { continue; }
            S.view.push(i);
            if (!S.byFile[e.file]) { S.byFile[e.file] = []; }
            S.byFile[e.file].push(i);
        }
        render();
        updateCount();
    }

    /** 板块 / 文件的小标题（点一下折叠）。count 是「已填 / 总数」，不是筛选后的条数 */
    function headerEl(cls, text, count, key) {
        var el = document.createElement('div');
        el.className = cls;
        var arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = S.collapsed[key] ? '▸' : '▾';
        el.appendChild(arrow);
        var label = document.createElement('span');
        label.textContent = text;
        el.appendChild(label);
        if (count) {
            var cnt = document.createElement('span');
            cnt.className = 'hcount';
            cnt.textContent = count;
            el.appendChild(cnt);
        }
        el.addEventListener('click', function () { S.collapsed[key] = !S.collapsed[key]; render(); });
        return el;
    }

    /* ---------------------------------------------------------- 右键菜单 */

    // webview 里没有 VS Code 的原生右键菜单，自己画一个小的（用完即弃）
    var menuEl = null;

    function hideMenu() {
        if (menuEl) { menuEl.remove(); menuEl = null; }
    }

    /** 在某处弹出菜单。项固定两项：打开译文文件 / 打开原文文件 */
    function showMenu(x, y, e) {
        hideMenu();
        menuEl = document.createElement('div');
        menuEl.className = 'ctxmenu';
        [['page.openTarget', 'target'], ['page.openSource', 'source']].forEach(function (item) {
            var b = document.createElement('div');
            b.className = 'ctxitem';
            b.textContent = T(item[0]);
            b.addEventListener('click', function () {
                hideMenu();
                vscode.postMessage({ type: 'openFile', which: item[1], file: e.file, group: e.group, key: e.key });
            });
            menuEl.appendChild(b);
        });
        menuEl.style.left = Math.min(x, window.innerWidth - 180) + 'px';
        menuEl.style.top = y + 'px';
        document.body.appendChild(menuEl);
    }

    /** 跳到某一列对应的语言文件：原文列 → 原文语言的文件；译文列 → 目标语言的文件 */
    function jumpTo(i, which) {
        var e = S.data.entries[i];
        if (!e) { return; }
        vscode.postMessage({ type: 'openFile', which: which, file: e.file, group: e.group, key: e.key });
    }

    function buildRow(i) {
        var e = S.data.entries[i];
        var text = (S.edits[e.id] === undefined) ? e.target : S.edits[e.id];
        var row = document.createElement('div');
        row.className = 'row' + (i === S.selected ? ' sel' : '');
        var key = document.createElement('div');
        key.className = 'cell key';
        key.textContent = e.group ? (e.group + '.' + e.key) : e.key;

        // 原文格：双击跳到原文语言那份文件的这一条（单击仍然是"选中该行"）
        var src = document.createElement('div');
        src.className = 'cell' + (String(e.source || '').trim() ? '' : ' miss');
        src.textContent = String(e.source || '').trim() ? e.source : T('page.emptySource');
        src.title = e.source + '\\n' + T('page.jumpHint', S.data.source);
        src.addEventListener('dblclick', function () { jumpTo(i, 'source'); });

        // 译文格：双击跳目标语言那份文件（单击冒泡到行上 ⇒ 选中该行）
        var tgt = document.createElement('div');
        tgt.className = 'cell' + (String(text).trim() ? '' : ' miss');
        tgt.textContent = String(text).trim() ? text : T('page.emptyTarget');
        tgt.title = text + '\\n' + T('page.jumpHint', S.data.target);
        tgt.addEventListener('dblclick', function () { jumpTo(i, 'target'); });

        row.appendChild(key);
        row.appendChild(src);
        row.appendChild(tgt);
        row.addEventListener('click', function () { select(i); });
        // 右键：弹出「打开译文文件 / 打开原文文件」，顺便把这一行选中
        row.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            select(i);
            showMenu(ev.clientX, ev.clientY, e);
        });
        return row;
    }

    /**
     * 按「板块 → 文件」画表。筛选后没有可见行的分组不画 —— 配合「只看缺失」时，
     * 一屏看到的全是还没干的活，不用滚过一堆已翻完的文件。
     */
    function render() {
        rowsEl.textContent = '';
        var frag = document.createDocumentFragment();
        var sections = S.data.sectionList || [];
        var fileList = S.data.fileList || [];
        var secStats = S.data.sectionStats || [];

        for (var si = 0; si < sections.length; si++) {
            var sec = sections[si];
            var secFiles = [];
            for (var fi = 0; fi < fileList.length; fi++) {
                if (fileList[fi].section !== sec.key) { continue; }
                var hits = S.byFile[fileList[fi].key] || [];
                if (!hits.length) { continue; }
                secFiles.push({ file: fileList[fi], hits: hits });
            }
            if (!secFiles.length) { continue; }

            var ss = null;
            for (var k = 0; k < secStats.length; k++) {
                if (secStats[k].key === sec.key) { ss = secStats[k]; }
            }
            frag.appendChild(headerEl('sec', sec.label,
                ss ? T('page.count.filled', ss.filled, ss.total) : '', 'sec:' + sec.key));
            if (S.collapsed['sec:' + sec.key]) { continue; }

            for (var gi = 0; gi < secFiles.length; gi++) {
                var f = secFiles[gi].file;
                var st = statOf(f.key);
                frag.appendChild(headerEl('filehead', f.label,
                    st ? T('page.count.filled', st.filled, st.total) : '', 'file:' + f.key));
                if (S.collapsed['file:' + f.key]) { continue; }
                for (var hi = 0; hi < secFiles[gi].hits.length; hi++) {
                    frag.appendChild(buildRow(secFiles[gi].hits[hi]));
                }
            }
        }
        rowsEl.appendChild(frag);
    }

    function updateCount() {
        var d = S.data;
        var text = T('page.count.filtered', S.view.length, d.total) + ' · ' + T('page.count.filled', d.filled, d.total);
        if (S.dirtyCount) { text += ' · ' + T('page.dirty', S.dirtyCount); }
        countEl.textContent = text;
        $('btn-save').disabled = S.dirtyCount === 0;
    }

    /* ---------------------------------------------------------- 详情 */

    /** 某个文件条目的元信息（标签 / 相对路径），给"文件：…"那行和跳转用 */
    function fileInfoOf(key) {
        var list = (S.data && S.data.fileList) || [];
        for (var i = 0; i < list.length; i++) { if (list[i].key === key) { return list[i]; } }
        return null;
    }

    function select(i) {
        S.selected = i;
        if (i < 0) { details.classList.remove('on'); dresizeEl.classList.remove('on'); render(); return; }
        var e = S.data.entries[i];
        var current = (S.edits[e.id] === undefined) ? e.target : S.edits[e.id];

        details.textContent = '';
        var head = document.createElement('div');
        head.className = 'dhead';
        var name = document.createElement('b');
        name.textContent = e.group ? (e.group + '.' + e.key) : e.key;
        head.appendChild(name);
        var hint = document.createElement('span');
        hint.className = 'dname';
        hint.textContent = T('page.detail.hint');
        head.appendChild(hint);

        // 跳到文件：一个按钮，直接打开这一条的译文文件并定位到那一行。
        // 文案散在多个目录里，不该让人先选"开哪个" —— 路径就显示在下面一行
        var openBtn = document.createElement('button');
        openBtn.textContent = T('page.openTarget');
        openBtn.title = T('page.openTargetTitle');
        openBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'openFile', which: 'target', file: e.file, group: e.group, key: e.key });
        });
        head.appendChild(openBtn);

        var openSrcBtn = document.createElement('button');
        openSrcBtn.textContent = T('page.openSource');
        openSrcBtn.title = T('page.openSourceTitle');
        openSrcBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'openFile', which: 'source', file: e.file, group: e.group, key: e.key });
        });
        head.appendChild(openSrcBtn);

        var fileInfo = fileInfoOf(e.file);
        if (fileInfo && fileInfo.path) {
            var pathLine = document.createElement('div');
            pathLine.className = 'dname';
            pathLine.textContent = T('page.detail.path', fileInfo.path);
            details.appendChild(pathLine);
        }
        details.appendChild(head);

        // 关键字行：签名单独一行，填说明时不用再翻代码
        if (e.sig) {
            var sigLine = document.createElement('div');
            sigLine.className = 'dname';
            sigLine.textContent = T('page.detail.sig', e.sig);
            details.appendChild(sigLine);
        }

        var srcLabel = document.createElement('div');
        srcLabel.className = 'dname';
        srcLabel.textContent = T('page.detail.source', S.data.source);
        details.appendChild(srcLabel);
        var srcBox = document.createElement('div');
        srcBox.className = 'src';
        srcBox.textContent = e.source || T('page.detail.noSource');
        details.appendChild(srcBox);

        var tgtLabel = document.createElement('div');
        tgtLabel.className = 'dname';
        tgtLabel.textContent = T('page.detail.target', S.data.target);
        details.appendChild(tgtLabel);
        var area = document.createElement('textarea');
        area.value = current;
        area.spellcheck = false;
        area.addEventListener('input', function () { onEdit(e.id, area.value); });
        details.appendChild(area);
        details.classList.add('on');
        dresizeEl.classList.add('on');   // 分隔条跟着出现（与 BTF 一致）
        render();
        area.focus();
    }

    /**
     * 记下改动：与宿主发来的原值相同就当作没改（避免"看着脏其实没变"）。
     * 表格重画走定时器 —— 一千多行每敲一个字重画一遍会顿，200ms 合并一次足够跟手。
     */
    var renderTimer = null;
    function scheduleRender() {
        if (renderTimer) { window.clearTimeout(renderTimer); }
        renderTimer = window.setTimeout(render, 200);
    }

    function onEdit(id, text) {
        var e = null;
        for (var i = 0; i < S.data.entries.length; i++) {
            if (S.data.entries[i].id === id) { e = S.data.entries[i]; break; }
        }
        if (!e) { return; }
        if (text === e.target) { delete S.edits[id]; } else { S.edits[id] = text; }
        S.dirtyCount = Object.keys(S.edits).length;
        updateCount();
        scheduleRender();
    }

    function changes() {
        var out = [];
        for (var id in S.edits) {
            if (!Object.prototype.hasOwnProperty.call(S.edits, id)) { continue; }
            var e = null;
            for (var i = 0; i < S.data.entries.length; i++) {
                if (S.data.entries[i].id === id) { e = S.data.entries[i]; break; }
            }
            if (e) { out.push({ file: e.file, group: e.group, key: e.key, text: S.edits[id] }); }
        }
        return out;
    }

    function save() {
        if (!S.dirtyCount) { return; }
        vscode.postMessage({ type: 'save', changes: changes() });
    }

    /* ---------------------------------------------------------- 换语言 */

    /**
     * 换语言。确认框由宿主弹 —— webview 里的 window.confirm() 不可用，
     * 写了会让"脏状态下永远切不了语言"。取消时宿主会回一条 selection，把下拉选回去。
     */
    function reload() {
        vscode.postMessage({
            type: 'reload',
            target: targetSel.value,
            source: sourceSel.value,
            dirty: S.dirtyCount > 0
        });
    }

    /* ---------------------------------------------------------- 交互 */

    // 右键菜单：点别处 / 按 Esc / 滚动列表就收起来
    document.addEventListener('click', hideMenu);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideMenu(); } });
    rowsEl.parentNode.addEventListener('scroll', hideMenu);

    // 编辑区高度：与 BTF 同一套做法 —— 高度记在元素上（换行、重建面板都不丢）；
    // 鼠标在 webview 外面松手时收不到 mouseup，用按键状态兜底，不然会一直粘着拖。
    var dresizeEl = $('dresize');
    (function () {
        var dragging = null;

        function endDrag() {
            if (!dragging) { return; }
            dragging = null;
            dresizeEl.classList.remove('drag');
        }

        dresizeEl.addEventListener('mousedown', function (ev) {
            if (ev.button !== 0) { return; }
            dragging = { y: ev.clientY, height: details.getBoundingClientRect().height };
            dresizeEl.classList.add('drag');
            ev.preventDefault();   // 别顺手选中表格里的字
        });

        window.addEventListener('mousemove', function (ev) {
            if (!dragging) { return; }
            if (ev.buttons === 0) { endDrag(); return; }
            var limit = Math.round(window.innerHeight * 0.85);
            var want = dragging.height + (dragging.y - ev.clientY);   // 往上拖 = 变高
            details.style.maxHeight = 'none';
            details.style.height = Math.max(60, Math.min(want, limit)) + 'px';
        });

        window.addEventListener('mouseup', endDrag);
        window.addEventListener('blur', endDrag);
    }());

    qEl.addEventListener('input', applyFilter);
    onlyMissingEl.addEventListener('change', applyFilter);
    fileSel.addEventListener('change', applyFilter);
    targetSel.addEventListener('change', reload);
    sourceSel.addEventListener('change', reload);
    $('btn-save').addEventListener('click', save);
    $('btn-reload').addEventListener('click', reload);
    $('btn-addLocale').addEventListener('click', function () { vscode.postMessage({ type: 'addLocale' }); });
    $('btn-syncKeys').addEventListener('click', function () { vscode.postMessage({ type: 'syncKeys' }); });

    document.addEventListener('keydown', function (e) {
        if (!(e.ctrlKey || e.metaKey)) { return; }
        if (String(e.key).toLowerCase() === 's') { e.preventDefault(); save(); }
    });

    window.addEventListener('message', function (event) {
        var msg = event.data || {};
        if (msg.type === 'data') {
            S.data = msg.payload;
            S.edits = {};
            S.dirtyCount = 0;
            S.selected = -1;
            details.classList.remove('on');
            dresizeEl.classList.remove('on');
            details.textContent = '';
            var list = msg.payload.localeList || [];
            var locItems = [];
            for (var li = 0; li < list.length; li++) { locItems.push({ value: list[li], label: list[li] }); }
            var files = msg.payload.fileList || [];
            var fileItems = [{ value: '', label: T('page.filter.allFiles') }];
            for (var fi = 0; fi < files.length; fi++) {
                fileItems.push({ value: files[fi].key, label: files[fi].label });
            }
            fillSelect(sourceSel, locItems, msg.payload.source);
            fillSelect(targetSel, locItems, msg.payload.target);
            fillSelect(fileSel, fileItems, fileSel.value);
            // 当前在编辑哪个仓库：面板只在认到仓库时才打得开，所以这里一定是从工作区认出来的
            var rootEl = $('root');
            rootEl.className = 'root';
            rootEl.textContent = msg.payload.root ? T('page.root', msg.payload.root) : '';
            statusEl.className = 'status';
            statusEl.textContent = '';
            applyFilter();
        } else if (msg.type === 'selection') {
            // 换语言被取消：把两个下拉选回当前值（数据与未保存的改动都不动）
            if (msg.source) { sourceSel.value = msg.source; }
            if (msg.target) { targetSel.value = msg.target; }
        } else if (msg.type === 'notice') {
            statusEl.className = 'status';
            statusEl.textContent = msg.text || '';
        } else if (msg.type === 'error') {
            statusEl.className = 'status bad';
            statusEl.textContent = msg.message || '';
        }
    });

    /** 填一个 select。items = [{ value, label }]，label 已由宿主翻译好 */
    function fillSelect(sel, items, current) {
        sel.textContent = '';
        for (var i = 0; i < items.length; i++) {
            var opt = document.createElement('option');
            opt.value = items[i].value;
            opt.textContent = items[i].label;
            if (items[i].value === current) { opt.selected = true; }
            sel.appendChild(opt);
        }
    }

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
  <h1>${i18n.t('page.title')}</h1>
  <div class="root" id="root"></div>
  <div class="toolbar">
    <label class="chk">${i18n.t('page.label.source')}
      <select id="source"></select>
    </label>
    <label class="chk">${i18n.t('page.label.target')}
      <select id="target"></select>
    </label>
    <select id="file"></select>
    <input type="search" id="q" placeholder="${i18n.t('page.search')}" spellcheck="false">
    <label class="chk"><input type="checkbox" id="chk-missing">${i18n.t('page.onlyMissing')}</label>
    <span class="count" id="count"></span>
    <span style="flex:1"></span>
    <button class="primary" id="btn-save" disabled>${i18n.t('page.save')}</button>
    <button id="btn-reload">${i18n.t('page.reload')}</button>
    <button id="btn-addLocale">${i18n.t('page.addLocale')}</button>
    <button id="btn-syncKeys">${i18n.t('page.syncKeys')}</button>
  </div>
</header>
<div class="headrow">
  <div>${i18n.t('page.col.key')}</div>
  <div>${i18n.t('page.col.source')}</div>
  <div>${i18n.t('page.col.target')}</div>
</div>
<div class="wrap"><div id="rows"></div></div>
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

module.exports = { shellHtml, ROW_H };
