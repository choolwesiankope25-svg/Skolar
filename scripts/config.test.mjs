import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ServerConfig = require("../server-config.js");

const serverSource = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");


/* ============================================================
   PORT - provided by the hosting platform, 3000 locally
   ============================================================ */

test("PORT falls back to 3000 when the environment has none", () => {
    const resolved = ServerConfig.resolvePort({});

    assert.equal(resolved.port, 3000);
    assert.deepEqual(resolved.warnings, []);
});

test("PORT falls back to 3000 when the environment object is missing", () => {
    assert.equal(ServerConfig.resolvePort().port, 3000);
    assert.equal(ServerConfig.resolvePort(null).port, 3000);
});

test("PORT from the environment is used as-is", () => {
    assert.equal(ServerConfig.resolvePort({ PORT: "8080" }).port, 8080);
    assert.equal(ServerConfig.resolvePort({ PORT: "10000" }).port, 10000);
    assert.equal(ServerConfig.resolvePort({ PORT: "1" }).port, 1);
    assert.equal(ServerConfig.resolvePort({ PORT: "65535" }).port, 65535);
});

test("PORT tolerates surrounding whitespace and numeric values", () => {
    assert.equal(ServerConfig.resolvePort({ PORT: " 8080 " }).port, 8080);
    assert.equal(ServerConfig.resolvePort({ PORT: 8080 }).port, 8080);
});

test("an empty PORT is treated as unset, not as an error", () => {
    const resolved = ServerConfig.resolvePort({ PORT: "" });

    assert.equal(resolved.port, 3000);
    assert.deepEqual(resolved.warnings, []);
});

test("an unusable PORT falls back to 3000 and says why", () => {
    for (const bad of ["abc", "3000px", "0", "-1", "65536", "3000.5"]) {
        const resolved = ServerConfig.resolvePort({ PORT: bad });

        assert.equal(resolved.port, 3000, "bad PORT " + JSON.stringify(bad) + " must fall back");
        assert.equal(resolved.warnings.length, 1, "bad PORT " + JSON.stringify(bad) + " must warn");
        assert.ok(resolved.warnings[0].includes("PORT"));
    }
});


/* ============================================================
   HOST - all interfaces by default, which every container host needs
   ============================================================ */

test("HOST defaults to 0.0.0.0 so a container host can route to it", () => {
    assert.equal(ServerConfig.resolveHost({}).host, "0.0.0.0");
    assert.equal(ServerConfig.resolveHost({ HOST: "   " }).host, "0.0.0.0");
});

test("HOST can be overridden for a local-only bind", () => {
    assert.equal(ServerConfig.resolveHost({ HOST: "127.0.0.1" }).host, "127.0.0.1");
    assert.equal(ServerConfig.resolveHost({ HOST: "::" }).host, "::");
});

test("a nonsense HOST falls back to 0.0.0.0", () => {
    const resolved = ServerConfig.resolveHost({ HOST: "not a host" });

    assert.equal(resolved.host, "0.0.0.0");
    assert.equal(resolved.warnings.length, 1);
    assert.ok(resolved.warnings[0].includes("HOST"));
});


/* ============================================================
   TRUST_PROXY - a hop count only, never "true"
   ============================================================ */

test("TRUST_PROXY defaults to zero hops, so headers are ignored", () => {
    assert.equal(ServerConfig.resolveTrustProxy({}).hops, 0);
    assert.equal(ServerConfig.resolveTrustProxy({ TRUST_PROXY: "" }).hops, 0);
    assert.equal(ServerConfig.resolveTrustProxy({ TRUST_PROXY: "0" }).hops, 0);
});

test("TRUST_PROXY accepts the number of proxy hops", () => {
    assert.equal(ServerConfig.resolveTrustProxy({ TRUST_PROXY: "1" }).hops, 1);
    assert.equal(ServerConfig.resolveTrustProxy({ TRUST_PROXY: "2" }).hops, 2);
});

