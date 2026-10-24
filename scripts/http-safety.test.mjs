import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const HttpSafety = require("../http-safety.js");


/* ============================================================
   Which paths the public may fetch
   ============================================================ */

const PUBLISHED = ["/", "/index.html", "/style.css", "/app.js", "/backup.js", "/journal.js"];

const PRIVATE = [
    "/server.mjs",
    "/http-safety.js",
    "/rate-limit.js",
    "/server-config.js",
    "/package.json",
    "/package-lock.json",
    "/.env",
    "/.env.local",
    "/.git/config",
    "/.gitignore",
    "/scripts/journal.test.mjs",
    "/scripts/http-safety.test.mjs",
    "/node_modules/express/package.json",
    "/articles/notes.md",
    "/diff/patch.txt",
    "/tmp/scratch.txt",
    "/backup_restore_block.js",
    "/README.md",
    "/Dockerfile"
];

test("the app's own assets stay published", () => {
    for (const path of PUBLISHED) {
        assert.equal(HttpSafety.isPublicPath(path), true, path + " must stay public");
    }
});

test("source, config, secrets, git metadata, tests and scratch folders are refused", () => {
    for (const path of PRIVATE) {
        assert.equal(HttpSafety.isPublicPath(path), false, path + " must not be served");
    }
});

test("traversal and encoded paths cannot escape the allowlist", () => {
    const attempts = [
        "/../server.mjs",
        "/../../etc/passwd",
        "/.%2e/server.mjs",
        "/%2e%2e/server.mjs",
        "/..%2fserver.mjs",
        "/%252e%252e/server.mjs",
        "/app%2ejs.js.bak",
        "/app.js%00.txt",
        "/./app.js/../server.mjs",
        "server.mjs",
        ""
    ];

    for (const path of attempts) {
        assert.equal(HttpSafety.isPublicPath(path), false, JSON.stringify(path) + " must not be served");
    }
});

test("a malformed escape sequence is refused rather than guessed at", () => {
    assert.equal(HttpSafety.isPublicPath("/app%zz.js"), false);
    assert.equal(HttpSafety.isPublicPath(undefined), false);
    assert.equal(HttpSafety.isPublicPath(null), false);
    assert.equal(HttpSafety.isPublicPath(42), false);
});

test("a trailing slash or nested directory is never a published file", () => {
    assert.equal(HttpSafety.isPublicPath("/style.css/"), false);
    assert.equal(HttpSafety.isPublicPath("/index.html/x"), false);
    assert.equal(HttpSafety.isPublicPath("//app.js"), false);
    assert.equal(HttpSafety.isPublicPath("/."), false);
    assert.equal(HttpSafety.isPublicPath("/.."), false);
});


/* ============================================================
   The guard middleware
   ============================================================ */

function makeResponse() {
    return {
        statusCode: null,
        body: null,

        status(code) {
            this.statusCode = code;
            return this;
        },

        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

test("an allowed asset falls through to the static middleware", () => {
    const guard = HttpSafety.createStaticGuard();
    let passed = false;

    guard({ method: "GET", path: "/style.css" }, makeResponse(), () => { passed = true; });

    assert.equal(passed, true);
});

test("the root falls through so index.html is still served", () => {
    const guard = HttpSafety.createStaticGuard();
    let passed = false;

    guard({ method: "GET", path: "/" }, makeResponse(), () => { passed = true; });

    assert.equal(passed, true);
});

test("a private path is answered with 404 and never reaches the static middleware", () => {
    const guard = HttpSafety.createStaticGuard();
    const res = makeResponse();
    let passed = false;

    guard({ method: "GET", path: "/server.mjs" }, res, () => { passed = true; });

    assert.equal(passed, false, "next() must not be called");
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Not found.", code: "not_found" });
});

test("HEAD requests are guarded, POST and others pass through to the routes", () => {
    const guard = HttpSafety.createStaticGuard();

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        let passed = false;

        guard({ method, path: "/server.mjs" }, makeResponse(), () => { passed = true; });

        assert.equal(passed, true, method + " must still reach the API routes");
    }

    let headPassed = false;
    guard({ method: "head", path: "/package.json" }, makeResponse(), () => { headPassed = true; });

    assert.equal(headPassed, false, "lowercase HEAD must still be guarded");
});

test("a request without a method is left to the routes and can never read a file", () => {
    const guard = HttpSafety.createStaticGuard();
    const res = makeResponse();
    let passed = false;

    /* Only GET and HEAD can ever produce a file. Anything else falls
       through to the routes, which answer with their normal 404, so the
       guard must not respond here - and must never mark a private path
       as published for it. */
    guard({}, res, () => { passed = true; });

    assert.equal(passed, true);
    assert.equal(res.statusCode, null, "the guard must not answer a non-GET request");
    assert.equal(HttpSafety.isPublicPath("/server.mjs"), false);
});

test("a custom allowlist can be supplied", () => {
    const guard = HttpSafety.createStaticGuard({ publicFiles: ["logo.png"] });
    const res = makeResponse();
    let passed = false;

    guard({ method: "GET", path: "/app.js" }, res, () => { passed = true; });

    assert.equal(passed, false, "files outside the custom list are refused");
    assert.equal(res.statusCode, 404);
});


/* ============================================================
   Error responses
   ============================================================ */

function errorResponse(err, isProduction) {
    const res = makeResponse();

    const handler = HttpSafety.createErrorHandler({ isProduction });
    handler(err, {}, res, () => {});

    return res;
}

test("the error handler is a four-argument function, which is how Express routes it", () => {
    const handler = HttpSafety.createErrorHandler({ isProduction: true });

    assert.equal(handler.length, 4);
});

test("a malformed JSON body becomes a clear 400, not an HTML stack trace", () => {
    const err = Object.assign(new SyntaxError("Unexpected token"), {
        type: "entity.parse.failed",
        status: 400,
        body: "{bad"
    });

    const res = errorResponse(err, true);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "invalid_json");
    assert.equal(res.body.error, HttpSafety.BAD_JSON_MESSAGE);
});

