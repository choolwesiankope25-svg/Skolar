/* ============================================================
   Skolar — server configuration from the environment

   Everything the server reads from the hosting platform lives here,
   so the startup path in server.mjs stays short and the parsing
   rules can be tested without starting Express.

   Rules:
     - A missing variable falls back to a development default.
     - A present but unusable variable also falls back, and reports
       a warning, so a typo never silently changes behaviour.
     - No value read here is ever a secret. The Groq key is read in
       server.mjs only and is never passed through this module.
   ============================================================ */

(function (root, factory) {
    var api = factory();

    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }

    if (root && typeof root === "object") {
        root.SkolarServerConfig = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /* Local development keeps working with no environment at all. */
    var DEFAULT_PORT = 3000;

    /* Container hosts (Render, Railway, Koyeb, Fly) route traffic to a
       process listening on all interfaces. localhost still works when
       bound this way, so the same default is safe for local runs. */
    var DEFAULT_HOST = "0.0.0.0";

    /* X-Forwarded-For is only believed when the operator states how many
       proxy hops sit in front of the app. 0 means "never trust the header". */
    var DEFAULT_TRUST_PROXY_HOPS = 0;
    var MAX_TRUST_PROXY_HOPS = 10;

    var PORT_MIN = 1;
    var PORT_MAX = 65535;

    var DEFAULT_WINDOW_MS = 60000;
    var MIN_WINDOW_MS = 1000;
    var MAX_WINDOW_MS = 3600000;

    var DEFAULT_CHAT_MAX = 10;
    var DEFAULT_REVISION_MAX = 5;
    var MIN_RATE_LIMIT = 1;
    var MAX_RATE_LIMIT = 1000;

    function environment(env) {
        return env && typeof env === "object" ? env : {};
    }

    /* Returns "" when the variable is unset, a trimmed string when it has
       a value, and null when it is present but not a plain integer. */
    function readInteger(env, name) {
        var value = environment(env)[name];

        if (typeof value === "number" && Number.isFinite(value)) {
            value = String(value);
        }

        if (typeof value !== "string") {
            return "";
        }

        var text = value.trim();

        if (!text) {
            return "";
        }

        if (!/^\d+$/.test(text)) {
            return null;
        }

        return parseInt(text, 10);
    }

    function readText(env, name) {
        var value = environment(env)[name];

        if (typeof value !== "string") {
            return "";
        }

        return value.trim();
    }

    function warning(name, expected) {
        return name + " is not usable (" + expected + "), so the default was used instead.";
    }

    /* Port the hosting platform hands us, or 3000 for local development. */
    function resolvePort(env) {
        var value = readInteger(env, "PORT");

        if (value === "") {
            return { port: DEFAULT_PORT, warnings: [] };
        }

        if (value === null || value < PORT_MIN || value > PORT_MAX) {
            return {
                port: DEFAULT_PORT,
                warnings: [warning("PORT", "expected a whole number from " + PORT_MIN + " to " + PORT_MAX)]
            };
        }

        return { port: value, warnings: [] };
    }

    /* Interface to bind. Hosting platforms need all interfaces; empty or
       nonsense values fall back rather than binding to something odd. */
    function resolveHost(env) {
        var text = readText(env, "HOST");

        if (!text) {
            return { host: DEFAULT_HOST, warnings: [] };
        }

        if (/\s/.test(text) || text.indexOf("/") !== -1) {
            return {
                host: DEFAULT_HOST,
                warnings: [warning("HOST", "expected an address such as 0.0.0.0")]
            };
        }

        return { host: text, warnings: [] };
    }

    /* Number of trusted proxy hops. Deliberately accepts only a count:
       "true" would tell Express to believe a client-supplied header
       outright, which would let anyone forge their own address. */
    function resolveTrustProxy(env) {
        var value = readInteger(env, "TRUST_PROXY");

        if (value === "" || value === 0) {
            return { hops: DEFAULT_TRUST_PROXY_HOPS, warnings: [] };
        }

        if (value === null || value > MAX_TRUST_PROXY_HOPS) {
            return {
                hops: DEFAULT_TRUST_PROXY_HOPS,
                warnings: [warning("TRUST_PROXY", "expected a hop count from 0 to " + MAX_TRUST_PROXY_HOPS)]
            };
        }

        return { hops: value, warnings: [] };
    }

    function readBounded(env, name, fallback, minimum, maximum, warnings) {
        var value = readInteger(env, name);

        if (value === "") {
            return fallback;
        }

        if (value === null || value < minimum || value > maximum) {
            warnings.push(warning(name, "expected a whole number from " + minimum + " to " + maximum));
            return fallback;
        }

        return value;
    }

    /* One window shared by both AI endpoints, with a separate ceiling for
       each, because a chat turn costs far more tokens than a revision set. */
    function resolveRateLimits(env) {
        var warnings = [];

        var windowMs = readBounded(env, "AI_RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS, MIN_WINDOW_MS, MAX_WINDOW_MS, warnings);
        var chatMax = readBounded(env, "CHAT_RATE_LIMIT_MAX", DEFAULT_CHAT_MAX, MIN_RATE_LIMIT, MAX_RATE_LIMIT, warnings);
        var revisionMax = readBounded(env, "REVISION_RATE_LIMIT_MAX", DEFAULT_REVISION_MAX, MIN_RATE_LIMIT, MAX_RATE_LIMIT, warnings);

        return {
            windowMs: windowMs,
            chatMax: chatMax,
            revisionMax: revisionMax,
            warnings: warnings
        };
    }

    /* Client-facing debug output (a stack trace in an error response) is
       switched on only when the operator asks for it by name. An unset,
       blank or unrecognised NODE_ENV is treated as production, so a
       forgotten variable on a real host can never leak a stack trace.
       Local development still gets full detail by setting:
           NODE_ENV=development
       Hosting platforms want the opposite, and expect no change here:
           NODE_ENV=production */
    function resolveDebugMode(env) {
        var text = readText(env, "NODE_ENV").toLowerCase();

        if (text === "development" || text === "dev" || text === "debug") {
            return { debug: true, name: text };
        }

        return { debug: false, name: text || "not set" };
    }

    return {
        DEFAULT_PORT: DEFAULT_PORT,
        DEFAULT_HOST: DEFAULT_HOST,
        DEFAULT_TRUST_PROXY_HOPS: DEFAULT_TRUST_PROXY_HOPS,
        DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
        DEFAULT_CHAT_MAX: DEFAULT_CHAT_MAX,
        DEFAULT_REVISION_MAX: DEFAULT_REVISION_MAX,

        resolvePort: resolvePort,
        resolveHost: resolveHost,
        resolveTrustProxy: resolveTrustProxy,
        resolveRateLimits: resolveRateLimits,
        resolveDebugMode: resolveDebugMode
    };
});