test("TRUST_PROXY refuses the blanket \"true\" setting, which would trust any client header", () => {
    const resolved = ServerConfig.resolveTrustProxy({ TRUST_PROXY: "true" });

    assert.equal(resolved.hops, 0);
    assert.equal(resolved.warnings.length, 1);
    assert.ok(resolved.warnings[0].includes("TRUST_PROXY"));
});

test("TRUST_PROXY refuses an unrealistic hop count", () => {
    assert.equal(ServerConfig.resolveTrustProxy({ TRUST_PROXY: "99" }).hops, 0);
    assert.equal(ServerConfig.resolveTrustProxy({ TRUST_PROXY: "1.5" }).hops, 0);
});


/* ============================================================
   AI rate limits
   ============================================================ */

test("rate limits default to a one-minute window with a ceiling per endpoint", () => {
    const limits = ServerConfig.resolveRateLimits({});

    assert.equal(limits.windowMs, 60000);
    assert.equal(limits.chatMax, 10);
    assert.equal(limits.revisionMax, 5);
    assert.deepEqual(limits.warnings, []);
});

test("rate limits can be configured from the environment", () => {
    const limits = ServerConfig.resolveRateLimits({
        AI_RATE_LIMIT_WINDOW_MS: "30000",
        CHAT_RATE_LIMIT_MAX: "3",
        REVISION_RATE_LIMIT_MAX: "2"
    });

    assert.equal(limits.windowMs, 30000);
    assert.equal(limits.chatMax, 3);
    assert.equal(limits.revisionMax, 2);
    assert.deepEqual(limits.warnings, []);
});

test("an unusable rate limit value falls back to its default and warns", () => {
    const limits = ServerConfig.resolveRateLimits({
        AI_RATE_LIMIT_WINDOW_MS: "soon",
        CHAT_RATE_LIMIT_MAX: "0",
        REVISION_RATE_LIMIT_MAX: "-3"
    });

    assert.equal(limits.windowMs, 60000);
    assert.equal(limits.chatMax, 10);
    assert.equal(limits.revisionMax, 5);
    assert.equal(limits.warnings.length, 3);
});

test("a rate window shorter than a second is refused", () => {
    const limits = ServerConfig.resolveRateLimits({ AI_RATE_LIMIT_WINDOW_MS: "500" });

    assert.equal(limits.windowMs, 60000);
    assert.equal(limits.warnings.length, 1);
});


/* ============================================================
   server.mjs wiring

   Express is not installed in the test environment, so these are
   source-level assertions in the same spirit as journal-nav.test.mjs
   reading index.html: they prove the port, the limiter order and the
   trust-proxy guard are wired, not that HTTP works. The middleware
   contract itself is exercised in rate-limit.test.mjs.
   ============================================================ */

test("server.mjs takes its port and host from the environment", () => {
    assert.ok(serverSource.includes("serverConfig.resolvePort(process.env)"));
    assert.ok(serverSource.includes("serverConfig.resolveHost(process.env)"));
    assert.ok(serverSource.includes("app.listen(PORT, HOST"));
    assert.ok(!/const\s+PORT\s*=\s*3000\s*;/.test(serverSource), "the port must not be hardcoded");
});

test("rate limiters are registered before body parsing and before the AI handlers", () => {
    const chatLimitAt = serverSource.indexOf('app.use("/chat", chatLimiter)');
    const revisionLimitAt = serverSource.indexOf('app.use("/revision", revisionLimiter)');
    const jsonAt = serverSource.indexOf("app.use(express.json())");
    const chatRouteAt = serverSource.indexOf('app.post("/chat"');
    const revisionRouteAt = serverSource.indexOf('app.post("/revision"');

    assert.ok(chatLimitAt !== -1, "the chat limiter must be attached");
    assert.ok(revisionLimitAt !== -1, "the revision limiter must be attached");
    assert.ok(chatLimitAt < jsonAt, "the chat limiter must run before the body is parsed");
    assert.ok(revisionLimitAt < jsonAt, "the revision limiter must run before the body is parsed");
    assert.ok(chatLimitAt < chatRouteAt, "the chat limiter must run before the chat handler");
    assert.ok(revisionLimitAt < revisionRouteAt, "the revision limiter must run before the revision handler");
});

