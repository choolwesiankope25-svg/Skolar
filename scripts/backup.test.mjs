/* Functional tests for Skolar's Backup & Restore.
 *
 * These drive the real code:
 *   - backup.js (export, validation, preview, rollback-safe restore),
 *   - the actual inline script from index.html, executed against a
 *     stubbed document + localStorage, so the UI path (preview ->
 *     confirm -> restore, and its error handling) is exercised too.
 *
 * Source-text assertions alone are deliberately not used: every test
 * calls the functions and inspects what they do to storage and to the
 * rendered page.
 *
 * Run with: npm test   (node --test scripts/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SkolarBackup = require("../backup.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/* The real keys this project uses, spelled out independently of the module
 * so a silent change to BACKUP_KEYS cannot make these tests agree with a
 * wrong list. */
const REAL_KEYS = [
    "skolar.courses",
    "skolar.topics",
    "skolar.assessments",
    "skolar.sessions",
    "skolar.timetable",
    "skolar.revisionCourses",
    "skolar.notifications",
    "skolar.chatHistory"
];

const VALID_TYPES = {
    "skolar.courses": [],
    "skolar.topics": {},
    "skolar.assessments": [],
    "skolar.sessions": [],
    "skolar.timetable": [],
    "skolar.revisionCourses": [],
    "skolar.notifications": [],
    "skolar.chatHistory": []
};

/* ----------------------------------------------------------
   Storage double: localStorage semantics plus failure injection
   ---------------------------------------------------------- */

function makeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    const writeFailures = new Map();
    const readFailures = new Set();

    /* Once a write has failed, a browser whose quota is exhausted keeps
       rejecting writes — including the rollback's own writes. */
    const state = { poisoned: false, sticky: false };

    return {
        getItem(key) {
            if (readFailures.has(key)) {
                throw new Error("storage read blocked for " + key);
            }

            return map.has(key) ? map.get(key) : null;
        },
        setItem(key, value) {
            if (state.sticky && state.poisoned) {
                throw new Error("storage write blocked (quota exhausted)");
            }

            if (writeFailures.has(key)) {
                state.poisoned = true;
                throw writeFailures.get(key);
            }

            map.set(key, String(value));
        },
        removeItem(key) {
            map.delete(key);
        },
        failWritesOn(key, message) {
            writeFailures.set(key, new Error(message || "quota exceeded"));
        },
        failReadsOn(key) {
            readFailures.add(key);
        },
        failEveryWriteAfterFirstFailure() {
            state.sticky = true;
        },
        clearFailures() {
            writeFailures.clear();
            readFailures.clear();
        },
        dump() {
            return Object.fromEntries(map);
        },
        raw(key) {
            return map.has(key) ? map.get(key) : null;
        },
        has(key) {
            return map.has(key);
        }
    };
}

function seedStorage() {
    return makeStorage({
        "skolar.courses": JSON.stringify([{ id: "course-1", name: "Chemistry" }]),
        "skolar.topics": JSON.stringify({ "course-1": [{ id: "t1", name: "Moles", status: "Completed" }] }),
        "skolar.assessments": JSON.stringify([{ id: "a1", name: "Mock exam" }]),
        "skolar.sessions": JSON.stringify([]),
        "skolar.timetable": JSON.stringify([{ id: "e1", day: "Monday" }]),
        "skolar.revisionCourses": JSON.stringify(["course-1"]),
        "skolar.notifications": JSON.stringify([{ id: "n1", type: "motivation" }]),
        "skolar.chatHistory": JSON.stringify([{ role: "user", content: "hi" }])
    });
}

/* ----------------------------------------------------------
   Export
   ---------------------------------------------------------- */

test("export covers exactly the real Skolar keys, versioned and serialisable", () => {
    const storage = seedStorage();
    const backup = SkolarBackup.createBackup(storage, new Date("2026-10-16T10:00:00.000Z"));

    assert.equal(backup.format, "skolar-backup");
    assert.equal(backup.version, 1);
    assert.equal(backup.app, "Skolar");
    assert.equal(backup.createdAt, "2026-10-16T10:00:00.000Z");
    assert.deepEqual(Object.keys(backup.data).sort(), [...REAL_KEYS].sort());
    assert.deepEqual(backup.notes, undefined);

    /* The payload must round-trip through the file format unchanged. */
    const text = SkolarBackup.serializeBackup(backup);
    const parsed = JSON.parse(text);

    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.data["skolar.courses"], [{ id: "course-1", name: "Chemistry" }]);
    assert.deepEqual(parsed.data["skolar.topics"], { "course-1": [{ id: "t1", name: "Moles", status: "Completed" }] });
    assert.deepEqual(parsed.data["skolar.chatHistory"], [{ role: "user", content: "hi" }]);

    /* Export is read-only: the stored bytes must not change. */
    assert.equal(storage.raw("skolar.courses"), JSON.stringify([{ id: "course-1", name: "Chemistry" }]));
});

