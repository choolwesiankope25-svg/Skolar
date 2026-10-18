/* Functional tests for Skolar's Backup & Restore restore path.

 * These focus on the restore semantics that are easy to get wrong when a
 * restore is rolled back: snapshot/rollback, read failures, write failures
 * on the last key, validation of non-string values in the incoming data,
 * and the exact shape of the error object when a restore fails.
 *
 * Run with: npm test   (node --test scripts/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const SkolarBackup = require("../backup.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const BACKUP_KEYS = [
    "skolar.courses",
    "skolar.topics",
    "skolar.assessments",
    "skolar.sessions",
    "skolar.timetable",
    "skolar.revisionCourses",
    "skolar.notifications",
    "skolar.chatHistory",
    "skolar.privateJournal"
];

const VALID_TYPES = {
    "skolar.courses": [],
    "skolar.topics": {},
    "skolar.assessments": [],
    "skolar.sessions": [],
    "skolar.timetable": [],
    "skolar.revisionCourses": [],
    "skolar.notifications": [],
    "skolar.chatHistory": [],
    "skolar.privateJournal": []
};

const VALID_JOURNAL = [
    {
        id: "journal-restored",
        title: "Restored thought",
        body: "Restored body",
        createdAt: "1760000000000",
        updatedAt: "1760000000000"
    }
];

/* Builds the `data` object of a backup payload. The format stores parsed
   JSON values (arrays and objects), exactly as createBackup produces them,
   so the journal gets a valid journal entry and topics stay an object. */
function buildBackupData(keys, value) {
    const data = {};
    keys.forEach(function (k) {
        if (k === "skolar.topics") {
            data[k] = {};
        } else if (k === "skolar.privateJournal") {
            data[k] = VALID_JOURNAL.slice();
        } else {
            data[k] = value;
        }
    });
    return data;
}

/* ----------------------------------------------------------
   Storage double: localStorage semantics plus failure injection
   ---------------------------------------------------------- */

function makeStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    const writeFailures = new Map();
    const readFailures = new Set();

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

            const failure = writeFailures.get(key);
            if (failure) {
                /* A real browser whose quota is exhausted keeps rejecting
                   writes, so a failure marks the storage as poisoned. */
                state.poisoned = true;
                throw failure;
            }

            map.set(key, String(value));
            return true;
        },
        removeItem(key) {
            map.delete(key);
            return true;
        },
        clear() {
            map.clear();
            return true;
        },
        keys() {
            return Array.from(map.keys());
        },
        writeFailures: writeFailures,
        get writeBlockedCount() {
            return state.poisoned ? 1 : 0;
        },
        failNextWrite(key) {
            if (!writeFailures.has(key)) {
                writeFailures.set(key, new Error("storage write blocked for " + key));
            }
        },
        withReadFailure(key) {
            readFailures.add(key);
            return this;
        },
        /* Reads the raw stored value without the read-failure injection,
           so a test can inspect a key it deliberately made unreadable. */
        peek(key) {
            return map.has(key) ? map.get(key) : null;
        },
        has(key) {
            return map.has(key);
        },
        poisonWrites() {
            state.poisoned = true;
            return this;
        },
        reset() {
            state.poisoned = false;
            state.sticky = false;
            map.clear();
            readFailures.clear();
            writeFailures.clear();
            return this;
        }
    };
}

/* ----------------------------------------------------------
   Helpers
   ---------------------------------------------------------- */

function parseBackup(raw) {
    const jsonText = typeof raw === "string" ? raw : JSON.stringify(raw);
    let parsed;

    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        throw new Error("The file is not valid JSON.");
    }

    return parsed;
}

/* ----------------------------------------------------------
   restoreBackup: read failures
   ---------------------------------------------------------- */

test("restoreBackup fails immediately when a read of an existing key fails, before any writes", function () {
    const storage = makeStorage({
        "skolar.courses": JSON.stringify([{ id: 1 }]),
        "skolar.topics": JSON.stringify({}),
        "skolar.assessments": JSON.stringify([]),
        "skolar.sessions": JSON.stringify([]),
        "skolar.timetable": JSON.stringify([]),
        "skolar.revisionCourses": JSON.stringify([]),
        "skolar.notifications": JSON.stringify([]),
        "skolar.chatHistory": JSON.stringify([]),
        "skolar.privateJournal": JSON.stringify([{ id: "j1", title: "Existing", body: "notes", createdAt: "1", updatedAt: "1" }])
    });

    storage.withReadFailure("skolar.courses");

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: buildBackupData(BACKUP_KEYS, [{ restored: true }])
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "read");
    assert.ok(result.rolledBack);
    assert.match(result.errors.join(" "), /skolar\.courses.*could not be read/i);
    assert.equal(storage.peek("skolar.courses"), JSON.stringify([{ id: 1 }]), "nothing may change when a read fails");
    assert.deepEqual(JSON.parse(storage.peek("skolar.topics")), {});
    assert.deepEqual(JSON.parse(storage.peek("skolar.assessments")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.sessions")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.timetable")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.revisionCourses")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.notifications")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.chatHistory")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.privateJournal")), [{ id: "j1", title: "Existing", body: "notes", createdAt: "1", updatedAt: "1" }]);
});

