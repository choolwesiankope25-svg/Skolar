/* ============================================================
   Skolar — Backup & Restore core

   One module owns the backup format, its validation and the
   restore write path, so the page markup in index.html and the
   tests in scripts/backup.test.mjs exercise exactly the same
   code.

   Rules this module follows:
     - It only ever reads or writes the real storage keys listed
       in BACKUP_KEYS (mirrored from index.html and app.js).
       No key is invented, and a restore never creates a key
       that is not in that list.
     - A restore either completes for every key in the file, or
       the data that was there before is written back.
     - Nothing here touches the DOM except downloadText(), which
       takes its environment as a parameter so tests can inject
       their own.
   ============================================================ */

(function (root, factory) {
    const api = factory();

    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }

    if (root && typeof root === "object") {
        root.SkolarBackup = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /* The file format marker and the version of this build. A file with a
       higher version was written by a newer Skolar and is refused rather
       than guessed at. */
    const BACKUP_FORMAT = "skolar-backup";
    const BACKUP_VERSION = 1;
    const BACKUP_APP = "Skolar";

    /* Refuse absurdly large files before parsing them. */
    const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

    /* The actual keys this project uses:
         index.html: skolar.courses, skolar.topics, skolar.assessments,
                     skolar.sessions, skolar.timetable, skolar.notifications,
                     skolar.revisionCourses
         app.js:     skolar.chatHistory
       `type` is the JSON shape the app stores there and validates against. */
    const BACKUP_KEYS = [
        { key: "skolar.courses", label: "Courses", type: "array" },
        { key: "skolar.topics", label: "Topics", type: "object" },
        { key: "skolar.assessments", label: "Assessments", type: "array" },
        { key: "skolar.sessions", label: "Study sessions", type: "array" },
        { key: "skolar.timetable", label: "Timetable", type: "array" },
        { key: "skolar.revisionCourses", label: "Revision courses", type: "array" },
        { key: "skolar.notifications", label: "Reminders", type: "array" },
        { key: "skolar.chatHistory", label: "Chat history", type: "array" }
    ];

    function isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }

    function emptyValue(type) {
        return type === "object" ? {} : [];
    }

    function matchesType(value, type) {
        return type === "object" ? isPlainObject(value) : Array.isArray(value);
    }

    function describeType(type) {
        return type === "object" ? "a JSON object" : "a JSON array";
    }

    function errorMessage(error) {
        if (error && typeof error.message === "string" && error.message) {
            return error.message;
        }

        return String(error);
    }

    function keyEntry(key) {
        return BACKUP_KEYS.find(entry => entry.key === key) || null;
    }

    function countValue(value) {
        if (Array.isArray(value)) {
            return value.length;
        }

        if (isPlainObject(value)) {
            return Object.keys(value).length;
        }

        return 0;
    }

    /* ----------------------------------------------------------
       Export
       ---------------------------------------------------------- */

    /* Reads every known key and builds the versioned payload.
       A stored value that cannot be read or that has the wrong shape is
       exported as an empty value and reported in `notes`, instead of
       failing the whole export or silently shipping broken data. */
    function createBackup(storage, now) {
        const createdAt = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
        const data = {};
        const notes = [];

        for (const entry of BACKUP_KEYS) {
            const raw = storage.getItem(entry.key);

            if (raw === null || raw === undefined || raw === "") {
                data[entry.key] = emptyValue(entry.type);
                continue;
            }

            let parsed;

            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                data[entry.key] = emptyValue(entry.type);
                notes.push(
                    entry.label + " could not be read from this browser and was exported as empty. " +
                    "The original stored value was left untouched."
                );
                continue;
            }

            if (!matchesType(parsed, entry.type)) {
                data[entry.key] = emptyValue(entry.type);
                notes.push(
                    entry.label + " was stored in an unexpected shape and was exported as empty. " +
                    "The original stored value was left untouched."
                );
                continue;
            }

            data[entry.key] = parsed;
        }

        const backup = {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            app: BACKUP_APP,
            createdAt: createdAt,
            data: data
        };

        if (notes.length) {
            backup.notes = notes;
        }

        return backup;
    }

    function serializeBackup(backup) {
        return JSON.stringify(backup, null, 2);
    }

    function exportFileName(now) {
        const date = now instanceof Date ? now : new Date(now || Date.now());
        const pad = value => String(value).padStart(2, "0");

        return (
            "skolar-backup-" +
            date.getFullYear() + "-" +
            pad(date.getMonth() + 1) + "-" +
            pad(date.getDate()) +
            ".json"
        );
    }

    /* ----------------------------------------------------------
       Validation
       ---------------------------------------------------------- */

    /* Parses untrusted text and reports every problem it can find.
       Returns { ok, backup, errors, warnings }. Warnings never block a
       restore: a key that is absent from the file simply keeps whatever
       is stored now, and a field this build does not recognise is
       ignored (it is never written anywhere). */
    function validateBackupText(text) {
        const errors = [];
        const warnings = [];

        if (typeof text !== "string" || !text.trim()) {
            return { ok: false, backup: null, errors: ["The file is empty, so there is nothing to restore."], warnings: warnings };
        }

        let backup;

        try {
            backup = JSON.parse(text);
        } catch (error) {
            return {
                ok: false,
                backup: null,
                errors: ["This file is not valid JSON, so it cannot be a Skolar backup."],
                warnings: warnings
            };
        }

        if (!isPlainObject(backup)) {
            return {
                ok: false,
                backup: null,
                errors: ["A Skolar backup must be a JSON object at the top level."],
                warnings: warnings
            };
        }

        if (!("format" in backup)) {
            errors.push("The file is missing the required \"format\" field.");
        } else if (backup.format !== BACKUP_FORMAT) {
            errors.push(
                "This is not a Skolar backup file (format is " +
                JSON.stringify(String(backup.format)) +
                ", expected " + JSON.stringify(BACKUP_FORMAT) + ")."
            );
        }

        if (!("version" in backup)) {
            errors.push("The file is missing the required \"version\" field.");
        } else {
            const version = backup.version;

            if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
                errors.push("The backup version is not a valid version number.");
            } else if (version > BACKUP_VERSION) {
                errors.push(
                    "This backup was created by a newer version of Skolar (version " +
                    version + "); this build supports version " + BACKUP_VERSION + " or older."
                );
            }
        }

        if (!("data" in backup)) {
            errors.push("The file is missing the required \"data\" field.");
        } else if (!isPlainObject(backup.data)) {
            errors.push("The \"data\" field must be a JSON object.");
        }

        if (errors.length) {
            return { ok: false, backup: null, errors: errors, warnings: warnings };
        }

        if (typeof backup.createdAt !== "string" || !backup.createdAt) {
            warnings.push("The file does not say when it was created.");
        }

        const unknownKeys = [];
        let knownCount = 0;

        for (const field of Object.keys(backup.data)) {
            const entry = keyEntry(field);

            if (!entry) {
                unknownKeys.push(field);
                continue;
            }

            knownCount += 1;

            if (!matchesType(backup.data[field], entry.type)) {
                errors.push(
                    "\"" + entry.key + "\" must be " + describeType(entry.type) +
                    " in a Skolar backup, but this file has something else."
                );
            }
        }

        if (knownCount === 0) {
            errors.push("The file does not contain any Skolar data.");
        }

        unknownKeys.forEach(field => {
            warnings.push("The field \"" + field + "\" is not a Skolar data key and will be ignored.");
        });

        BACKUP_KEYS.forEach(entry => {
            if (!(entry.key in backup.data)) {
                warnings.push(
                    entry.label + " (" + entry.key + ") is not in this file, so your current data for it will be kept."
                );
            }
        });

        if (errors.length) {
            return { ok: false, backup: null, errors: errors, warnings: warnings };
        }

        return { ok: true, backup: backup, errors: [], warnings: warnings };
    }

    /* Re-checks a payload that is about to be written. The restore path
       calls this itself, so a caller cannot bypass validation. */
    function validateBackupObject(backup) {
        if (!isPlainObject(backup)) {
            return ["The backup payload is not an object."];
        }

        const errors = [];

        if (backup.format !== BACKUP_FORMAT) {
            errors.push("The backup payload is not marked as a Skolar backup.");
        }

        if (typeof backup.version !== "number" || !Number.isInteger(backup.version) || backup.version < 1) {
            errors.push("The backup payload has no usable version.");
        } else if (backup.version > BACKUP_VERSION) {
            errors.push("The backup payload uses a version this build does not support.");
        }

        if (!isPlainObject(backup.data)) {
            errors.push("The backup payload has no data object.");
            return errors;
        }

        let knownCount = 0;

        for (const field of Object.keys(backup.data)) {
            const entry = keyEntry(field);

            if (!entry) {
                continue;
            }

            knownCount += 1;

            if (!matchesType(backup.data[field], entry.type)) {
                errors.push("\"" + entry.key + "\" must be " + describeType(entry.type) + ".");
            }
        }

        if (knownCount === 0) {
            errors.push("The backup payload contains no Skolar data.");
        }

        return errors;
    }

    /* ----------------------------------------------------------
       Preview
       ---------------------------------------------------------- */

    /* What a restore would do, key by key, compared with what is stored
       now. Used to build the confirmation screen. */
    function describePreview(backup, storage) {
        const rows = BACKUP_KEYS.map(entry => {
            let currentRaw = null;
            let readFailed = false;

            try {
                currentRaw = storage.getItem(entry.key);
            } catch (error) {
                readFailed = true;
            }

            const present = isPlainObject(backup.data) && (entry.key in backup.data);

            if (!present) {
                return {
                    key: entry.key,
                    label: entry.label,
                    action: "kept",
                    currentCount: readFailed ? null : countOf(currentRaw, entry.type),
                    incomingCount: null
                };
            }

            const incomingCount = countValue(backup.data[entry.key]);
            const storedCount = readFailed ? null : countOf(currentRaw, entry.type);

            let action = "replace";

            if (readFailed || currentRaw === null || currentRaw === undefined || currentRaw === "") {
                action = "create";
            } else if (currentRaw === JSON.stringify(backup.data[entry.key])) {
                action = "unchanged";
            }

            return {
                key: entry.key,
                label: entry.label,
                action: action,
                currentCount: storedCount,
                incomingCount: incomingCount
            };
        });

        return { rows: rows };
    }

    function countOf(raw, type) {
        if (raw === null || raw === undefined || raw === "") {
            return 0;
        }

        try {
            const parsed = JSON.parse(raw);
            return matchesType(parsed, type) ? countValue(parsed) : null;
        } catch (error) {
            return null;
        }
    }

    /* ----------------------------------------------------------
       Restore
       ---------------------------------------------------------- */

    /* Writes the payload into storage.

       1. Validate the payload again — invalid input never reaches storage.
       2. Snapshot the current raw value of every known key.
       3. Write the keys present in the file.
       4. If any write throws, write every key already changed back to its
          snapshot value and report the failure.

       Returns { ok, restored, errors, stage, rolledBack, rollbackErrors }. */
    function restoreBackup(storage, backup) {
        const problems = validateBackupObject(backup);

        if (problems.length) {
            return {
                ok: false,
                stage: "validate",
                restored: [],
                errors: problems,
                rolledBack: true,
                rollbackErrors: []
            };
        }

        const snapshot = Object.create(null);

        try {
            for (const entry of BACKUP_KEYS) {
                snapshot[entry.key] = storage.getItem(entry.key);
            }
        } catch (error) {
            return {
                ok: false,
                stage: "read",
                restored: [],
                errors: [
                    "The data currently stored in this browser could not be read (" +
                    errorMessage(error) + "), so nothing was changed."
                ],
                rolledBack: true,
                rollbackErrors: []
            };
        }

        const written = [];

        for (const entry of BACKUP_KEYS) {
            if (!(entry.key in backup.data)) {
                continue;
            }

            let text;

            try {
                text = JSON.stringify(backup.data[entry.key]);
                storage.setItem(entry.key, text);
            } catch (error) {
                const rollbackErrors = rollback(storage, snapshot, written);

                const message =
                    "Saving \"" + entry.label + "\" failed (" + errorMessage(error) + "). ";

                return {
                    ok: false,
                    stage: "write",
                    restored: [],
                    errors: [
                        message + (rollbackErrors.length
                            ? "Your previous data could not be fully restored; failed keys: " +
                              rollbackErrors.join("; ") + "."
                            : "Your existing data was left exactly as it was.")
                    ],
                    rolledBack: rollbackErrors.length === 0,
                    rollbackErrors: rollbackErrors
                };
            }

            written.push(entry.key);
        }

        return {
            ok: true,
            stage: "write",
            restored: written,
            errors: [],
            rolledBack: true,
            rollbackErrors: []
        };
    }

    /* Puts the already-written keys back to their pre-restore values.
       Keys that did not exist before are removed again. */
    function rollback(storage, snapshot, written) {
        const failures = [];

        for (let i = written.length - 1; i >= 0; i--) {
            const key = written[i];
            const original = snapshot[key];

            try {
                if (original === null || original === undefined) {
                    storage.removeItem(key);
                } else {
                    storage.setItem(key, original);
                }
            } catch (error) {
                failures.push(key + " (" + errorMessage(error) + ")");
            }
        }

        return failures;
    }

    /* ----------------------------------------------------------
       Download (browser only)
       ---------------------------------------------------------- */

    /* Builds a download from `text`. The environment is injectable so the
       tests can drive it without a browser. Returns the file name and the
       number of characters written. */
    function downloadText(text, fileName, deps) {
        const env = deps || {};
        const doc = env.document || (typeof document !== "undefined" ? document : null);
        const urlApi = env.URL || (typeof URL !== "undefined" ? URL : null);
        const BlobCtor = env.Blob || (typeof Blob !== "undefined" ? Blob : null);
        const timer = env.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);

        if (!doc || typeof doc.createElement !== "function" || !doc.body) {
            throw new Error("This environment cannot create a download.");
        }

        if (!urlApi || typeof urlApi.createObjectURL !== "function" || !BlobCtor) {
            throw new Error("This environment cannot turn the backup into a file.");
        }

        const blob = new BlobCtor([text], { type: "application/json" });
        const href = urlApi.createObjectURL(blob);
        const anchor = doc.createElement("a");

        anchor.href = href;
        anchor.download = fileName;

        doc.body.appendChild(anchor);
        anchor.click();

        if (typeof anchor.remove === "function") {
            anchor.remove();
        } else if (typeof doc.body.removeChild === "function") {
            doc.body.removeChild(anchor);
        }

        if (timer) {
            timer(function () {
                if (typeof urlApi.revokeObjectURL === "function") {
                    urlApi.revokeObjectURL(href);
                }
            }, 0);
        }

        return { fileName: fileName, characters: text.length, href: href };
    }

    return {
        BACKUP_FORMAT: BACKUP_FORMAT,
        BACKUP_VERSION: BACKUP_VERSION,
        BACKUP_APP: BACKUP_APP,
        BACKUP_KEYS: BACKUP_KEYS,
        MAX_BACKUP_BYTES: MAX_BACKUP_BYTES,
        createBackup: createBackup,
        serializeBackup: serializeBackup,
        exportFileName: exportFileName,
        validateBackupText: validateBackupText,
        validateBackupObject: validateBackupObject,
        describePreview: describePreview,
        countValue: countValue,
        restoreBackup: restoreBackup,
        downloadText: downloadText
    };
});