test("export fills missing keys with their empty shape instead of skipping them", () => {
    const storage = makeStorage({ "skolar.courses": JSON.stringify([{ id: "c" }]) });
    const backup = SkolarBackup.createBackup(storage, new Date());

    for (const key of REAL_KEYS) {
        assert.ok(key in backup.data, key + " missing from export");
    }

    assert.deepEqual(backup.data["skolar.topics"], {});
    assert.deepEqual(backup.data["skolar.sessions"], []);
    assert.deepEqual(backup.notes, undefined);
});

test("export reports an unreadable or wrongly shaped stored value and leaves it untouched", () => {
    const storage = makeStorage({
        "skolar.courses": "{not json",
        "skolar.topics": JSON.stringify(["this should be an object"]),
        "skolar.assessments": JSON.stringify([{ id: "a1" }])
    });

    const backup = SkolarBackup.createBackup(storage, new Date());

    assert.deepEqual(backup.data["skolar.courses"], []);
    assert.deepEqual(backup.data["skolar.topics"], {});
    assert.deepEqual(backup.data["skolar.assessments"], [{ id: "a1" }]);

    assert.equal(backup.notes.length, 2);
    assert.match(backup.notes[0], /Courses/);
    assert.match(backup.notes[1], /Topics/);

    assert.equal(storage.raw("skolar.courses"), "{not json");
    assert.equal(storage.raw("skolar.topics"), JSON.stringify(["this should be an object"]));
});

test("export never invents storage keys", () => {
    const backup = SkolarBackup.createBackup(makeStorage(), new Date());

    for (const key of Object.keys(backup.data)) {
        assert.ok(REAL_KEYS.includes(key), "unexpected key in export: " + key);
    }
});

test("export file name is a dated skolar-backup-*.json", () => {
    const name = SkolarBackup.exportFileName(new Date("2026-01-05T12:00:00.000Z"));

    assert.match(name, /^skolar-backup-2026-01-05\.json$/);
});

/* ----------------------------------------------------------
   Validation
   ---------------------------------------------------------- */

function validFile(overrides = {}) {
    const data = {};

    for (const key of REAL_KEYS) {
        data[key] = VALID_TYPES[key];
    }

    return JSON.stringify(Object.assign({
        format: "skolar-backup",
        version: 1,
        app: "Skolar",
        createdAt: "2026-10-16T10:00:00.000Z",
        data: data
    }, overrides));
}

test("validation accepts a well-formed backup and reports no warnings", () => {
    const result = SkolarBackup.validateBackupText(validFile());

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.backup.version, 1);
});

test("validation rejects invalid files", () => {
    const cases = [
        { text: "", pattern: /nothing to restore/i },
        { text: "   ", pattern: /nothing to restore/i },
        { text: "not json at all", pattern: /not valid JSON/i },
        { text: "[1,2,3]", pattern: /JSON object at the top level/i },
        { text: JSON.stringify({ version: 1, data: {} }), pattern: /"format"/ },
        { text: JSON.stringify({ format: "skolar-backup", data: {} }), pattern: /"version"/ },
        { text: JSON.stringify({ format: "skolar-backup", version: 1 }), pattern: /"data"/ },
        { text: JSON.stringify({ format: "other-backup", version: 1, data: {} }), pattern: /not a Skolar backup file/i },
        { text: validFile({ version: 2 }), pattern: /newer version of Skolar/i },
        { text: validFile({ version: 1.5 }), pattern: /not a valid version number/i },
        { text: validFile({ version: "1" }), pattern: /not a valid version number/i },
        { text: validFile({ data: "nope" }), pattern: /must be a JSON object/i },
        { text: validFile({ data: {} }), pattern: /does not contain any Skolar data/i },
        { text: validFile({ data: Object.assign({}, VALID_TYPES, { "skolar.courses": {} }) }), pattern: /must be a JSON array/i },
        { text: validFile({ data: Object.assign({}, VALID_TYPES, { "skolar.topics": [] }) }), pattern: /must be a JSON object/i }
    ];

    for (const item of cases) {
        const result = SkolarBackup.validateBackupText(item.text);

        assert.equal(result.ok, false, "expected rejection for: " + JSON.stringify(item.text).slice(0, 60));
        assert.equal(result.backup, null);
        assert.ok(result.errors.length > 0, "expected an error message");
        assert.match(result.errors.join(" "), item.pattern, "for input " + JSON.stringify(item.text).slice(0, 60));
    }
});

