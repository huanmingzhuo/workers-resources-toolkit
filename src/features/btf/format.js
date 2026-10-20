'use strict';


/** 界面文案（校验提示、文本视图） */
const i18n = require('../../core/i18n').use('btf');

/** 文件头大小（字节） */
const HEADER_SIZE = 12;

/** 每条翻译定义的大小（字节） */
const DEFINITION_SIZE = 10;

/** int16 正上限：更长的文本写不下，build 时会拦 */
const MAX_TEXT_LENGTH = 32767;

/* ------------------------------------------------------------------ 基础工具 */

/** 统一成 Uint8Array（Buffer 也是 Uint8Array，不用特判） */
function asUint8(bytes) {
    if (bytes instanceof Uint8Array) { return bytes; }
    if (bytes instanceof ArrayBuffer) { return new Uint8Array(bytes); }
    if (bytes && bytes.buffer instanceof ArrayBuffer) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength || 0);
    }
    throw new TypeError('BTF：需要 Uint8Array / Buffer / ArrayBuffer');
}

function problem(level, text) {
    return { level, text };
}

/**
 * 把一段 UTF-16 大端字节解成 JS 字符串。
 * JS 字符串本身就是 UTF-16 码元序列，所以这里天然是无损的（含代理对）。
 */
function decodeUtf16BE(u8, byteOffset, charCount) {
    const CHUNK = 4096;
    let text = '';
    let units = [];
    for (let i = 0; i < charCount; i++) {
        const p = byteOffset + i * 2;
        units.push((u8[p] << 8) | u8[p + 1]);
        if (units.length >= CHUNK) {
            text += String.fromCharCode.apply(null, units);
            units = [];
        }
    }
    if (units.length) { text += String.fromCharCode.apply(null, units); }
    return text;
}

/** 把 JS 字符串写成 UTF-16 大端字节；返回写进去的字节数 */
function encodeUtf16BE(target, byteOffset, text) {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        target[byteOffset + i * 2] = c >>> 8;
        target[byteOffset + i * 2 + 1] = c & 0xff;
    }
    return text.length * 2;
}

/**
 * 修掉落单的代理项（U+FFFD）。文件是任意字节流，可能含半截代理对，
 */
function fixSurrogates(text) {
    let out = '';
    let replaced = 0;
    let i = 0;
    while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const d = text.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { out += text.substr(i, 2); i += 2; continue; }
            out += '\ufffd'; replaced++; i++; continue;
        }
        if (c >= 0xdc00 && c <= 0xdfff) { out += '\ufffd'; replaced++; i++; continue; }
        out += text[i]; i++;
    }
    return { text: out, replaced };
}

/* ------------------------------------------------------------------ 解析 */

/**
 * 解析一份 BTF 字节流。
 *
 * 不抛异常：坏文件也照常返回，问题写进 `problems`。
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} bytes
 * @returns {{
 *   ok: boolean,
 *   header: { translationCount: number, fileLength: number, textCharCount: number },
 *   entries: Array<{ index: number, id: number, charOffset: number, length: number, text: string, textByteOffset: number, terminated: boolean }>,
 *   problems: Array<{ level: 'error'|'warning', text: string }>,
 *   stats: object
 * }}
 */