test("restoreBackup fails immediately when a read of the last existing key fails", function () {
    const storage = makeStorage({
        "skolar.courses": JSON.stringify([{ id: 1 }]),
        "skolar.topics": JSON.stringify({}),
        "skolar.assessments": JSON.stringify([]),
        "skolar.sessions": JSON.stringify([]),
        "skolar.timetable": JSON.stringify([]),
        "skolar.revisionCourses": JSON.stringify([]),
        "skolar.notifications": JSON.stringify([]),
        "skolar.chatHistory": JSON.stringify([]),
        "skolar.privateJournal": JSON.stringify([{ id: "j1", title: "Existing", body: "notes", createdAt: "1", updatedAt: "1" }])
    });

    storage.withReadFailure("skolar.privateJournal");

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: buildBackupData(BACKUP_KEYS, [{ restored: true }])
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "read");
    assert.ok(result.rolledBack);
    assert.match(result.errors.join(" "), /skolar\.privateJournal.*could not be read/i);
    assert.deepEqual(JSON.parse(storage.peek("skolar.courses")), [{ id: 1 }]);
    assert.deepEqual(JSON.parse(storage.peek("skolar.topics")), {});
    assert.deepEqual(JSON.parse(storage.peek("skolar.assessments")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.sessions")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.timetable")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.revisionCourses")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.notifications")), []);
    assert.deepEqual(JSON.parse(storage.peek("skolar.chatHistory")), []);
    assert.deepEqual(
        JSON.parse(storage.peek("skolar.privateJournal")),
        [{ id: "j1", title: "Existing", body: "notes", createdAt: "1", updatedAt: "1" }],
        "the unreadable journal key must still hold its original value"
    );
});

/* ----------------------------------------------------------
   restoreBackup: write failures
   ---------------------------------------------------------- */

test("restoreBackup fails the moment a write fails, and rolls back what it wrote", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: buildBackupData(BACKUP_KEYS, [{ restored: true }])
    };

    storage.failNextWrite("skolar.topics");

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack);
    const storedCourses = JSON.parse(storage.getItem("skolar.courses"));
    const storedTopics = JSON.parse(storage.getItem("skolar.topics"));
    const storedAssessments = JSON.parse(storage.getItem("skolar.assessments"));
    const storedSessions = JSON.parse(storage.getItem("skolar.sessions"));
    const storedTimetable = JSON.parse(storage.getItem("skolar.timetable"));
    const storedRevisionCourses = JSON.parse(storage.getItem("skolar.revisionCourses"));
    const storedNotifications = JSON.parse(storage.getItem("skolar.notifications"));
    const storedChatHistory = JSON.parse(storage.getItem("skolar.chatHistory"));
    const storedJournal = JSON.parse(storage.getItem("skolar.privateJournal"));

    assert.deepEqual(storedCourses, [{ id: 1 }]);
    assert.deepEqual(storedTopics, {});
    assert.deepEqual(storedAssessments, []);
    assert.deepEqual(storedSessions, []);
    assert.deepEqual(storedTimetable, []);
    assert.deepEqual(storedRevisionCourses, []);
    assert.deepEqual(storedNotifications, []);
    assert.deepEqual(storedChatHistory, []);
    assert.deepEqual(storedJournal, []);
});

test("restoreBackup rolls back on write failure even when the failure happens on the last key", function () {
    const storage = makeStorage();

    const keys = BACKUP_KEYS.slice().sort();
    storage.setItem(BACKUP_KEYS[0], JSON.stringify([]));
    for (let i = 1; i < BACKUP_KEYS.length; i++) {
        const value = VALID_TYPES[BACKUP_KEYS[i]];
        storage.setItem(BACKUP_KEYS[i], JSON.stringify(value));
    }

    storage.setItem(keys[keys.length - 1], JSON.stringify([{ roll: "me" }]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: buildBackupData(keys, [{ restored: true }])
    };

    storage.poisonWrites().failNextWrite(keys[keys.length - 1]);

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.equal(result.stage, "write");
    /* The keys written before the failure can still be rolled back, so the
       restore reports an honest clean rollback. */
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.rollbackErrors, []);
    const lastStored = JSON.parse(storage.peek(keys[keys.length - 1]));
    assert.deepEqual(lastStored, [{ roll: "me" }], "the failing key was never overwritten");
});