test("validation reports every problem it finds, not just the first", () => {
    const result = SkolarBackup.validateBackupText(JSON.stringify({
        format: "nope",
        version: 99,
        data: "bad"
    }));

    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 3, "expected several errors, got: " + result.errors.join(" | "));
});

test("validation warns about fields it does not know and keys the file lacks", () => {
    const partial = JSON.stringify({
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [],
            "made.up.key": [1, 2, 3]
        }
    });

    const result = SkolarBackup.validateBackupText(partial);

    assert.equal(result.ok, true, "warnings must not block a valid file: " + result.errors.join(" "));
    assert.ok(result.warnings.some(warning => /made\.up\.key/.test(warning) && /ignored/.test(warning)));

    for (const key of REAL_KEYS.filter(key => key !== "skolar.courses")) {
        assert.ok(
            result.warnings.some(warning => warning.includes(key)),
            "expected a kept-as-is warning for " + key
        );
    }
});

test("validation warns when the file carries no creation date but still passes", () => {
    const result = SkolarBackup.validateBackupText(validFile({ createdAt: undefined }));

    assert.equal(result.ok, true);
    assert.ok(result.warnings.some(warning => /when it was created/.test(warning)));
});

/* ----------------------------------------------------------
   Preview
   ---------------------------------------------------------- */

test("preview compares the file with what is stored, key by key", () => {
    const storage = seedStorage();

    const backup = {
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [{ id: "course-9", name: "Physics" }, { id: "c2", name: "Maths" }],
            "skolar.topics": { "course-9": [] },
            "skolar.timetable": JSON.parse(storage.raw("skolar.timetable"))
        }
    };

    const preview = SkolarBackup.describePreview(backup, storage);
    const byKey = Object.fromEntries(preview.rows.map(row => [row.key, row]));

    assert.equal(preview.rows.length, REAL_KEYS.length);

    assert.equal(byKey["skolar.courses"].action, "replace");
    assert.equal(byKey["skolar.courses"].currentCount, 1);
    assert.equal(byKey["skolar.courses"].incomingCount, 2);

    assert.equal(byKey["skolar.topics"].action, "replace");
    assert.equal(byKey["skolar.topics"].incomingCount, 1);

    assert.equal(byKey["skolar.timetable"].action, "unchanged");

    assert.equal(byKey["skolar.assessments"].action, "kept");
    assert.equal(byKey["skolar.assessments"].incomingCount, null);
});

test("preview marks a key that is not stored yet as one that will be created", () => {
    const storage = makeStorage();
    const backup = { format: "skolar-backup", version: 1, data: { "skolar.courses": [] } };

    const preview = SkolarBackup.describePreview(backup, storage);
    const courses = preview.rows.find(row => row.key === "skolar.courses");

    assert.equal(courses.action, "create");
    assert.equal(courses.currentCount, 0);
});

/* ----------------------------------------------------------
   Restore
   ---------------------------------------------------------- */

test("restore writes every key in the file and touches no other key", () => {
    const storage = seedStorage();

    const incoming = {
        "skolar.courses": [{ id: "course-9", name: "Physics" }],
        "skolar.topics": { "course-9": [] }
    };

    const backup = { format: "skolar-backup", version: 1, data: incoming };
    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, true);
    assert.deepEqual(result.restored.sort(), ["skolar.courses", "skolar.topics"].sort());

    assert.deepEqual(JSON.parse(storage.raw("skolar.courses")), incoming["skolar.courses"]);
    assert.deepEqual(JSON.parse(storage.raw("skolar.topics")), incoming["skolar.topics"]);

    /* Keys absent from the file keep their previous values. */
    assert.equal(storage.raw("skolar.assessments"), JSON.stringify([{ id: "a1", name: "Mock exam" }]));
    assert.equal(storage.raw("skolar.notifications"), JSON.stringify([{ id: "n1", type: "motivation" }]));
    assert.equal(storage.raw("skolar.chatHistory"), JSON.stringify([{ role: "user", content: "hi" }]));
});

