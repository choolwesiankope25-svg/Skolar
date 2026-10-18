/* ============================================================
   Functional tests for Skolar's Private Journal.

   These test the actual journal implementation in journal.js, including
   storage shape, CRUD, rollback on write failure, safe rendering, and the
   privacy boundary that keeps journal content out of chat and backup export.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const SkolarJournal = require("../journal.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const JOURNAL_KEY = "skolar.privateJournal";

/* ----------------------------------------------------------
   Storage double — localStorage-ish, with failure injection
   ---------------------------------------------------------- */

function makeStorage(seed) {
    var store = new Map(Object.entries(seed || {}));

    return {
        getItem: function (key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem: function (key, value) {
            store.set(key, value);
        },
        removeItem: function (key) {
            store.delete(key);
        },
        keys: function () {
            return Array.from(store.keys());
        }
    };
}

/* ----------------------------------------------------------
   Schema tests
   ---------------------------------------------------------- */

test("the journal uses the expected localStorage key", function () {
    assert.equal(SkolarJournal.JOURNAL_KEY, JOURNAL_KEY);
});

test("journal entry shape is stable", function () {
    var createdAt = String(Date.now());
    var updatedAt = String(Date.now());

    var entry = SkolarJournal.normalizeEntry({
        id: "journal-1",
        title: "Chemistry notes",
        body: "Moles are confusing.",
        createdAt: createdAt,
        updatedAt: updatedAt
    });

    assert.equal(entry.id, "journal-1");
    assert.equal(entry.title, "Chemistry notes");
    assert.equal(entry.body, "Moles are confusing.");
    assert.ok(parseInt(entry.createdAt, 10) >= parseInt(createdAt, 10), "createdAt must not move backwards");
    assert.ok(parseInt(entry.updatedAt, 10) >= parseInt(updatedAt, 10), "updatedAt must not move backwards");
});

test("normalization trims and clamps", function () {
    var bodyLong = "";
    for (var i = 0; i < 30000; i++) {
        bodyLong += "x";
    }

    var entry = SkolarJournal.normalizeEntry({
        id: "journal-2",
        title: "   spaced title   ",
        body: bodyLong,
        createdAt: String(Date.now()),
        updatedAt: String(Date.now())
    });

    assert.equal(entry.title, "spaced title");
    assert.ok(entry.body.length <= SkolarJournal.JOURNAL_BODY_MAX);
    assert.ok(entry.body.length === SkolarJournal.JOURNAL_BODY_MAX);
});

test("normalization repairs missing timestamps", function () {
    var entry = SkolarJournal.normalizeEntry({
        id: "journal-3",
        title: "Draft",
        body: "Started today.",
        createdAt: "not-a-date",
        updatedAt: ""
    });

    assert.ok(parseInt(entry.createdAt, 10) > 0);
    assert.ok(parseInt(entry.updatedAt, 10) > 0);
});

test("strictValidateEntry rejects bad shapes", function () {
    assert.ok(SkolarJournal.strictValidateEntry({}).length > 0);
    assert.ok(
        SkolarJournal.strictValidateEntry({
            id: "",
            title: "Hi",
            body: "Body",
            createdAt: String(Date.now()),
            updatedAt: String(Date.now())
        }).length > 0
    );
});

test("strictValidateEntry accepts a well-formed entry", function () {
    var problems = SkolarJournal.strictValidateEntry({
        id: "journal-ok",
        title: "Ok",
        body: "Body",
        createdAt: String(Date.now()),
        updatedAt: String(Date.now())
    });

    assert.equal(problems.length, 0);
});

/* ----------------------------------------------------------
   Storage contract
   ---------------------------------------------------------- */

test("loadEntries returns an empty array for a fresh store", function () {
    assert.deepEqual(SkolarJournal.loadEntries(makeStorage()), []);
});

test("loadEntries parses a stored journal", function () {
    var storage = makeStorage();
    storage.setItem(JOURNAL_KEY, JSON.stringify([
        {
            id: "journal-1",
            title: "First",
            body: "One",
            createdAt: String(Date.now()),
            updatedAt: String(Date.now())
        }
    ]));

    var entries = SkolarJournal.loadEntries(storage);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "journal-1");
});

test("loadEntries ignores non-array junk", function () {
    var storage = makeStorage();
    storage.setItem(JOURNAL_KEY, JSON.stringify({ not: "an array" }));

    assert.deepEqual(SkolarJournal.loadEntries(storage), []);
});

