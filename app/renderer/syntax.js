/**
 * Minimal dependency-free syntax highlighter + message renderer.
 *
 * Built in-house rather than pulling in highlight.js/Prism because the renderer
 * CSP is `default-src 'none'` — no CDN, and every byte ships in the installer.
 *
 * Everything is emitted as DOM text nodes inside spans. Model output is never
 * passed through innerHTML, so a code block cannot inject markup.
 */
(function () {
    "use strict";

    const KEYWORDS = {
        js: ["const","let","var","function","return","if","else","for","while","do","break","continue",
             "class","extends","new","this","super","import","export","from","default","async","await",
             "try","catch","finally","throw","typeof","instanceof","delete","in","of","yield","static",
             "get","set","null","undefined","true","false","void","switch","case"],
        ts: ["interface","type","enum","implements","public","private","protected","readonly","as","is",
             "namespace","declare","abstract","override","satisfies"],
        python: ["def","return","if","elif","else","for","while","break","continue","class","import",
                 "from","as","with","try","except","finally","raise","lambda","None","True","False",
                 "and","or","not","in","is","pass","global","nonlocal","assert","yield","async","await","del"],
        css: ["important","media","import","keyframes","supports","font-face","root"],
        bash: ["if","then","else","elif","fi","for","in","do","done","while","case","esac","function",
               "return","export","local","echo","cd","set","source","exit"],
        c: ["int","char","float","double","void","struct","enum","union","typedef","static","const",
            "unsigned","signed","long","short","return","if","else","for","while","switch","case",
            "break","continue","sizeof","include","define","ifndef","endif","pragma"]
    };

    const ALIASES = {
        javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
        typescript: "ts", tsx: "ts",
        py: "python", python3: "python",
        sh: "bash", shell: "bash", zsh: "bash", console: "bash", powershell: "bash", ps1: "bash",
        yml: "yaml",
        "c++": "c", cpp: "c", cxx: "c", h: "c", hpp: "c", cs: "c", java: "c", go: "c", rust: "c", rs: "c"
    };

    function keywordsFor(lang) {
        if (lang === "ts") return KEYWORDS.js.concat(KEYWORDS.ts);
        return KEYWORDS[lang] || KEYWORDS.js;
    }

    /** Ordered rules — first match wins, so comments/strings beat everything. */
    function rulesFor(lang) {
        const common = [];

        if (lang === "python") {
            common.push({ t: "str", re: /^("""[\s\S]*?"""|'''[\s\S]*?''')/ });
            common.push({ t: "com", re: /^#[^\n]*/ });
        } else if (lang === "bash") {
            common.push({ t: "com", re: /^#[^\n]*/ });
        } else if (lang === "css") {
            common.push({ t: "com", re: /^\/\*[\s\S]*?\*\// });
        } else if (lang === "html" || lang === "xml") {
            common.push({ t: "com", re: /^<!--[\s\S]*?-->/ });
            common.push({ t: "tag", re: /^<\/?[A-Za-z][\w:-]*/ });
            common.push({ t: "attr", re: /^[A-Za-z-][\w:-]*(?==)/ });
        } else if (lang !== "json") {
            common.push({ t: "com", re: /^\/\/[^\n]*/ });
            common.push({ t: "com", re: /^\/\*[\s\S]*?\*\// });
        }

        common.push({ t: "str", re: /^"(?:[^"\\\n]|\\.)*"?/ });
        common.push({ t: "str", re: /^'(?:[^'\\\n]|\\.)*'?/ });
        if (lang === "js" || lang === "ts") {
            common.push({ t: "str", re: /^`(?:[^`\\]|\\.)*`?/ });
        }
        common.push({ t: "num", re: /^0[xX][0-9a-fA-F]+|^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ });

        if (lang === "json") {
            common.push({ t: "key", re: /^"(?:[^"\\]|\\.)*"(?=\s*:)/ });
            common.push({ t: "kw", re: /^\b(?:true|false|null)\b/ });
        }
        if (lang === "css") {
            common.push({ t: "prop", re: /^[-a-zA-Z]+(?=\s*:)/ });
            common.push({ t: "kw", re: /^[.#][\w-]+/ });
        }
        if (lang === "bash") {
            common.push({ t: "var", re: /^\$\{?[\w]+\}?/ });
            common.push({ t: "flag", re: /^(?:^|\s)--?[\w-]+/ });
        }

        common.push({ t: "fn", re: /^[A-Za-z_$][\w$]*(?=\s*\()/ });
        common.push({ t: "word", re: /^[A-Za-z_$@][\w$-]*/ });
        common.push({ t: "op", re: /^[+\-*/%=<>!&|^~?:.,;(){}\[\]]/ });
        common.push({ t: "ws", re: /^\s+/ });
        return common;
    }

    /** Tokenize and append highlighted spans into `code`. */
    function highlightInto(code, source, langRaw) {
        const lang = ALIASES[String(langRaw || "").toLowerCase()]
            || String(langRaw || "").toLowerCase()
            || "js";
        const rules = rulesFor(lang);
        const keywords = keywordsFor(lang);

        // A MISSING BODY IS AN EMPTY BODY, NOT A CRASH. Caught driving the
        // real renderer: a viewFile result with no `content` field reached
        // here and `source.length` threw inside an async handler, so the
        // preview pane was left half-built with the failure only in the
        // console. A highlighter cannot be the thing that breaks a file
        // preview.
        let rest = typeof source === "string" ? source : String(source == null ? "" : source);
        let guard = 0;

        while (rest.length && guard++ < 200000) {
            let matched = false;

            for (const rule of rules) {
                const m = rule.re.exec(rest);
                if (!m || !m[0].length) continue;

                let cls = rule.t;
                let text = m[0];

                if (cls === "word") {
                    cls = keywords.includes(text) ? "kw" :
                          /^[A-Z]/.test(text) ? "type" : null;
                }
                if (cls === "ws" || cls === null) {
                    code.appendChild(document.createTextNode(text));
                } else {
                    const span = document.createElement("span");
                    span.className = "tok-" + cls;
                    span.appendChild(document.createTextNode(text));
                    code.appendChild(span);
                }

                rest = rest.slice(text.length);
                matched = true;
                break;
            }

            if (!matched) {
                code.appendChild(document.createTextNode(rest[0]));
                rest = rest.slice(1);
            }
        }
    }

    function copyIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "13");
        svg.setAttribute("height", "13");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        const rect = document.createElementNS(svg.namespaceURI, "rect");
        rect.setAttribute("x", "9"); rect.setAttribute("y", "9");
        rect.setAttribute("width", "12"); rect.setAttribute("height", "12");
        rect.setAttribute("rx", "2");
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", "M5 15V5a2 2 0 0 1 2-2h10");
        svg.appendChild(rect); svg.appendChild(path);
        return svg;
    }

    /** Build a <pre> code block with a language badge and a copy button. */
    function codeBlock(source, lang) {
        const wrap = document.createElement("div");
        wrap.className = "code-block";

        const head = document.createElement("div");
        head.className = "code-head";

        const label = document.createElement("span");
        label.className = "code-lang";
        label.innerText = (lang || "code").toLowerCase();
        head.appendChild(label);

        const btn = document.createElement("button");
        btn.className = "code-copy";
        btn.title = "Copy code";
        btn.appendChild(copyIcon());
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(source).then(() => {
                btn.classList.add("copied");
                setTimeout(() => btn.classList.remove("copied"), 1200);
            });
        });
        head.appendChild(btn);
        wrap.appendChild(head);

        const pre = document.createElement("pre");
        const code = document.createElement("code");
        highlightInto(code, source, lang);
        pre.appendChild(code);
        wrap.appendChild(pre);
        return wrap;
    }

    const FENCE_RE = /```([A-Za-z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)```/g;
    /** A clickable link — a URL opens in the browser, a path copies; behaviour
     *  is bound by a delegated handler in app.js, this only builds the node. */
    function mkLink(href, label) {
        const a = document.createElement("a");
        a.className = "md-link";
        a.setAttribute("href", "#");
        a.setAttribute("data-href", href);
        a.title = href;
        a.appendChild(document.createTextNode(label));
        return a;
    }

    /**
     * ONE inline tokenizer, earliest-match-wins, applied recursively so emphasis
     * nests. Order of the rules is the precedence: `code` is protected first (no
     * nested parsing inside it), then links and bare URLs, then bold/italic in
     * either `*` or `_` form. Anything with no rule is a plain text node — so a
     * construct we do not understand renders as its literal text, never as a
     * thrown error, and every construct we DO understand renders as real DOM.
     * Text only ever becomes text nodes; the model's bytes never touch innerHTML.
     */
    const INLINE_RULES = [
        { re: /`([^`\n]+)`/, node: (m) => {
            const c = document.createElement("code"); c.className = "inline-code";
            c.appendChild(document.createTextNode(m[1])); return c; }, raw: true },
        { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/, node: (m) => mkLink(m[2], m[1]) },
        { re: /(https?:\/\/[^\s<>()]+[^\s<>().,!?:;])/, node: (m) => mkLink(m[1], m[1]) },
        { re: /\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/, node: (m) => {
            const b = document.createElement("strong"); appendInline(b, m[1]); return b; } },
        { re: /(^|[\s([])__([^_\s][^_\n]*?)__(?=$|[\s).,!?:;\]])/, group: 2, pre: 1, node: (m) => {
            const b = document.createElement("strong"); appendInline(b, m[2]); return b; } },
        { re: /(^|[\s([])\*([^*\s][^*\n]*?)\*(?=$|[\s).,!?:;\]])/, group: 2, pre: 1, node: (m) => {
            const em = document.createElement("em"); appendInline(em, m[2]); return em; } },
        { re: /(^|[\s([])_([^_\s][^_\n]*?)_(?=$|[\s).,!?:;\]])/, group: 2, pre: 1, node: (m) => {
            const em = document.createElement("em"); appendInline(em, m[2]); return em; } }
    ];

    function appendInline(parent, text) {
        if (!text) return;
        let best = null;
        for (const rule of INLINE_RULES) {
            const m = rule.re.exec(text);
            if (!m) continue;
            // rules with a `pre` group match a leading boundary char that is NOT
            // part of the emphasis — the real token starts after it
            const at = m.index + (rule.pre ? m[rule.pre].length : 0);
            if (!best || at < best.at) best = { m, rule, at };
        }
        if (!best) { parent.appendChild(document.createTextNode(text)); return; }
        const { m, rule, at } = best;
        if (at > 0) parent.appendChild(document.createTextNode(text.slice(0, at)));
        parent.appendChild(rule.node(m));
        appendInline(parent, text.slice(m.index + m[0].length));
    }

    const H_RE = /^(#{1,6})\s+(.+)$/;
    const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
    const TABLE_SEP = /^\s*\|?[\s:|]*-{2,}[\s:|-]*\|?\s*$/;
    const splitRow = (line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
        .split("|").map((c) => c.trim());
    const UL_RE = /^\s{0,3}[-*•]\s+(.+)$/;
    const OL_RE = /^\s{0,3}(\d{1,3})[.)]\s+(.+)$/;
    const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
    const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

    /**
     * Markdown-shaped prose as real structure: headings, lists, quotes, rules,
     * paragraphs. The model writes markdown; showing the user raw ## and ** is
     * what made replies read like machine output. Same discipline as the
     * highlighter — DOM nodes only, model text never touches innerHTML.
     */
    function appendProse(container, text, depth = 0) {
        const lines = text.split("\n");
        let i = 0;
        let para = [];

        const flushPara = () => {
            if (!para.length) return;
            const p = document.createElement("div");
            p.className = "msg-para";
            para.forEach((l, k) => {
                if (k) p.appendChild(document.createElement("br"));
                appendInline(p, l);
            });
            container.appendChild(p);
            para = [];
        };

        while (i < lines.length) {
            const line = lines[i];
            let m;

            if (!line.trim()) { flushPara(); i++; continue; }

            // a GitHub-style table: a | row | followed by a |---| separator. The
            // model emits these constantly (spec tables, comparisons) and they
            // used to render as a wall of literal pipes.
            if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
                flushPara();
                const table = document.createElement("table");
                table.className = "md-table";
                const thead = document.createElement("thead");
                const htr = document.createElement("tr");
                for (const cell of splitRow(line)) {
                    const th = document.createElement("th");
                    appendInline(th, cell);
                    htr.appendChild(th);
                }
                thead.appendChild(htr);
                table.appendChild(thead);
                i += 2;                                  // consume header + separator
                const tbody = document.createElement("tbody");
                while (i < lines.length && TABLE_ROW.test(lines[i]) && !TABLE_SEP.test(lines[i])) {
                    const tr = document.createElement("tr");
                    for (const cell of splitRow(lines[i])) {
                        const td = document.createElement("td");
                        appendInline(td, cell);
                        tr.appendChild(td);
                    }
                    tbody.appendChild(tr);
                    i++;
                }
                table.appendChild(tbody);
                container.appendChild(table);
                continue;
            }

            if ((m = H_RE.exec(line))) {
                flushPara();
                const h = document.createElement("div");
                h.className = "md-h md-h" + m[1].length;
                appendInline(h, m[2].trim());
                container.appendChild(h);
                i++; continue;
            }
            if (HR_RE.test(line)) {
                flushPara();
                const hr = document.createElement("div");
                hr.className = "md-hr";
                container.appendChild(hr);
                i++; continue;
            }
            if (UL_RE.test(line) || OL_RE.test(line)) {
                flushPara();
                const ordered = OL_RE.test(line);
                const list = document.createElement(ordered ? "ol" : "ul");
                list.className = "md-list";
                while (i < lines.length) {
                    const lm = ordered ? OL_RE.exec(lines[i]) : UL_RE.exec(lines[i]);
                    if (!lm) break;
                    const li = document.createElement("li");
                    appendInline(li, ordered ? lm[2] : lm[1]);
                    list.appendChild(li);
                    i++;
                }
                container.appendChild(list);
                continue;
            }
            if (QUOTE_RE.test(line)) {
                flushPara();
                const q = document.createElement("div");
                q.className = "md-quote";
                const inner = [];
                while (i < lines.length && (m = QUOTE_RE.exec(lines[i]))) {
                    inner.push(m[1]);
                    i++;
                }
                // Depth-capped: each '>' level recurses once, and a degenerate
                // reply of thousands of '>' would otherwise blow the stack.
                // Past the cap the text renders flat inside the quote.
                if (depth < 4) appendProse(q, inner.join("\n"), depth + 1);
                else appendInline(q, inner.join(" "));
                container.appendChild(q);
                continue;
            }

            para.push(line);
            i++;
        }
        flushPara();
    }

    /**
     * Render a message body: prose as text, fenced code as highlighted blocks.
     * opts.markdown renders prose structure (assistant replies); without it,
     * prose stays literal line-for-line (user messages are shown as typed).
     * Returns true if any code block was found.
     */
    function renderMessageBody(container, text, opts) {
        try {
            return renderMessageBodyInner(container, text, opts);
        } catch (e) {
            // ONE construct throwing must never dump raw markup on the user.
            // Fall back to a safe render: inline formatting only, then plain text
            // if even that fails. Reliable beats clever.
            try {
                container.innerHTML = "";
                const p = document.createElement("div");
                p.className = "msg-text";
                appendInline(p, String(text == null ? "" : text));
                container.appendChild(p);
            } catch {
                container.textContent = String(text == null ? "" : text);
            }
            return false;
        }
    }
    function renderMessageBodyInner(container, text, opts) {
        const markdown = !!(opts && opts.markdown);
        container.innerHTML = "";
        let last = 0;
        let found = false;
        let m;

        const prose = (chunk) => {
            const p = document.createElement("div");
            p.className = "msg-text";
            if (markdown) appendProse(p, chunk);
            else appendInline(p, chunk);
            container.appendChild(p);
        };

        FENCE_RE.lastIndex = 0;
        while ((m = FENCE_RE.exec(text)) !== null) {
            const before = text.slice(last, m.index);
            if (before.trim()) prose(before.replace(/\s+$/, ""));
            container.appendChild(codeBlock(m[2].replace(/\r?\n$/, ""), m[1]));
            found = true;
            last = m.index + m[0].length;
        }

        const tail = text.slice(last);
        if (tail.trim() || !found) {
            prose(found ? tail.replace(/^\s+/, "") : tail);
        }

        return found;
    }

    window.lclSyntax = { renderMessageBody, codeBlock, highlightInto };
})();