test("restoreBackup error object contains the failing key name", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: buildBackupData(BACKUP_KEYS, [{ restored: true }])
    };

    storage.failNextWrite("skolar.topics");

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack);
    assert.ok(result.errors && result.errors.join(" ").indexOf("skolar.topics") !== -1,
        "error should name the failing key: " + (result.errors && result.errors.join(" ")));
});

/* ----------------------------------------------------------
   restoreBackup: validation of non-string values in the incoming data
   ---------------------------------------------------------- */

test("restoreBackup fails when a data value is not a string", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: Object.assign(
            buildBackupData(BACKUP_KEYS, [{ restored: true }]),
            { "skolar.courses": { not: "an array" } },
            { "skolar.privateJournal": [{ not: "a journal entry" }] }
        )
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.courses")), [{ id: 1 }]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.topics")), {});
});

test("restoreBackup fails when a data value is not valid JSON", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: Object.assign(
            buildBackupData(BACKUP_KEYS, [{ restored: true }]),
            { "skolar.courses": "not-an-array" },
            { "skolar.privateJournal": "not-an-array" }
        )
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.courses")), [{ id: 1 }]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.topics")), {});
});

test("restoreBackup fails when an expected array key contains an object", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: Object.assign(
            buildBackupData(BACKUP_KEYS, [{ restored: true }]),
            { "skolar.courses": { not: "an array" } }
        )
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.courses")), [{ id: 1 }]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.topics")), {});
});

test("restoreBackup fails when an expected object key contains an array", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: Object.assign(
            buildBackupData(BACKUP_KEYS, [{ restored: true }]),
            { "skolar.topics": [{ not: "an object" }] }
        )
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, false);
    assert.ok(result.rolledBack);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.courses")), [{ id: 1 }]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.topics")), {});
});

/* ----------------------------------------------------------
   restoreBackup: successful restore
   ---------------------------------------------------------- */

test("restoreBackup restores all keys with the exact incoming values", function () {
    const storage = makeStorage();
    storage.setItem("skolar.courses", JSON.stringify([{ id: 1 }]));
    storage.setItem("skolar.topics", JSON.stringify({}));
    storage.setItem("skolar.assessments", JSON.stringify([]));
    storage.setItem("skolar.sessions", JSON.stringify([]));
    storage.setItem("skolar.timetable", JSON.stringify([]));
    storage.setItem("skolar.revisionCourses", JSON.stringify([]));
    storage.setItem("skolar.notifications", JSON.stringify([]));
    storage.setItem("skolar.chatHistory", JSON.stringify([]));
    storage.setItem("skolar.privateJournal", JSON.stringify([]));
    const incoming = {
        "skolar.courses": [{ id: 2, course: "New" }],
        "skolar.topics": { English: ["Grammar"] },
        "skolar.assessments": [{ id: 1 }],
        "skolar.sessions": [],
        "skolar.timetable": [],
        "skolar.revisionCourses": [],
        "skolar.notifications": [],
        "skolar.chatHistory": [{ role: "user", content: "hi" }],
        "skolar.privateJournal": [{ id: "j1", title: "Private", body: "entry", createdAt: "1", updatedAt: "1" }]
    };

    const backup = {
        format: SkolarBackup.BACKUP_FORMAT,
        version: SkolarBackup.BACKUP_VERSION,
        app: SkolarBackup.BACKUP_APP,
        createdAt: new Date().toISOString(),
        data: Object.fromEntries(BACKUP_KEYS.map(function (k) { return [k, incoming[k]]; }))
    };

    const result = SkolarBackup.restoreBackup(storage, backup);

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.courses")), incoming["skolar.courses"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.topics")), incoming["skolar.topics"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.assessments")), incoming["skolar.assessments"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.sessions")), incoming["skolar.sessions"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.timetable")), incoming["skolar.timetable"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.revisionCourses")), incoming["skolar.revisionCourses"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.notifications")), incoming["skolar.notifications"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.chatHistory")), incoming["skolar.chatHistory"]);
    assert.deepEqual(JSON.parse(storage.getItem("skolar.privateJournal")), [{ id: "j1", title: "Private", body: "entry", createdAt: "1", updatedAt: "1" }]);
});