test("loadEntries ignores corrupt JSON", function () {
    var storage = makeStorage();
    storage.setItem(JOURNAL_KEY, "not-json");

    assert.deepEqual(SkolarJournal.loadEntries(storage), []);
});

test("createEntry appends a new entry", function () {
    var storage = makeStorage();
    var result = SkolarJournal.createEntry(storage, "Title", "Body");

    assert.ok(result.ok, JSON.stringify(result.problems));
    assert.ok(result.entry);
    assert.equal(result.affectedEntryId, result.entry.id);

    var stored = SkolarJournal.loadEntries(storage);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, result.entry.id);
    assert.equal(stored[0].title, "Title");
    assert.equal(stored[0].body, "Body");
});

test("save updates an existing entry", function () {
    var storage = makeStorage();
    var created = SkolarJournal.createEntry(storage, "Old", "Body");
    var updated = SkolarJournal.save(storage, {
        id: created.entry.id,
        title: "New",
        body: "Updated body",
        createdAt: created.entry.createdAt,
        updatedAt: String(Date.now())
    });

    assert.ok(updated.ok, JSON.stringify(updated.problems));
    var stored = SkolarJournal.loadEntries(storage);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, "New");
    assert.equal(stored[0].body, "Updated body");
});

test("save appends when the id is new", function () {
    var storage = makeStorage();
    SkolarJournal.createEntry(storage, "Existing", "Body");

    var saved = SkolarJournal.save(storage, {
        id: "brand-new",
        title: "Also new",
        body: "New body",
        createdAt: String(Date.now()),
        updatedAt: String(Date.now())
    });

    assert.ok(saved.ok, JSON.stringify(saved.problems));
    var stored = SkolarJournal.loadEntries(storage);
    assert.equal(stored.length, 2);
});

test("deleteEntry removes the matching entry", function () {
    var storage = makeStorage();
    var keep = SkolarJournal.createEntry(storage, "Keep", "One");
    var remove = SkolarJournal.createEntry(storage, "Remove", "Two");

    var result = SkolarJournal.deleteEntry(storage, remove.entry.id);
    assert.ok(result.ok);
    assert.ok(result.removed);

    var stored = SkolarJournal.loadEntries(storage);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, keep.entry.id);
});

test("deleteEntry fails for a missing id", function () {
    var storage = makeStorage();
    var result = SkolarJournal.deleteEntry(storage, "missing");

    assert.ok(!result.ok);
    assert.ok(!result.removed);
});

test("save fails on invalid entries", function () {
    var storage = makeStorage();
    var result = SkolarJournal.save(storage, {
        id: "",
        title: "Hi",
        body: "Body",
        createdAt: String(Date.now()),
        updatedAt: String(Date.now())
    });

    assert.ok(!result.ok);
    assert.ok(result.problems.length > 0);
});

/* ----------------------------------------------------------
   Rollback on write failure
   ---------------------------------------------------------- */

test("save rolls back when storage write fails", function () {
    var base = makeStorage({
        "skolar.courses": JSON.stringify([{ id: 1 }])
    });

    var first = SkolarJournal.createEntry(base, "First", "One");
    assert.ok(first.ok, JSON.stringify(first.problems));

    /* Every write to the journal key fails, including the rollback write,
       so the original entry must survive untouched. */
    var failingStorage = {
        getItem: function (key) {
            return base.getItem(key);
        },
        setItem: function (key, value) {
            if (key === JOURNAL_KEY) {
                throw new Error("storage full");
            }
            base.setItem(key, value);
        },
        removeItem: function (key) {
            base.removeItem(key);
        },
        keys: function () {
            return base.keys();
        }
    };

    var second = SkolarJournal.save(failingStorage, {
        id: first.entry.id,
        title: "Updated",
        body: "Updated body",
        createdAt: first.entry.createdAt,
        updatedAt: String(Date.now())
    });

    var result = second;
    assert.ok(!result.ok, "a blocked write must be reported as a failure");
    assert.equal(result.problems.length, 1);

    var stored = SkolarJournal.loadEntries(failingStorage);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, "First", "the original entry must not be lost");
    assert.equal(stored[0].body, "One");
});