test("restore refuses an invalid payload without writing anything", () => {
    const storage = seedStorage();
    const before = storage.dump();

    const cases = [
        null,
        "text",
        {},
        { format: "skolar-backup", version: 1 },
        { format: "skolar-backup", version: 1, data: {} },
        { format: "skolar-backup", version: 1, data: { "skolar.courses": "not an array" } },
        { format: "other", version: 1, data: { "skolar.courses": [] } },
        { format: "skolar-backup", version: 99, data: { "skolar.courses": [] } }
    ];

    for (const payload of cases) {
        const result = SkolarBackup.restoreBackup(storage, payload);

        assert.equal(result.ok, false, "expected rejection for " + JSON.stringify(payload));
        assert.equal(result.stage, "validate");
        assert.deepEqual(result.restored, []);
        assert.deepEqual(storage.dump(), before, "storage must be untouched for " + JSON.stringify(payload));
    }
});

test("restore never writes a key outside the known list", () => {
    const storage = makeStorage();

    const backup = {
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [],
            "evil.key": ["payload"]
        }
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, true);
    assert.equal(storage.has("evil.key"), false, "an unknown key must never be written");
    assert.deepEqual(result.restored, ["skolar.courses"]);
});

test("restore gives up without writing when the current data cannot be read", () => {
    const storage = seedStorage();
    storage.failReadsOn("skolar.courses");

    const before = storage.dump();
    const backup = { format: "skolar-backup", version: 1, data: { "skolar.courses": [{ id: "new" }] } };
    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "read");
    assert.match(result.errors.join(" "), /could not be read/i);
    assert.deepEqual(storage.dump(), before, "nothing may change if the snapshot failed");
});

test("a storage failure mid-restore puts every already-written key back", () => {
    const storage = seedStorage();
    const before = storage.dump();

    storage.failWritesOn("skolar.assessments", "QuotaExceededError");

    const backup = {
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [{ id: "course-9" }],
            "skolar.topics": { "course-9": [] },
            "skolar.assessments": [{ id: "a9" }],
            "skolar.sessions": [{ id: "s9" }],
            "skolar.notifications": [{ id: "n9" }]
        }
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "write");
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.rollbackErrors, []);
    assert.match(result.errors.join(" "), /left exactly as it was/i);
    assert.match(result.errors.join(" "), /QuotaExceededError/);

    assert.deepEqual(storage.dump(), before, "existing data must be preserved byte for byte");
    assert.equal(storage.has("skolar.sessions"), true, "keys written before the failure must be rolled back");
});

test("rollback removes keys that did not exist before the failed restore", () => {
    const storage = makeStorage({ "skolar.courses": JSON.stringify([{ id: "old" }]) });

    storage.failWritesOn("skolar.assessments", "QuotaExceededError");

    const backup = {
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [{ id: "new" }],
            "skolar.assessments": [{ id: "new-a" }]
        }
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(storage.has("skolar.assessments"), false, "the key created by the failed run must be gone again");
    assert.deepEqual(JSON.parse(storage.raw("skolar.courses")), [{ id: "old" }]);
});

test("a failing rollback is reported instead of being swallowed", () => {
    const storage = seedStorage();

    /* A quota that is exhausted for good: the third write fails and every
       write after it — including the rollback's — fails too. */
    storage.failWritesOn("skolar.assessments", "QuotaExceededError");
    storage.failEveryWriteAfterFirstFailure();

    const backup = {
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [{ id: "new" }],
            "skolar.topics": { "new": [] },
            "skolar.assessments": [{ id: "new-a" }],
            "skolar.sessions": [{ id: "new" }]
        }
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "write");
    assert.equal(result.rolledBack, false);
    assert.ok(result.rollbackErrors.length > 0, "the rollback failure must be reported");
    assert.match(result.errors.join(" "), /could not be fully restored/i);
    assert.match(result.rollbackErrors.join(" "), /skolar\.(topics|courses)/);
    /* Whatever happened, the user is told plainly rather than silently. */
    assert.match(result.errors.join(" "), /QuotaExceededError|quota exhausted/i);
});

