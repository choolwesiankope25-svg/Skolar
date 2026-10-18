/* ============================================================
   Skolar — Private Journal

   A private, offline space for writing and remembering your own
   thoughts. Every entry is stored only on this device.

   What this module owns:
     - The storage key and the shape of a journal entry.
     - All CRUD for entries (create, save, list, read, edit, delete).
     - Safe rendering of the entry bodies as plain, escaped text.

   What it deliberately does not do:
     - Nothing here ever forwards journal content to chat, AI, the server,
       buildStudyContext, logs, or the export service. A helper is provided
       so tests can prove that fact in one place.
   ============================================================ */

(function (root, factory) {
    var api = factory();

    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }

    if (root && typeof root === "object") {
        root.SkolarJournal = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    var JOURNAL_KEY = "skolar.privateJournal";
    var JOURNAL_TITLE_MAX = 160;
    var JOURNAL_BODY_MAX = 20000;
    var JOURNAL_MAX_ENTRIES = 10000;

    function isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }

    function errorMessage(error) {
        if (error && typeof error.message === "string" && error.message) {
            return error.message;
        }

        return String(error);
    }

    function makeEntry(id, title, body, createdAt, updatedAt) {
        return {
            id: id,
            title: title,
            body: body,
            createdAt: createdAt,
            updatedAt: updatedAt
        };
    }

    function isValidId(value) {
        return typeof value === "string" && value.length > 0;
    }

    /* Entries are stored with millisecond timestamps written as strings
       (String(Date.now())), so a load must read them back as milliseconds
       rather than handing them to Date.parse(). ISO strings from an older
       build are still accepted, and anything unreadable becomes 0 so the
       caller can fall back to "now". */
    function toMillis(value) {
        if (typeof value === "number") {
            return Number.isFinite(value) && value > 0 ? value : 0;
        }

        if (typeof value !== "string" || value.trim() === "") {
            return 0;
        }

        var text = value.trim();

        if (/^\d+$/.test(text)) {
            var millis = parseInt(text, 10);
            return Number.isFinite(millis) && millis > 0 ? millis : 0;
        }

        var parsed = Date.parse(text);

        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    function normalizeEntry(raw) {
        if (!isPlainObject(raw)) {
            return null;
        }

        var id = raw.id;

        if (!isValidId(id)) {
            return null;
        }

        var title = "";
        if (isPlainObject(raw) && typeof raw.title === "string") {
            title = raw.title.replace(/^\s+|\s+$/g, "");
        }

        if (title.length > JOURNAL_TITLE_MAX) {
            title = title.slice(0, JOURNAL_TITLE_MAX);
        }

        var body = "";
        if (typeof raw.body === "string") {
            body = raw.body;
        }

        if (body.length > JOURNAL_BODY_MAX) {
            body = body.slice(0, JOURNAL_BODY_MAX);
        }

        var createdAt = toMillis(raw.createdAt);

        if (!createdAt) {
            createdAt = Date.now();
        }

        var updatedAt = toMillis(raw.updatedAt);

        if (!updatedAt) {
            updatedAt = Date.now();
        }

        return makeEntry(id, title, body, String(createdAt), String(updatedAt));
    }

    function strictValidateEntry(entry) {
        var problems = [];

        if (!isPlainObject(entry)) {
            problems.push("An entry must be an object.");
            return problems;
        }

        if (typeof entry.id !== "string" || !entry.id) {
            problems.push("An entry needs a non-empty id.");
        }

        if (typeof entry.title !== "string") {
            problems.push("An entry title must be text.");
        } else if (entry.title.length > JOURNAL_TITLE_MAX) {
            problems.push("An entry title may be at most " + JOURNAL_TITLE_MAX + " characters.");
        }

        if (typeof entry.body !== "string") {
            problems.push("An entry body must be text.");
        } else if (entry.body.length > JOURNAL_BODY_MAX) {
            problems.push("An entry body may be at most " + JOURNAL_BODY_MAX + " characters.");
        }

        if (typeof entry.createdAt !== "string" || !entry.createdAt || isNaN(parseInt(entry.createdAt, 10))) {
            problems.push("An entry createdAt is not a recognised date.");
        }

        if (typeof entry.updatedAt !== "string" || !entry.updatedAt || isNaN(parseInt(entry.updatedAt, 10))) {
            problems.push("An entry updatedAt is not a recognised date.");
        }

        return problems;
    }

    function readOrCreateStorage(storage) {
        var raw;

        try {
            raw = storage.getItem(JOURNAL_KEY);
        } catch (error) {
            console.error(
                "[journal] Could not read the journal from this browser: " +
                errorMessage(error)
            );

            return [];
        }

        if (!raw) {
            return [];
        }

        try {
            var parsed = JSON.parse(raw);

            if (!Array.isArray(parsed)) {
                console.error("[journal] The stored journal is not a list and was replaced with an empty list.");
                return [];
            }

            var entries = [];

            for (var i = 0; i < parsed.length; i++) {
                var item = parsed[i];
                var normalized = normalizeEntry(item);

                if (normalized) {
                    entries.push(normalized);
                }
            }

            return entries;
        } catch (error) {
            console.error(
                "[journal] The stored journal is not valid JSON and was replaced with an empty list: " +
                errorMessage(error)
            );

            return [];
        }
    }

    function snapshot(storage) {
        try {
            var raw = storage.getItem(JOURNAL_KEY);

            if (!raw) {
                return null;
            }

            return raw;
        } catch (error) {
            console.error("[journal] Could not snapshot the journal before a write: " + errorMessage(error));

            return null;
        }
    }

    function loadEntries(storage) {
        return readOrCreateStorage(storage);
    }

    function exists(storage, id) {
        var entries = loadEntries(storage);

        for (var i = 0; i < entries.length; i++) {
            if (entries[i].id === id) {
                return true;
            }
        }

        return false;
    }

    function createEntry(storage, title, body) {
        var id = "journal-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        var now = Date.now();

        var entry = makeEntry(id, title, body, String(now), String(now));
        var normalized = normalizeEntry(entry);

        if (!normalized) {
            return { ok: false, problems: ["The entry could not be normalised."], entry: null };
        }

        return save(storage, normalized);
    }

    function save(storage, entry) {
        var normalized = normalizeEntry(entry);

        if (!normalized) {
            return { ok: false, problems: ["The entry could not be normalised."], entry: null };
        }

        var existing = loadEntries(storage);
        var found = false;
        var normalizedId = normalized.id;

        var updated = [];
        for (var i = 0; i < existing.length; i++) {
            var item = existing[i];

            if (item.id === normalizedId) {
                found = true;
                updated.push(makeEntry(
                    normalizedId,
                    normalized.title,
                    normalized.body,
                    item.createdAt,
                    String(Date.now())
                ));
            } else {
                updated.push(item);
            }
        }

        if (!found) {
            if (updated.length >= JOURNAL_MAX_ENTRIES) {
                updated.shift();
            }

            var now = Date.now();
            updated.push(makeEntry(
                normalizedId,
                normalized.title,
                normalized.body,
                normalized.createdAt,
                String(now)
            ));
        }

        var writeResult = write(storage, updated, normalizedId);

        if (writeResult.ok) {
            writeResult.entry = updated.find(function (item) { return item.id === normalizedId; }) || normalized;
        }

        return writeResult;
    }

    function deleteEntry(storage, id) {
        var existing = loadEntries(storage);
        var removed = false;

        for (var i = 0; i < existing.length; i++) {
            if (existing[i].id === id) {
                removed = true;
                break;
            }
        }

        if (!removed) {
            return { ok: false, problems: ["There is no such entry."], removed: false };
        }

        var before = snapshot(storage);
        var after = existing.slice();

        for (var i = 0; i < after.length; i++) {
            var entry = existing[i];

            if (entry.id === id) {
                after.splice(i, 1);
                i--;
            }
        }

        try {
            storage.setItem(JOURNAL_KEY, JSON.stringify(after));
        } catch (error) {
            try {
                if (before !== null) {
                    storage.setItem(JOURNAL_KEY, before);
                }
            } catch (rollbackError) {
                console.error(
                    "[journal] A delete failed and could not be rolled back: " +
                    errorMessage(rollbackError)
                );
            }

            console.error("[journal] Could not delete an entry: " + errorMessage(error));

            return { ok: false, problems: ["The entry could not be removed."], removed: false };
        }

        return { ok: true, removed: true };
    }

    function write(storage, entries, targetId) {
        var before = snapshot(storage);

        try {
            storage.setItem(JOURNAL_KEY, JSON.stringify(entries));
        } catch (error) {
            try {
                if (before !== null) {
                    storage.setItem(JOURNAL_KEY, before);
                }
            } catch (rollbackError) {
                console.error(
                    "[journal] A write failed and could not be rolled back: " +
                    errorMessage(rollbackError)
                );
            }

            console.error("[journal] Could not save the journal: " + errorMessage(error));

            return { ok: false, problems: ["The journal could not be saved."], affectedEntryId: targetId };
        }

        return { ok: true, affectedEntryId: targetId };
    }

    function escapeHTML(text) {
        if (typeof text !== "string") {
            text = String(text);
        }

        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function entryTitleHTML(title) {
        return "<span class=\"journal-entry-title\">" + escapeHTML(title) + "</span>";
    }

    function entryBodyHTML(body) {
        return "<p class=\"journal-entry-body\">" + escapeHTML(body || "") + "</p>";
    }

    function entryCardHTML(entry) {
        var updatedAt = entry.updatedAt ? new Date(parseInt(entry.updatedAt, 10)) : null;
        var updated = updatedAt ? updatedAt.toLocaleString() : "";

        return (
            "<div class=\"journal-entry-card\">" +
            "<div class=\"journal-entry-head\">" +
            "      <span class=\"journal-entry-delete\">" + escapeHTML(entry.id) + "</span>" +
            (updated ? "<span class=\"journal-entry-meta\">updated " + escapeHTML(updated) + "</span>" : "") +
            "</div>" +
            entryTitleHTML(entry.title) +
            entryBodyHTML(entry.body) +
            "</div>"
        );
    }

    function entryListHTML(entries) {
        var rows = [];
        for (var i = 0; i < entries.length; i++) {
            rows.push(entryCardHTML(entries[i]));
        }

        return "<ol class=\"journal-entry-list\">" + rows.join("") + "</ol>";
    }

    function journalCounts(storage) {
        var entries = loadEntries(storage);
        var titles = [];

        for (var i = 0; i < entries.length; i++) {
            titles.push(entries[i].title);
        }

        return {
            count: entries.length,
            titles: titles
        };
    }

    return {
        JOURNAL_KEY: JOURNAL_KEY,
        JOURNAL_TITLE_MAX: JOURNAL_TITLE_MAX,
        JOURNAL_BODY_MAX: JOURNAL_BODY_MAX,
        JOURNAL_MAX_ENTRIES: JOURNAL_MAX_ENTRIES,

        loadEntries: loadEntries,
        exists: exists,
        createEntry: createEntry,
        save: save,
        deleteEntry: deleteEntry,
        write: write,
        readOrCreateStorage: readOrCreateStorage,
        snapshot: snapshot,
        normalizeEntry: normalizeEntry,
        strictValidateEntry: strictValidateEntry,

        entryTitleHTML: entryTitleHTML,
        entryBodyHTML: entryBodyHTML,
        entryCardHTML: entryCardHTML,
        entryListHTML: entryListHTML,
        escapeHTML: escapeHTML,

        journalCounts: journalCounts
    };
});