test("deleteEntry rolls back when storage write fails", function () {
    var blocked = false;

    var storage = makeStorage();
    var created = SkolarJournal.createEntry(storage, "Delete me", "Body");

    var failingStorage = {
        getItem: function (key) {
            return storage.getItem(key);
        },
        setItem: function (key, value) {
            if (key === JOURNAL_KEY) {
                if (blocked) {
                    throw new Error("storage full");
                }
                blocked = true;
                throw new Error("storage full");
            }
            storage.setItem(key, value);
        },
        removeItem: function (key) {
            storage.removeItem(key);
        },
        keys: function () {
            return storage.keys();
        }
    };

    var payload = {
        id: created.entry.id
    };

    var result = SkolarJournal.deleteEntry(failingStorage, payload.id);
    assert.ok(!result.ok);
    assert.ok(!result.removed);

    var stored = SkolarJournal.loadEntries(failingStorage);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, payload.id);
});

/* ----------------------------------------------------------
   Safe rendering
   ---------------------------------------------------------- */

test("entryBodyHTML escapes HTML", function () {
    assert.equal(
        SkolarJournal.entryBodyHTML("<script>alert(1)</script>"),
        "<p class=\"journal-entry-body\">&lt;script&gt;alert(1)&lt;/script&gt;</p>"
    );
});

test("entryTitleHTML escapes HTML", function () {
    assert.equal(
        SkolarJournal.entryTitleHTML("<b>Bold</b>"),
        "<span class=\"journal-entry-title\">&lt;b&gt;Bold&lt;/b&gt;</span>"
    );
});

test("escapeHTML is available and correct", function () {
    assert.equal(SkolarJournal.escapeHTML("a & b < c"), "a &amp; b &lt; c");
});

/* ----------------------------------------------------------
   Privacy: journal never leaks into chat or backup
   ---------------------------------------------------------- */

test("journal content is not present in the public study context keys", function () {
    var storage = makeStorage();
    SkolarJournal.createEntry(storage, "Private", "a secret only I should know");

    var keys = storage.keys();
    assert.ok(keys.indexOf(JOURNAL_KEY) !== -1);

    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === JOURNAL_KEY) {
            continue;
        }

        var raw = storage.getItem(key);
        if (raw) {
            assert.ok(
                raw.indexOf("a secret only I should know") === -1,
                "journal content must not appear under another key: " + key
            );
        }
    }
});

test("a journal entry is backed up alongside the other app data", function () {
    var SkolarBackup = require("../backup.js");

    var journalInBackupKeys = SkolarBackup.BACKUP_KEYS.some(
        function (entry) { return entry.key === JOURNAL_KEY; }
    );

    assert.ok(journalInBackupKeys, "journal must be one of the backup keys");
});

test("journal content is not sent to the AI backend or chat history", function () {
    var storage = makeStorage();
    SkolarJournal.createEntry(storage, "Private", "a secret only I should know");

    var keys = storage.keys();
    assert.ok(keys.indexOf(JOURNAL_KEY) !== -1);

    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === JOURNAL_KEY) {
            continue;
        }

        var raw = storage.getItem(key);
        if (raw) {
            assert.ok(
                raw.indexOf("a secret only I should know") === -1,
                "journal content must not appear under another key: " + key
            );
        }
    }
});

/* ----------------------------------------------------------
   Dates and persistence
   ---------------------------------------------------------- */

test("timestamps survive a load and an edit", function () {
    var storage = makeStorage();
    var created = SkolarJournal.createEntry(storage, "Dated", "Body");
    var createdAt = created.entry.createdAt;

    var loaded = SkolarJournal.loadEntries(storage)[0];
    assert.equal(loaded.createdAt, createdAt, "createdAt must not be rewritten on load");
    assert.equal(loaded.updatedAt, created.entry.updatedAt);

    var edited = SkolarJournal.save(storage, {
        id: created.entry.id,
        title: "Dated",
        body: "Body changed",
        createdAt: loaded.createdAt,
        updatedAt: String(Number(loaded.updatedAt) + 1000)
    });

    assert.ok(edited.ok, JSON.stringify(edited.problems));

    var reloaded = SkolarJournal.loadEntries(storage)[0];
    assert.equal(reloaded.createdAt, createdAt, "editing must keep the original creation date");
    assert.ok(
        Number(reloaded.updatedAt) >= Number(created.entry.updatedAt),
        "editing must not move updatedAt backwards"
    );
    assert.equal(reloaded.updatedAt, edited.entry.updatedAt, "the saved updatedAt is what is stored");
});

test("loadEntries still reads ISO timestamps written by an older build", function () {
    var created = "2026-01-02T03:04:05.000Z";
    var storage = makeStorage({
        "skolar.privateJournal": JSON.stringify([
            { id: "old-1", title: "Old", body: "Body", createdAt: created, updatedAt: created }
        ])
    });

    var entries = SkolarJournal.loadEntries(storage);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].createdAt, String(Date.parse(created)));
});