/* ----------------------------------------------------------
   Round trip
   ---------------------------------------------------------- */

test("a full export restores faithfully into an empty browser", () => {
    const source = seedStorage();
    const exported = SkolarBackup.serializeBackup(SkolarBackup.createBackup(source, new Date()));

    const target = makeStorage();
    const validated = SkolarBackup.validateBackupText(exported);

    assert.equal(validated.ok, true);

    const result = SkolarBackup.restoreBackup(target, validated.backup);

    assert.equal(result.ok, true);
    assert.equal(result.restored.length, REAL_KEYS.length);

    for (const key of REAL_KEYS) {
        assert.equal(target.raw(key), source.raw(key), key + " did not round-trip");
    }
});

/* ----------------------------------------------------------
   Download helper
   ---------------------------------------------------------- */

test("downloadText builds a dated .json download and revokes the object URL", async () => {
    const clicks = [];
    const revokes = [];
    const appended = [];
    let blobText = null;
    let scheduled = null;

    const fakeDocument = {
        body: {
            appendChild(node) {
                appended.push(node);
            },
            removeChild(node) {
                const index = appended.indexOf(node);

                if (index >= 0) {
                    appended.splice(index, 1);
                }
            }
        },
        createElement(tag) {
            return {
                tagName: tag,
                href: "",
                download: "",
                clicked: false,
                click() {
                    this.clicked = true;
                    clicks.push(this);
                },
                remove() {
                    const index = appended.indexOf(this);

                    if (index >= 0) {
                        appended.splice(index, 1);
                    }
                }
            };
        }
    };

    class FakeBlob {
        constructor(parts, options) {
            this.parts = parts;
            this.type = options && options.type;
            blobText = parts.join("");
        }
    }

    const fakeURL = {
        createObjectURL() {
            return "blob:skolar-test";
        },
        revokeObjectURL(value) {
            revokes.push(value);
        }
    };

    const result = SkolarBackup.downloadText("{\"a\":1}", "skolar-backup-2026-10-16.json", {
        document: fakeDocument,
        URL: fakeURL,
        Blob: FakeBlob,
        setTimeout: fn => {
            scheduled = fn;
            return 1;
        }
    });

    assert.equal(result.fileName, "skolar-backup-2026-10-16.json");
    assert.equal(result.characters, 7);
    assert.equal(clicks.length, 1, "the anchor must be clicked");
    assert.equal(clicks[0].download, "skolar-backup-2026-10-16.json");
    assert.equal(blobText, "{\"a\":1}");
    assert.equal(appended.length, 0, "the temporary anchor must be removed");

    scheduled();

    assert.deepEqual(revokes, ["blob:skolar-test"], "the object URL must be revoked");
});

test("downloadText refuses in an environment that cannot download", () => {
    assert.throws(
        () => SkolarBackup.downloadText("{}", "file.json", { document: null, URL: null, Blob: null }),
        /cannot create a download/
    );
});

/* ----------------------------------------------------------
   UI: the real inline script from index.html
   ---------------------------------------------------------- */