function parse(bytes) {
    const u8 = asUint8(bytes);
    const fileSize = u8.length;
    const problems = [];
    const header = { translationCount: 0, fileLength: 0, textCharCount: 0 };
    const entries = [];
    const stats = {
        fileSize,
        definitionEnd: HEADER_SIZE,
        textBytes: 0,
        textChars: 0,
        declaredChars: 0,
        sumOfLengths: 0,
        duplicatedIds: 0,
        replacedChars: 0,
        parseable: false
    };

    if (fileSize < HEADER_SIZE) {
        problems.push(problem('error', i18n.t('parse.tooShort', fileSize, HEADER_SIZE)));
        return { ok: false, header, entries, problems, stats };
    }

    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    header.translationCount = dv.getInt32(0, false);
    header.fileLength = dv.getInt32(4, false);
    header.textCharCount = dv.getInt32(8, false);

    if (header.fileLength !== fileSize) {
        const hint = i18n.t(header.fileLength > fileSize ? 'parse.truncatedHint' : 'parse.appendedHint');
        problems.push(problem('warning',
            i18n.t('parse.lengthMismatch', header.fileLength, fileSize, hint)));
    }
    if (header.textCharCount < 0) {
        problems.push(problem('error', i18n.t('parse.negativeCharCount', header.textCharCount)));
    }

    const declaredCount = header.translationCount;
    if (declaredCount < 0) {
        problems.push(problem('error', i18n.t('parse.negativeCount', declaredCount)));
    }

    // 定义表装不下就只按文件里真实存在的条目解析，剩下当成坏文件报出来
    const maxFit = Math.max(0, Math.floor((fileSize - HEADER_SIZE) / DEFINITION_SIZE));
    const count = Math.min(Math.max(declaredCount, 0), maxFit);
    if (declaredCount > maxFit) {
        problems.push(problem('error', i18n.t('parse.tableTooBig',
            declaredCount, HEADER_SIZE + declaredCount * DEFINITION_SIZE, fileSize, maxFit)));
    }

    const definitionEnd = HEADER_SIZE + count * DEFINITION_SIZE;
    const textBase = HEADER_SIZE + Math.max(declaredCount, 0) * DEFINITION_SIZE;
    stats.definitionEnd = definitionEnd;
    stats.textBytes = Math.max(0, fileSize - textBase);
    stats.textChars = Math.floor(stats.textBytes / 2);
    stats.declaredChars = header.textCharCount;
    stats.parseable = true;

    if (stats.textBytes % 2 !== 0) {
        problems.push(problem('warning', i18n.t('parse.oddTextBytes', textBase, stats.textBytes)));
    }

    // 文本区整个都不在文件里（条目数是天文数字，或文件被截得很狠）：每条都会越界，
    // 逐条报会产出几十万条字符串，所以只报一次，id / 偏移 / 长度照样列出，文本留空。
    const textAreaMissing = textBase >= fileSize;
    if (textAreaMissing && count > 0) {
        problems.push(problem('error', i18n.t('parse.noTextArea', textBase, fileSize)));
    }

    const seen = new Map();
    for (let i = 0; i < count; i++) {
        const base = HEADER_SIZE + i * DEFINITION_SIZE;
        const id = dv.getInt32(base, false);
        const charOffset = dv.getInt32(base + 4, false);
        const length = dv.getInt16(base + 8, false);

        const textByteOffset = textBase + charOffset * 2;
        let text = '';
        let terminated = false;

        if (textAreaMissing) {
            // 文本区不存在：上面已经报过一次，这里不再逐条报
        } else if (length < 0) {
            problems.push(problem('warning', i18n.t('parse.entry.badLength', i, id, length)));
        } else if (charOffset < 0) {
            problems.push(problem('error', i18n.t('parse.entry.badOffset', i, id, charOffset)));
        } else if (textByteOffset + length * 2 > fileSize) {
            problems.push(problem('error', i18n.t('parse.entry.outOfRange',
                i, id, textByteOffset, length * 2, fileSize)));
        } else {
            text = decodeUtf16BE(u8, textByteOffset, length);
            // 末尾那个 \0 是否真的在
            if (textByteOffset + (length + 1) * 2 <= fileSize) {
                const term = (u8[textByteOffset + length * 2] << 8) | u8[textByteOffset + length * 2 + 1];
                terminated = term === 0;
                if (!terminated) {
                    problems.push(problem('warning', i18n.t('parse.entry.notTerminated',
                        i, id, length, term.toString(16).toUpperCase().padStart(4, '0'))));
                }
            }
        }

        const fixed = fixSurrogates(text);
        if (fixed.replaced) {
            stats.replacedChars += fixed.replaced;
            problems.push(problem('warning', i18n.t('parse.entry.badSurrogates', i, id, fixed.replaced)));
        }

        if (seen.has(id)) { stats.duplicatedIds++; }
        seen.set(id, (seen.get(id) || 0) + 1);

        stats.sumOfLengths += Math.max(length, 0) + 1;
        entries.push({
            index: i,
            id,
            charOffset,
            length,
            text: fixed.text,
            textByteOffset,
            terminated
        });
    }

    // 最强的一条一致性校验：文本区字符数应等于各条 (length+1) 之和
    // （逐条写 length 个字符 + 一个 \0，条目之间没有填充）
    if (stats.parseable && declaredCount <= maxFit && stats.sumOfLengths !== header.textCharCount) {
        problems.push(problem('warning', i18n.t('parse.sumMismatch',
            header.textCharCount, count, stats.sumOfLengths,
            stats.sumOfLengths - header.textCharCount)));
    }

    if (stats.duplicatedIds > 0) {
        problems.push(problem('warning', i18n.t('parse.duplicatedIds', stats.duplicatedIds)));
    }

    return {
        ok: !problems.some(p => p.level === 'error'),
        header,
        entries,
        problems,
        stats
    };
}