/* ----------------------------------------------------------
   Backup integration
   ---------------------------------------------------------- */

function backupPayload(extraData) {
    var SkolarBackup = require("../backup.js");
    var data = {
        "skolar.courses": [],
        "skolar.topics": {},
        "skolar.assessments": [],
        "skolar.sessions": [],
        "skolar.timetable": [],
        "skolar.revisionCourses": [],
        "skolar.notifications": [],
        "skolar.chatHistory": []
    };

    Object.keys(extraData || {}).forEach(function (key) {
        data[key] = extraData[key];
    });

    return {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: data
    };
}

test("createBackup exports journal entries and the file restores them", function () {
    var SkolarBackup = require("../backup.js");
    var source = makeStorage();
    SkolarJournal.createEntry(source, "Private", "a secret only I should know");

    var backup = SkolarBackup.createBackup(source, new Date());
    assert.equal(backup.data[JOURNAL_KEY].length, 1);
    assert.equal(backup.data[JOURNAL_KEY][0].body, "a secret only I should know");

    var validated = SkolarBackup.validateBackupText(SkolarBackup.serializeBackup(backup));
    assert.equal(validated.ok, true, validated.errors.join(" "));

    var target = makeStorage();
    var result = SkolarBackup.restoreBackup(target, validated.backup);

    assert.equal(result.ok, true, result.errors.join(" "));
    var restored = SkolarJournal.loadEntries(target);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].title, "Private");
    assert.equal(restored[0].body, "a secret only I should know");
});

test("an older backup without a journal does not erase existing entries", function () {
    var SkolarBackup = require("../backup.js");
    var storage = makeStorage();
    SkolarJournal.createEntry(storage, "Keep me", "Still here");
    var before = storage.getItem(JOURNAL_KEY);

    var result = SkolarBackup.restoreBackup(storage, backupPayload());

    assert.equal(result.ok, true, result.errors.join(" "));
    assert.equal(storage.getItem(JOURNAL_KEY), before);
    assert.equal(SkolarJournal.loadEntries(storage).length, 1);
});

test("a backup with malformed journal data is refused and changes nothing", function () {
    var SkolarBackup = require("../backup.js");
    var storage = makeStorage();
    SkolarJournal.createEntry(storage, "Keep me", "Still here");
    var before = storage.getItem(JOURNAL_KEY);

    var bad = backupPayload({
        "skolar.privateJournal": [{ id: "j1", title: 42, body: null, createdAt: "nope" }]
    });

    var result = SkolarBackup.restoreBackup(storage, bad);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "validate");
    assert.match(result.errors.join(" "), /Journal entry 1/);
    assert.equal(storage.getItem(JOURNAL_KEY), before, "a refused restore must not touch the journal");
});

test("a failed restore leaves the journal exactly as it was", function () {
    var SkolarBackup = require("../backup.js");
    var source = makeStorage();
    SkolarJournal.createEntry(source, "Incoming", "Incoming body");

    var storage = makeStorage();
    SkolarJournal.createEntry(storage, "Existing", "Existing body");
    var before = storage.getItem(JOURNAL_KEY);

    var failing = {
        getItem: function (key) {
            return storage.getItem(key);
        },
        setItem: function (key, value) {
            if (key === "skolar.chatHistory") {
                throw new Error("storage full");
            }
            storage.setItem(key, value);
        },
        removeItem: function (key) {
            storage.removeItem(key);
        },
        keys: function () {
            return storage.keys();
        }
    };

    var result = SkolarBackup.restoreBackup(failing, SkolarBackup.createBackup(source, new Date()));

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack, "the keys written before the failure must be rolled back");
    assert.equal(storage.getItem(JOURNAL_KEY), before);
    assert.equal(SkolarJournal.loadEntries(storage)[0].title, "Existing");
});

/* ----------------------------------------------------------
   Privacy: no network, no AI context, no server involvement
   ---------------------------------------------------------- */

test("journal.js never talks to the network", function () {
    var source = fs.readFileSync(path.join(root, "journal.js"), "utf8");

    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
});

test("the chat client and the server never read the journal", function () {
    var app = fs.readFileSync(path.join(root, "app.js"), "utf8");
    var server = fs.readFileSync(path.join(root, "server.mjs"), "utf8");

    [app, server].forEach(function (source) {
        assert.doesNotMatch(source, /privateJournal/);
        assert.doesNotMatch(source, /SkolarJournal/);
    });
});