test("an unexpected error becomes a generic 500", () => {
    const res = errorResponse(new Error("GROQ_API_KEY is abc123 and the path is /srv/app/server.mjs"), true);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, "server_error");
    assert.equal(res.body.error, HttpSafety.SERVER_ERROR_MESSAGE);
});

test("production responses never carry a stack trace or an internal message", () => {
    const err = new Error("boom in /srv/app/server.mjs line 42");
    err.stack = "Error: boom in /srv/app/server.mjs line 42\n    at handler (/srv/app/server.mjs:42:9)";

    const res = errorResponse(err, true);

    assert.deepEqual(Object.keys(res.body).sort(), ["code", "error"]);
    assert.ok(!JSON.stringify(res.body).includes("server.mjs"), "the stack must not be sent");
    assert.ok(!JSON.stringify(res.body).includes("boom"), "internal messages must not be sent");
});

test("development responses do include the stack, so local debugging still works", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at handler (/srv/app/server.mjs:42:9)";

    const res = errorResponse(err, false);

    assert.equal(res.body.code, "server_error");
    assert.ok(res.body.debug.includes("at handler"), "the stack is available locally");
});

test("an error handler with no error passes the request on", () => {
    const handler = HttpSafety.createErrorHandler({ isProduction: true });
    const res = makeResponse();
    let passed = false;

    handler(null, {}, res, () => { passed = true; });

    assert.equal(passed, true);
    assert.equal(res.statusCode, null);
});

test("an already-sent response is handed back to Express rather than rewritten", () => {
    const handler = HttpSafety.createErrorHandler({ isProduction: true });
    const res = makeResponse();

    res.headersSent = true;

    let handedBack = null;

    handler(new Error("late"), {}, res, error => { handedBack = error; });

    assert.ok(handedBack instanceof Error);
    assert.equal(res.statusCode, null, "the response must not be written twice");
});

test("an unusable status is clamped to 500", () => {
    assert.equal(errorResponse(Object.assign(new Error("x"), { status: 999 }), true).statusCode, 500);
    assert.equal(errorResponse(Object.assign(new Error("x"), { status: "nope" }), true).statusCode, 500);
    assert.equal(errorResponse(Object.assign(new Error("x"), { status: 403 }), true).statusCode, 403);
});

test("the failure is logged once on the server, where it can be useful", () => {
    const lines = [];
    const handler = HttpSafety.createErrorHandler({
        isProduction: true,
        log: message => lines.push(message)
    });

    handler(new Error("inner reason"), {}, makeResponse(), () => {});

    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("inner reason"), "the reason belongs in the log, not the response");
    assert.ok(lines[0].startsWith("[http] 500 "));
});


/* ============================================================
   The allowlist matches what the page actually needs
   ============================================================ */

test("every asset index.html references is published", () => {
    const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const referenced = new Set();

    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const value = match[1];

        /* Anything with a scheme or protocol-relative is not ours to serve. */
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
            continue;
        }

        referenced.add(value.replace(/^\//, ""));
    }

    const missing = [...referenced].filter(name => !HttpSafety.PUBLIC_FILES.includes(name));

    assert.deepEqual(missing, [], "these referenced assets are not published, so the page would break");
    assert.ok(referenced.has("app.js") && referenced.has("style.css"), "the check must see real assets");
});