/* ------------------------------------------------------------------ 生成 */

/**
 * 把 `[{ id, text }]` 生成 BTF 字节流：
 * 文本区按顺序重排，charOffset 重算，所以不保证与源文件逐字节相同，只保证内容与格式。
 *
 * 装不下的情况（id 超 int32、文本长于 32767 字符）直接抛错，不静默截断。
 *
 * @param {Array<{ id: number|string, text: string }>} entries
 * @returns {Uint8Array}
 */
function build(entries) {
    if (!Array.isArray(entries)) {
        throw new TypeError(i18n.t('build.entriesNotArray'));
    }

    const normalized = [];
    let textCharCount = 0;
    for (let i = 0; i < entries.length; i++) {
        const raw = entries[i] || {};
        const id = Number(raw.id);
        if (!Number.isInteger(id) || id < -2147483648 || id > 2147483647) {
            throw new Error(i18n.t('build.badId', i + 1, JSON.stringify(raw.id)));
        }
        const text = raw.text == null ? '' : String(raw.text);
        if (text.length > MAX_TEXT_LENGTH) {
            throw new Error(i18n.t('build.textTooLong', i + 1, id, text.length, MAX_TEXT_LENGTH));
        }
        normalized.push({ id, text, charOffset: textCharCount });
        textCharCount += text.length + 1;
    }

    const definitionEnd = HEADER_SIZE + normalized.length * DEFINITION_SIZE;
    const total = definitionEnd + textCharCount * 2;
    if (total > 0x7fffffff) {
        throw new Error(i18n.t('build.tooLarge', total));
    }

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, normalized.length, false);
    dv.setInt32(4, total, false);
    dv.setInt32(8, textCharCount, false);

    for (let i = 0; i < normalized.length; i++) {
        const e = normalized[i];
        const base = HEADER_SIZE + i * DEFINITION_SIZE;
        dv.setInt32(base, e.id, false);
        dv.setInt32(base + 4, e.charOffset, false);
        dv.setInt16(base + 8, e.text.length, false);
        encodeUtf16BE(out, definitionEnd + e.charOffset * 2, e.text);
    }
    return out;
}

/**
 * 读「导出的 JSON」（或任何 `{ entries: [...] }` / 裸数组）里的条目。
 * 只取 id 与 text —— 其余字段（charOffset / length）是推导出来的，会在 build 时重算。
 */
function readEntriesJson(jsonText) {
    let raw;
    try {
        raw = JSON.parse(jsonText);
    } catch (err) {
        throw new Error(i18n.t('json.parseFailed', err.message));
    }
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : null);
    if (!list) {
        throw new Error(i18n.t('json.noEntries'));
    }
    return list.map((item, i) => {
        if (!item || typeof item !== 'object') {
            throw new Error(i18n.t('json.itemNotObject', i + 1));
        }
        if (item.id == null || item.text == null) {
            throw new Error(i18n.t('json.itemMissing', i + 1));
        }
        return { id: Number(item.id), text: String(item.text) };
    });
}

/* ------------------------------------------------------------------ 多语言对照 */

/**
 * 把多个 BTF 的解析结果对齐成一张对照表。
 *
 * 对齐键是 id，不是行号：不同语言的条目数、顺序都可能不同，按行号对齐会张冠李戴，
 * 而且错得很安静。id 是这份格式里唯一的"翻译键"。
 *
 * ids 的顺序：主文件在前（那是游戏里的顺序），之后只补各文件独有的 id。
 * 同一文件里重复 id 以第一条为准，条数记进 `columns[].duplicated`。
 *
 * @param {Array<ReturnType<typeof parse>>} parsedList 第 0 个是主文件
 * @returns {{
 *   ids: number[],
 *   cells: Array<Array<string|null>>,        // cells[列][行]；null = 该文件里没有这个 id
 *   indexes: Array<Array<number>>,           // indexes[列][行] = 该文件 entries 里的下标，-1 = 没有
 *   rows: Array<Array<number|string|null>>,  // rows[行] = [id, 列0文本, 列1文本, …]，给视图直接用
 *   columns: Array<{ count: number, missing: number, empty: number, duplicated: number,
 *                    ok: boolean, problems: number }>
 * }}
 */
