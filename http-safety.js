/* ============================================================
   Skolar — HTTP safety: what the world may fetch, and what an
   error is allowed to say.

   STATIC FILES
   Previously express.static(".") served the whole project folder.
   That worked locally, but on a public host it made every file in
   the deployment downloadable: server.mjs (with the full AI system
   prompt), package.json, the lockfile, the test suite, and any
   scratch folder left in the folder.

   The app only ever needs five files. Anything else is refused with
   a 404 before the static middleware is reached, so .env, .git,
   node_modules, scripts/, articles/, diff/, tmp/ and any future
   private file are unreachable by default. This is an allowlist,
   not a blocklist: a file added later is private unless it is
   deliberately published here.

   ERRORS
   Express's built-in handler echoes a stack trace when NODE_ENV is
   not "production", which leaks filesystem paths and internal
   structure. This handler always answers JSON, logs the detail once
   on the server, and only includes a stack when the operator has
   explicitly asked for development behaviour.
   ============================================================ */

(function (root, factory) {
    var api = factory();

    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }

    if (root && typeof root === "object") {
        root.SkolarHttpSafety = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /* The complete public surface of the app. index.html is served for
       "/", which is what the allowlist entry below covers. */
    var PUBLIC_FILES = ["index.html", "style.css", "app.js", "backup.js", "journal.js"];

    var NOT_FOUND_MESSAGE = "Not found.";
    var BAD_JSON_MESSAGE = "Please send valid JSON.";
    var SERVER_ERROR_MESSAGE = "Something went wrong.";

    function decodePath(text) {
        try {
            return decodeURIComponent(text);
        } catch (error) {
            /* A malformed escape can never match an allowlist entry. */
            return null;
        }
    }

    /* True only for "/" (which the static middleware answers with
       index.html) and for the five published files. */
    function isPublicPath(pathname, publicFiles) {
        if (typeof pathname !== "string") {
            return false;
        }

        var text = pathname.trim();

        if (!text || text.charAt(0) !== "/") {
            return false;
        }

        var decoded = decodePath(text);

        if (decoded === null) {
            return false;
        }

        var name = decoded.slice(1);

        if (name === "") {
            return true;
        }

        /* A trailing slash, a dot-segment or a nested path is never a
           published file. */
        if (name.charAt(name.length - 1) === "/" || name.indexOf("/") !== -1 || name === "." || name === "..") {
            return false;
        }

        var allowed = publicFiles || PUBLIC_FILES;

        return allowed.indexOf(name) !== -1;
    }

    /* Mounted immediately before express.static. Only GET and HEAD are
       guarded so the POST routes are untouched; other methods fall
       through to the routes and get the usual 404. */
    function createStaticGuard(options) {
        var settings = options || {};
        var publicFiles = settings.publicFiles;

        return function staticGuard(req, res, next) {
            var method = req && typeof req.method === "string" ? req.method.toUpperCase() : "";

            if (method !== "GET" && method !== "HEAD") {
                next();
                return;
            }

            var pathname = req && typeof req.path === "string" ? req.path : "/";

            if (isPublicPath(pathname, publicFiles)) {
                next();
                return;
            }

            res.status(404).json({
                error: NOT_FOUND_MESSAGE,
                code: "not_found"
            });
        };
    }

    function statusOf(err) {
        if (err && err.type === "entity.parse.failed") {
            return 400;
        }

        var status = Number(err && (err.status || err.statusCode));

        if (Number.isFinite(status) && status >= 400 && status < 600) {
            return status;
        }

        return 500;
    }

    /* Express routes error middleware by arity, so this must stay a
       four-argument function. Defaults to the safe behaviour: unless an
       operator explicitly asks for development output, a stack trace is
       never sent to a client. */
    function createErrorHandler(options) {
        var settings = options || {};
        var isProduction = settings.isProduction !== false;
        var log = typeof settings.log === "function" ? settings.log : function () {};

        return function httpErrorHandler(err, req, res, next) {
            if (err === null || err === undefined) {
                next();
                return;
            }

            var status = statusOf(err);
            var body = {
                error: status === 400 ? BAD_JSON_MESSAGE : SERVER_ERROR_MESSAGE,
                code: status === 400 ? "invalid_json" : "server_error"
            };

            /* One line on the server, with the real reason. Never the API
               key and never the request body. */
            log("[http] " + status + " " + String((err && err.stack) || (err && err.message) || err));

            if (res && res.headersSent) {
                next(err);
                return;
            }

            if (!isProduction) {
                body.debug = String((err && (err.stack || err.message)) || err);
            }

            res.status(status).json(body);
        };
    }

    return {
        PUBLIC_FILES: PUBLIC_FILES,
        NOT_FOUND_MESSAGE: NOT_FOUND_MESSAGE,
        BAD_JSON_MESSAGE: BAD_JSON_MESSAGE,
        SERVER_ERROR_MESSAGE: SERVER_ERROR_MESSAGE,

        isPublicPath: isPublicPath,
        createStaticGuard: createStaticGuard,
        createErrorHandler: createErrorHandler
    };
});
