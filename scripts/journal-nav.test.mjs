/* ============================================================
   Navigation regression tests: home page → Private Journal.

   The home feature grid is static markup, so a card only navigates if its
   onclick attribute names a function the page actually defines. The Journal
   card shipped without one and was therefore dead on the home page while the
   Study hub entry point worked.

   These tests cover the wiring (attribute → defined function) and then mount
   the Journal view through the very handler the card names, so a future edit
   that drops either half fails here instead of silently doing nothing.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SkolarJournal = require("../journal.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

/* The inline page script (the only <script> tag without a src attribute). */
const pageScript = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));

/* ----------------------------------------------------------
   Home feature grid
   ---------------------------------------------------------- */

function featureCards() {
    const open = html.indexOf('<section class="feature-grid">');
    const close = html.indexOf("</section>", open);
    const section = html.slice(open, close);

    return [...section.matchAll(/<button class="feature-card"([^>]*)>([\s\S]*?)<\/button>/g)]
        .map(match => ({
            attributes: match[1],
            title: (match[2].match(/<span class="feature-title">([\s\S]*?)<\/span>/) || [])[1],
            handler: (match[1].match(/onclick="([^"]+)"/) || [])[1] || null
        }));
}

function handlerName(handler) {
    return handler.replace(/\s*\(\s*\)\s*$/, "");
}

/* Every script the page loads, so a handler may live in any of them. */
function pageSources() {
    return [
        pageScript,
        fs.readFileSync(path.join(root, "app.js"), "utf8"),
        fs.readFileSync(path.join(root, "backup.js"), "utf8"),
        fs.readFileSync(path.join(root, "journal.js"), "utf8")
    ];
}

/* ----------------------------------------------------------
   Wiring
   ---------------------------------------------------------- */

test("the home Journal card is wired to openJournal()", () => {
    const journal = featureCards().find(card => card.title === "Journal");

    assert.ok(journal, "the home grid must keep its Journal card");
    assert.equal(
        journal.handler,
        "openJournal()",
        "the Journal card must navigate, like the Study card does"
    );
});

test("the home cards keep their existing navigation", () => {
    const byTitle = new Map(featureCards().map(card => [card.title, card]));

    assert.equal(byTitle.get("Study").handler, "openStudy()");
    assert.equal(byTitle.get("Chat-bot").handler, "openChat()");
});

test("every home card handler names a function the page defines", () => {
    const sources = pageSources();

    for (const card of featureCards()) {
        if (!card.handler) {
            continue;
        }

        const name = handlerName(card.handler);
        const pattern = new RegExp("function\\s+" + name + "\\s*\\(|(const|let|var)\\s+" + name + "\\s*=");

        assert.ok(
            sources.some(source => pattern.test(source)),
            `the ${card.title} card calls ${name}(), which no script defines`
        );
    }
});

test("openJournal is a top-level function in the page script", () => {
    /* Inline onclick handlers resolve against the global scope, so the
       function must sit at the script's top level (one indent step), not
       nested inside another function. */
    assert.match(
        pageScript,
        /^ {8}function openJournal\(\) \{$/m,
        "openJournal must be defined at the top level of the page script"
    );
});

/* ----------------------------------------------------------
   The Study hub entry point still works
   ---------------------------------------------------------- */

test("the Study hub still offers the Private Journal", () => {
    const hubStart = pageScript.indexOf("function openStudy()");
    const hubEnd = pageScript.indexOf("const COURSES_KEY", hubStart);
    const hub = pageScript.slice(hubStart, hubEnd);

    assert.match(hub, /onclick="openJournal\(\)"/);
    assert.match(hub, /Private Journal/);

    /* The hub must still offer every other section it had. */
    for (const existing of [
        "openToday()",
        "openCourses()",
        "openRevision()",
        "openAssessments()",
        "openProgress()",
        "openPlanner()",
        "openTimetable()",
        "openRevisionGenerator()",
        "openNotifications()",
        "openBackup()"
    ]) {
        assert.ok(hub.includes(existing), "the hub must still offer " + existing);
    }
});

/* ----------------------------------------------------------
   Clicking the card mounts the Journal view
   ---------------------------------------------------------- */

function fakePage() {
    /* Start at the comment that opens the journal block and run to the end
       of the page script: the page's journal functions rely on each other. */
    const anchor = pageScript.indexOf("let openJournalMode = null;");

    assert.ok(anchor > 0, "the page script must contain the journal block");

    const journalBlock = pageScript.slice(pageScript.lastIndexOf("/*", anchor));

    const elements = new Map();
    const ids = new Set();

    function element(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                value: "",
                textContent: "",
                className: "",
                innerHTML: "",
                listeners: {},
                focus() {},
                addEventListener(type, handler) {
                    this.listeners[type] = handler;
                }
            });
        }

        return elements.get(id);
    }

    const store = new Map();

    globalThis.localStorage = {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key)
    };

    globalThis.document = {
        body: {
            _html: "",
            set innerHTML(markup) {
                this._html = markup;
                elements.clear();
                ids.clear();

                for (const match of markup.matchAll(/id="([^"]+)"/g)) {
                    ids.add(match[1]);
                }
            },
            get innerHTML() {
                return this._html;
            }
        },
        getElementById: id => (ids.has(id) ? element(id) : null)
    };

    globalThis.SkolarJournal = SkolarJournal;
    globalThis.openStudy = () => {};
    globalThis.confirmJournalDelete = () => true;
    globalThis.escapeHTML = text => String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    const context = new Function(journalBlock + `
        return {
            openJournal: openJournal,
            saveJournalEntry: saveJournalEntry
        };
    `)();

    return { context, elements, store };
}

test("invoking the handler named on the Journal card opens the Journal page", () => {
    const page = fakePage();

    const journal = featureCards().find(card => card.title === "Journal");
    const name = handlerName(journal.handler);

    const handlers = { openJournal: page.context.openJournal };

    assert.equal(typeof handlers[name], "function", `${name}() must be callable`);
    handlers[name]();

    assert.match(globalThis.document.body.innerHTML, /📔 Private Journal/);
    assert.match(globalThis.document.body.innerHTML, /id="journal-title"/);
    assert.match(globalThis.document.body.innerHTML, /stored only on this device/);
});

test("the mounted Journal page keeps the entry list and its empty state", () => {
    const page = fakePage();

    page.context.openJournal();

    const list = globalThis.document.getElementById("journal-entry-list");

    assert.ok(list, "the entry list container must exist");
    assert.match(list.innerHTML, /No entries yet/);
});