test("trust proxy is only enabled from an explicit hop count", () => {
    assert.ok(serverSource.includes("serverConfig.resolveTrustProxy(process.env)"));
    assert.ok(serverSource.includes('app.set("trust proxy", proxyConfig.hops)'));
    assert.ok(/if\s*\(\s*proxyConfig\.hops\s*>\s*0\s*\)/.test(serverSource), "the trust proxy call must be guarded");
    assert.ok(!/trust proxy",\s*true/.test(serverSource), "trust proxy must never be enabled blindly");
});

test("startup logging never prints the API key", () => {
    const logLines = serverSource
        .split("\n")
        .filter(line => line.includes("console.log"));

    for (const line of logLines) {
        assert.ok(!line.includes("${process.env.GROQ_API_KEY}"), "the key value must never be interpolated into a log");
        assert.ok(!line.includes("Authorization"), "auth headers must never be logged");
        assert.ok(!line.includes("Bearer"), "bearer tokens must never be logged");
    }
});

test("request bodies are never logged", () => {
    assert.ok(!/console\.log\([^)]*req\.body/.test(serverSource));
    assert.ok(!/console\.error\([^)]*req\.body/.test(serverSource));
});


test("debug output stays off unless development is asked for by name", () => {
    for (const value of [undefined, "", "   ", "production", "Production", "staging", "test", "prod"]) {
        const env = value === undefined ? {} : { NODE_ENV: value };

        assert.equal(ServerConfig.resolveDebugMode(env).debug, false,
            "NODE_ENV " + JSON.stringify(value) + " must not send stack traces");
    }
});

test("development is requested explicitly and still works", () => {
    for (const value of ["development", "Development", " dev ", "debug"]) {
        const resolved = ServerConfig.resolveDebugMode({ NODE_ENV: value });

        assert.equal(resolved.debug, true, value + " should enable local debugging");
    }
});

test("static files are served from an allowlist, not from the project folder", () => {
    assert.ok(serverSource.includes("httpSafety.createStaticGuard()"));
    assert.ok(serverSource.includes('app.use(express.static(".", { dotfiles: "deny" }))'));
    assert.ok(!/express\.static\("\."\)\s*\)/.test(serverSource),
        "the project folder must not be served wholesale");

    const guardAt = serverSource.indexOf("app.use(staticGuard)");
    const jsonAt = serverSource.indexOf("app.use(express.json())");
    const staticAt = serverSource.indexOf('app.use(express.static(".", { dotfiles: "deny" }))');

    assert.ok(guardAt !== -1);
    assert.ok(jsonAt < guardAt, "the guard belongs after the API middleware");
    assert.ok(guardAt < staticAt, "the guard must run before the static middleware");
});

test("the error handler is mounted last and knows the production flag", () => {
    assert.ok(serverSource.includes("serverConfig.resolveDebugMode(process.env)"));
    assert.ok(serverSource.includes("isProduction: !debugConfig.debug"));

    const handlerAt = serverSource.indexOf("app.use(errorHandler)");
    const chatRouteAt = serverSource.indexOf('app.post("/chat"');
    const revisionRouteAt = serverSource.indexOf('app.post("/revision"');
    const listenAt = serverSource.indexOf("app.listen(");

    assert.ok(handlerAt > chatRouteAt && handlerAt > revisionRouteAt,
        "the error handler must come after the routes");
    assert.ok(handlerAt < listenAt, "and before the server starts listening");
});

test("the framework version banner is switched off", () => {
    assert.ok(serverSource.includes('app.disable("x-powered-by")'));
});

test("package.json declares the Node version Express 5 needs", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    assert.ok(pkg.engines && pkg.engines.node, "engines.node must be declared");
    assert.match(pkg.engines.node, />=?1[89]|>=(2\d)/, "Express 5 needs Node 18 or newer");
    assert.equal(pkg.scripts.start, "node server.mjs");
});