function mergeTranslations(parsedList) {
    const list = (parsedList || []).filter(Boolean);

    const ids = [];
    const at = new Map();
    for (const parsed of list) {
        for (const e of parsed.entries) {
            if (!at.has(e.id)) { at.set(e.id, ids.length); ids.push(e.id); }
        }
    }

    const duplicated = [];
    const indexes = [];
    const cells = list.map(parsed => {
        const col = new Array(ids.length).fill(null);
        const idx = new Array(ids.length).fill(-1);
        const dup = new Set();
        for (const e of parsed.entries) {
            const i = at.get(e.id);
            if (i === undefined) { continue; }
            if (col[i] !== null) { dup.add(e.id); continue; }
            col[i] = e.text;
            // 编辑要写回条目，所以要留下它在 entries 里的下标（不是行号，也不是 id）
            idx[i] = e.index;
        }
        duplicated.push(dup);
        indexes.push(idx);
        return col;
    });

    const columns = cells.map((col, j) => {
        let missing = 0;
        let empty = 0;
        for (let i = 0; i < col.length; i++) {
            if (col[i] === null) { missing++; } else if (col[i] === '') { empty++; }
        }
        return {
            count: list[j].entries.length,
            missing,
            empty,
            duplicated: duplicated[j].size,
            ok: list[j].ok,
            problems: list[j].problems.length
        };
    });

    const rows = ids.map((id, i) => {
        const row = [id];
        for (const col of cells) { row.push(col[i]); }
        return row;
    });

    return { ids, cells, indexes, rows, columns };
}

/* ------------------------------------------------------------------ 输出 */
function escapeForView(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const c = text.charCodeAt(i);
        if (ch === '\\') { out += '\\\\'; continue; }
        if (ch === '\t') { out += '\\t'; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') { out += '\\r'; continue; }
        if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
            out += '\\x' + c.toString(16).toUpperCase().padStart(2, '0');
            continue;
        }
        out += ch;
    }
    return out;
}

function yesNo(ok) { return i18n.t(ok ? 'report.match' : 'report.mismatch'); }