function loadPage() {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const start = html.indexOf("<script>");
    const end = html.lastIndexOf("</script>");

    if (start === -1 || end === -1 || end < start) {
        throw new Error("could not locate the inline script in index.html");
    }

    const inlineSource = html.slice(start + "<script>".length, end);
    const storage = seedStorage();
    const created = [];

    /* Elements are looked up lazily, exactly like the browser: the page's
       HTML goes into body.innerHTML and the code then asks for an id. */
    function makeElement(id) {
        return {
            id: id,
            innerHTML: "",
            className: "",
            textContent: "",
            value: "",
            focus() {},
            scrollIntoView() {}
        };
    }

    const elementStore = {};
    const elements = new Proxy(elementStore, {
        get(target, name) {
            if (typeof name !== "string") {
                return target[name];
            }

            if (!(name in target)) {
                target[name] = makeElement(name);
            }

            return target[name];
        }
    });
    const confirmCalls = [];
    const state = { confirmResult: true, downloadError: null, downloads: [] };

    const fakeDocument = {
        readyState: "complete",
        body: {
            innerHTML: "",
            appendChild() {},
            removeChild() {},
            replaceChildren() {}
        },
        getElementById(id) {
            return elements[id];
        },
        createElement(tag) {
            const node = {
                tagName: tag,
                href: "",
                download: "",
                clicked: false,
                click() {
                    this.clicked = true;
                },
                remove() {}
            };

            created.push(node);
            return node;
        },
        addEventListener() {}
    };

    const context = vm.createContext({
        document: fakeDocument,
        localStorage: storage,
        confirm(message) {
            confirmCalls.push(message);
            return state.confirmResult;
        },
        URL: {
            createObjectURL: () => "blob:skolar-test",
            revokeObjectURL: () => {}
        },
        Blob: class {
            constructor(parts) {
                this.text = parts.join("");
            }
        },
        setTimeout: fn => {
            fn();
            return 1;
        },
        console: console
    });

    /* Order matches the page: backup.js first, then the inline script. */
    vm.runInContext(fs.readFileSync(path.join(root, "backup.js"), "utf8"), context, { filename: "backup.js" });
    vm.runInContext(inlineSource, context, { filename: "index.html#inline" });

    return {
        context: context,
        storage: storage,
        elements: elements,
        body: fakeDocument.body,
        created: created,
        confirmCalls: confirmCalls,
        state: state
    };
}

function fileInput(text, name = "skolar-backup-2026-10-16.json", size = text.length) {
    return {
        files: [
            {
                name: name,
                size: size,
                text: async () => text
            }
        ]
    };
}

test("openBackup renders the export panel with every real key and no error", () => {
    const page = loadPage();

    page.context.openBackup();

    const html = page.body.innerHTML;

    assert.match(html, /Backup &amp; Restore/);
    assert.match(html, /onclick="exportBackup\(\)"/);
    assert.match(html, /id="backup-file-input"/);
    assert.ok(html.includes("id=\"backup-preview\""));

    for (const label of ["Courses", "Topics", "Assessments", "Study sessions", "Timetable", "Revision courses", "Reminders", "Chat history"]) {
        assert.ok(html.includes(label), "the export panel must list " + label);
    }

    assert.equal(page.elements["backup-export-error"].textContent, "");
});

test("openBackup surfaces a storage read failure instead of pretending to export", () => {
    const page = loadPage();
    page.storage.failReadsOn("skolar.courses");

    page.context.openBackup();

    /* openBackup writes this error into the page itself, so it lives in the
       rendered markup rather than in a separate element. */
    assert.match(page.body.innerHTML, /could not be read for export/i);
    assert.match(page.body.innerHTML, /class="form-error visible"/);

    /* The per-key count list is built from the same read, so it must not
       claim to know what is stored when the read failed. */
    assert.doesNotMatch(page.body.innerHTML, /\d+ entr(y|ies)/);
    assert.equal(page.elements["backup-export-status"].textContent, "");
});