/** 显示宽度：全角字符（中文等）占两格，其余一格 */
function textWidth(text) {
    let w = 0;
    for (const ch of String(text)) {
        const c = ch.codePointAt(0);
        w += (c >= 0x1100 && (
            c <= 0x115f ||
            c === 0x2329 || c === 0x232a ||
            (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
            (c >= 0xac00 && c <= 0xd7a3) ||
            (c >= 0xf900 && c <= 0xfaff) ||
            (c >= 0xfe10 && c <= 0xfe19) ||
            (c >= 0xfe30 && c <= 0xfe6f) ||
            (c >= 0xff00 && c <= 0xff60) ||
            (c >= 0xffe0 && c <= 0xffe6) ||
            (c >= 0x1f300 && c <= 0x1f64f) ||
            (c >= 0x1f900 && c <= 0x1f9ff) ||
            (c >= 0x20000 && c <= 0x3fffd)
        )) ? 2 : 1;
    }
    return w;
}

/** 右补空格到指定显示宽度，已经够宽就原样返回 */
function padTo(text, width) {
    const n = width - textWidth(text);
    return n > 0 ? String(text) + ' '.repeat(n) : String(text);
}

/**
 * 生成只读 BTF 视图的文本内容。
 *
 * 格式：开头是 `;` 注释（文件信息 + 校验结果），然后一行表头 + 每行一条：
 *
 *     index  id  charOffset  length  text
 *
 * 前四列按「表头与数据里最长的那个」补空格对齐，text 在最后不补。
 * 要导进表格请用 CSV / JSON 导出，视图里的空格不是分隔符。
 *
 * @param {ReturnType<typeof parse>} parsed
 * @param {{ source?: string, maxEntries?: number }} [options]
 */
function toTextReport(parsed, options) {
    const opt = options || {};
    const maxEntries = opt.maxEntries && opt.maxEntries > 0 ? opt.maxEntries : 0;
    const source = opt.source || i18n.t('report.unknownSource');
    const h = parsed.header;
    const s = parsed.stats;

    const lines = [];
    const rule = ';' + '─'.repeat(72);
    lines.push(rule);
    lines.push(i18n.t('report.title'));
    lines.push(i18n.t('report.subtitle'));
    lines.push(rule);
    lines.push(i18n.t('report.source', source));
    if (!s.parseable) {
        lines.push(i18n.t('report.unparseable'));
    } else {
        lines.push(i18n.t('report.fileSize',
            s.fileSize, h.fileLength, yesNo(h.fileLength === s.fileSize)));
        lines.push(i18n.t('report.entries',
            parsed.entries.length,
            h.translationCount === parsed.entries.length ? '' : i18n.t('report.headerCount', h.translationCount),
            HEADER_SIZE, s.definitionEnd, DEFINITION_SIZE));
        lines.push(i18n.t('report.textArea',
            s.definitionEnd, s.fileSize, s.textChars,
            h.textCharCount, yesNo(h.textCharCount === s.textChars)));
        lines.push(i18n.t('report.structure',
            i18n.t(parsed.ok ? 'report.passed' : 'report.failed'),
            parsed.problems.length ? i18n.t('report.problems', parsed.problems.length) : ''));
    }
    lines.push(i18n.t('report.escapes'));

    const shown = maxEntries > 0 ? Math.min(maxEntries, parsed.entries.length) : parsed.entries.length;
    if (shown < parsed.entries.length) {
        lines.push(i18n.t('report.range', shown, parsed.entries.length));
        lines.push(i18n.t('report.rangeNote'));
    }

    if (parsed.problems.length) {
        lines.push(rule);
        const MAX_PROBLEMS = 50;
        for (const p of parsed.problems.slice(0, MAX_PROBLEMS)) {
            const tag = i18n.t(p.level === 'error' ? 'report.problemError' : 'report.problemWarning');
            lines.push(`; ${tag} ${p.text}`);
        }
        if (parsed.problems.length > MAX_PROBLEMS) {
            lines.push(i18n.t('report.moreProblems', parsed.problems.length - MAX_PROBLEMS));
        }
    }
    lines.push(rule);

    const head = [
        i18n.t('report.col.index'),
        i18n.t('report.col.id'),
        i18n.t('report.col.charOffset'),
        i18n.t('report.col.length'),
        i18n.t('report.col.text')
    ];
    const rows = [];
    for (let i = 0; i < shown; i++) {
        const e = parsed.entries[i];
        rows.push([e.index, e.id, e.charOffset, e.length, escapeForView(e.text)]);
    }

    // 前四列按显示宽度定宽（中文算两格），text 是最后一列，不补
    const widths = head.slice(0, 4).map((name, c) => {
        let w = textWidth(name);
        for (const r of rows) {
            const n = textWidth(r[c]);
            if (n > w) { w = n; }
        }
        return w;
    });
    const formatRow = (cells) => cells.slice(0, 4)
        .map((v, c) => padTo(v, widths[c]))
        .join('  ') + (cells[4] ? '  ' + cells[4] : '');

    lines.push(formatRow(head));
    for (const r of rows) { lines.push(formatRow(r)); }

    return lines.join('\n') + '\n';
}

/** 导出用的 JSON。只留 id 与 text —— 偏移与长度是推导出来的，重建时重算 */
function toJson(parsed, options) {
    const source = (options && options.source) || '';
    const entries = parsed.entries.map(e => ({ id: e.id, text: e.text }));
    return JSON.stringify({
        _note: i18n.t('json.note'),
        source,
        entries
    }, null, 2) + '\n';
}

/** CSV 单元格（RFC 4180：逗号/引号/换行会触发双引号包裹，内部引号翻倍） */
function csvField(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 导出用的 CSV（带 UTF-8 BOM 方便 Excel） */
function toCsv(parsed) {
    const lines = ['id,text'];
    for (const e of parsed.entries) {
        lines.push(csvField(e.id) + ',' + csvField(e.text));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/**
 * 多语言对照的 CSV：第一列 id，之后每个文件一列。
 *
 * `rows` 就是 mergeTranslations 的 `rows`（`[id, 文本…]`）。
 * 缺失（该文件没有这个 id）与空译文都写成空单元格 —— id 是主键，
 * 其他列空着就表示"这条还没翻"，正好可以直接交给翻译流程。
 */
function toComparisonCsv(columnNames, rows) {
    const head = ['id'].concat(columnNames || []).map(csvField).join(',');
    const lines = [head];
    for (const row of rows) {
        lines.push(row.map(csvField).join(','));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
}

module.exports = {
    parse,
    build,
    readEntriesJson,
    mergeTranslations,
    toTextReport,
    toJson,
    toCsv,
    toComparisonCsv
};