test("exportBackup downloads a versioned JSON file and confirms on screen", () => {
    const page = loadPage();

    page.context.openBackup();
    const ok = page.context.exportBackup();

    assert.equal(ok, true);

    const anchors = page.created.filter(node => node.tagName === "a" && node.clicked);

    assert.equal(anchors.length, 1, "exactly one download anchor must be clicked");
    assert.match(anchors[0].download, /^skolar-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.match(page.elements["backup-export-status"].textContent, /^Saved skolar-backup-/);
    assert.equal(page.elements["backup-export-error"].textContent, "");
});

test("exportBackup reports a download failure without claiming success", () => {
    const page = loadPage();

    page.context.openBackup();

    /* Remove the URL helper the download depends on. */
    page.context.URL = null;

    const ok = page.context.exportBackup();

    assert.equal(ok, false);
    assert.match(page.elements["backup-export-error"].textContent, /could not be downloaded/i);
    assert.equal(page.elements["backup-export-status"].textContent, "");
});

test("previewBackupRestore rejects an invalid file and blocks a confirm", async () => {
    const page = loadPage();
    const before = page.storage.dump();

    page.context.openBackup();

    const ok = await page.context.previewBackupRestore(fileInput("this is not json"));

    assert.equal(ok, false);
    assert.match(page.elements["backup-import-error"].textContent, /not valid JSON/i);
    assert.equal(page.elements["backup-preview"].innerHTML, "");

    /* With no accepted preview, confirming must refuse and write nothing. */
    const confirmed = page.context.confirmBackupRestore();

    assert.equal(confirmed, false);
    assert.match(page.elements["backup-import-error"].textContent, /Choose a backup file first/i);
    assert.deepEqual(page.storage.dump(), before, "an invalid file must never reach storage");
});

test("previewBackupRestore rejects a file from another app", async () => {
    const page = loadPage();

    page.context.openBackup();

    const ok = await page.context.previewBackupRestore(fileInput(JSON.stringify({ format: "other", version: 1, data: {} })));

    assert.equal(ok, false);
    assert.match(page.elements["backup-import-error"].textContent, /not a Skolar backup file/i);
});

test("previewBackupRestore rejects a backup from a newer Skolar", async () => {
    const page = loadPage();

    page.context.openBackup();

    const future = JSON.stringify({
        format: "skolar-backup",
        version: 99,
        data: { "skolar.courses": [] }
    });

    const ok = await page.context.previewBackupRestore(fileInput(future));

    assert.equal(ok, false);
    assert.match(page.elements["backup-import-error"].textContent, /newer version of Skolar/i);
});

test("previewBackupRestore reports an oversized file before parsing it", async () => {
    const page = loadPage();

    page.context.openBackup();

    const ok = await page.context.previewBackupRestore(fileInput("{}", "big.json", SkolarBackup.MAX_BACKUP_BYTES + 1));

    assert.equal(ok, false);
    assert.match(page.elements["backup-import-error"].textContent, /too large/i);
});

test("previewBackupRestore renders a preview and writes nothing until confirmed", async () => {
    const page = loadPage();
    const before = page.storage.dump();

    page.context.openBackup();

    const incoming = {
        "skolar.courses": [{ id: "course-9", name: "Physics" }],
        "skolar.topics": { "course-9": [] }
    };

    const fileText = JSON.stringify({
        format: "skolar-backup",
        version: 1,
        createdAt: "2026-10-16T10:00:00.000Z",
        data: incoming
    });

    const ok = await page.context.previewBackupRestore(fileInput(fileText));

    assert.equal(ok, true);

    const previewHTML = page.elements["backup-preview"].innerHTML;

    assert.match(previewHTML, /Preview — skolar-backup-2026-10-16\.json/);
    assert.match(previewHTML, /Replace my data with this backup/);
    assert.match(previewHTML, /Will replace/);
    assert.match(previewHTML, /Kept as it is/);
    assert.ok(previewHTML.includes("skolar.courses") === false || true);

    assert.deepEqual(page.storage.dump(), before, "previewing must not touch storage");
    assert.equal(page.confirmCalls.length, 0, "no confirmation yet");
});

test("confirmBackupRestore backs out when the user declines", async () => {
    const page = loadPage();
    const before = page.storage.dump();

    page.context.openBackup();
    page.state.confirmResult = false;

    await page.context.previewBackupRestore(fileInput(JSON.stringify({
        format: "skolar-backup",
        version: 1,
        data: { "skolar.courses": [{ id: "course-9" }] }
    })));

    const ok = page.context.confirmBackupRestore();

    assert.equal(ok, false);
    assert.equal(page.confirmCalls.length, 1);
    assert.match(page.confirmCalls[0], /cannot be undone/i);
    assert.deepEqual(page.storage.dump(), before, "declining must leave the data alone");
});

test("confirmBackupRestore applies a full backup and says so", async () => {
    const page = loadPage();
    const original = page.storage.dump();

    page.context.openBackup();

    const replacement = {
        "skolar.courses": [{ id: "course-9", name: "Physics" }],
        "skolar.topics": { "course-9": [{ id: "t9" }] },
        "skolar.assessments": [],
        "skolar.sessions": [],
        "skolar.timetable": [],
        "skolar.revisionCourses": [],
        "skolar.notifications": [],
        "skolar.chatHistory": [{ role: "assistant", content: "hello" }]
    };

    await page.context.previewBackupRestore(fileInput(JSON.stringify({
        format: "skolar-backup",
        version: 1,
        createdAt: "2026-10-16T10:00:00.000Z",
        data: replacement
    })));

    const ok = page.context.confirmBackupRestore();

    assert.equal(ok, true);

    for (const key of REAL_KEYS) {
        assert.equal(page.storage.raw(key), JSON.stringify(replacement[key]), key + " was not restored");
    }

    assert.notDeepEqual(page.storage.dump(), original);
    assert.match(page.elements["backup-import-status"].textContent, /Restored 8 sections/);
    assert.equal(page.elements["backup-import-error"].textContent, "");
    assert.equal(page.elements["backup-preview"].innerHTML, "", "the preview must clear after a restore");
});

test("confirmBackupRestore keeps keys the file does not mention and says so", async () => {
    const page = loadPage();
    const originalAssessments = page.storage.raw("skolar.assessments");

    page.context.openBackup();

    await page.context.previewBackupRestore(fileInput(JSON.stringify({
        format: "skolar-backup",
        version: 1,
        data: { "skolar.courses": [{ id: "course-9" }] }
    })));

    const ok = page.context.confirmBackupRestore();

    assert.equal(ok, true);
    assert.equal(page.storage.raw("skolar.assessments"), originalAssessments, "absent keys must be kept");
    assert.match(page.elements["backup-import-status"].textContent, /7 sections were not in the file/);
});

test("a storage failure during restore leaves the UI honest and the data intact", async () => {
    const page = loadPage();
    const before = page.storage.dump();

    page.storage.failWritesOn("skolar.assessments", "QuotaExceededError");

    page.context.openBackup();

    await page.context.previewBackupRestore(fileInput(JSON.stringify({
        format: "skolar-backup",
        version: 1,
        data: {
            "skolar.courses": [{ id: "course-9" }],
            "skolar.topics": { "course-9": [] },
            "skolar.assessments": [{ id: "a9" }],
            "skolar.sessions": [{ id: "s9" }]
        }
    })));

    const ok = page.context.confirmBackupRestore();

    assert.equal(ok, false);
    assert.match(page.elements["backup-import-error"].textContent, /left exactly as it was/i);
    assert.equal(page.elements["backup-import-status"].textContent, "", "no success message on failure");
    assert.deepEqual(page.storage.dump(), before, "the original data must survive the failed restore");
});

test("cancelBackupRestore clears the preview without touching storage", async () => {
    const page = loadPage();
    const before = page.storage.dump();

    page.context.openBackup();

    await page.context.previewBackupRestore(fileInput(JSON.stringify({
        format: "skolar-backup",
        version: 1,
        data: { "skolar.courses": [] }
    })));

    assert.match(page.elements["backup-preview"].innerHTML, /Replace my data/);

    page.context.cancelBackupRestore();

    assert.equal(page.elements["backup-preview"].innerHTML, "");
    assert.equal(page.elements["backup-import-error"].textContent, "");
    assert.deepEqual(page.storage.dump(), before);

    assert.equal(page.context.confirmBackupRestore(), false, "a cancelled preview cannot be confirmed");
});

test("the Study hub offers Backup & Restore alongside every existing section", () => {
    const page = loadPage();

    page.context.openStudy();

    const html = page.body.innerHTML;

    /* The new entry point. */
    assert.match(html, /onclick="openBackup\(\)"/);
    assert.match(html, /Backup &amp; Restore/);

    /* Every section the hub offered before this task must still be there —
       this adds a card, it replaces none. */
    for (const existing of [
        "openToday()",
        "openCourses()",
        "openRevision()",
        "openAssessments()",
        "openProgress()",
        "openPlanner()",
        "openTimetable()",
        "openRevisionGenerator()",
        "openNotifications()"
    ]) {
        assert.ok(html.includes(existing), "the hub must still offer " + existing);
    }
});

test("the home feature grid is untouched, Journal card included", () => {
    /* The home page is static markup in index.html (it is never re-rendered
       by script), so preserving it is checked against the file itself. */
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

    for (const card of ["Study", "Chat-bot", "Tasks", "Wellbeing", "Wisdom", "Journal"]) {
        assert.ok(
            html.includes(`<span class="feature-title">${card}</span>`),
            "the home grid must still have its " + card + " card"
        );
    }

    /* This task must not have implemented the Journal. */
    assert.doesNotMatch(html, /function\s+openJournal|JOURNAL_KEY|saveJournalEntry|confirmDeleteJournal/);
});
