import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const RateLimit = require("../rate-limit.js");


/* ============================================================
   Test doubles

   The limiter is written as a plain Express middleware, so it only
   needs req, res and next. These stand-ins let the ordering be tested
   without installing Express: next() stands in for "run the route
   handler", which is the code path that calls Groq.
   ============================================================ */

function makeResponse() {
    return {
        statusCode: null,
        headers: {},
        body: null,

        status(code) {
            this.statusCode = code;
            return this;
        },

        set(name, value) {
            this.headers[String(name).toLowerCase()] = value;
            return this;
        },

        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

function makeRequest(options) {
    const settings = options || {};
    const req = {
        socket: {
            remoteAddress: settings.socketIp === undefined ? "203.0.113.7" : settings.socketIp
        },
        headers: settings.headers || {}
    };

    if ("ip" in settings) {
        req.ip = settings.ip;
    }

    return req;
}

/* Mirrors Express: the next middleware (here, the AI call) runs only
   when the limiter calls next(). Returns whether it was reached. */
function send(middleware, req, res, onAllowed) {
    let reached = false;

    middleware(req, res, () => {
        reached = true;

        if (onAllowed) {
            onAllowed();
        }
    });

    return reached;
}

function fixedClock(start) {
    let current = start;

    return {
        now: () => current,
        advance: ms => { current += ms; }
    };
}


/* ============================================================
   Defaults and the normal path
   ============================================================ */

test("the limiter has a sensible default ceiling and window", () => {
    const limiter = RateLimit.createRateLimiter();

    assert.equal(limiter.limit, 10);
    assert.equal(limiter.windowMs, 60000);
});

test("requests under the ceiling pass straight through", () => {
    const limiter = RateLimit.createRateLimiter({ max: 3, windowMs: 60000 });
    let allowed = 0;

    for (let i = 0; i < 3; i++) {
        const res = makeResponse();

        assert.equal(send(limiter, makeRequest(), res, () => { allowed += 1; }), true);
        assert.equal(res.statusCode, null, "an allowed request must not be answered here");
        assert.equal(res.body, null);
    }

    assert.equal(allowed, 3);
});


/* ============================================================
   Over the ceiling
   ============================================================ */

test("the request after the ceiling gets 429 instead of reaching the handler", () => {
    const limiter = RateLimit.createRateLimiter({ max: 2, windowMs: 60000 });
    const req = makeRequest();

    send(limiter, req, makeResponse());
    send(limiter, req, makeResponse());

    const res = makeResponse();

    assert.equal(send(limiter, req, res), false, "next() must not be called");
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, "rate_limited");
    assert.equal(res.body.error, RateLimit.TOO_MANY_MESSAGE);
});

test("an over-limit request never reaches the AI call", () => {
    const limiter = RateLimit.createRateLimiter({ max: 2, windowMs: 60000 });
    const req = makeRequest();
    let aiCalls = 0;

    for (let i = 0; i < 6; i++) {
        send(limiter, req, makeResponse(), () => { aiCalls += 1; });
    }

    assert.equal(aiCalls, 2, "only the requests inside the allowance may call the provider");
});

test("the 429 body carries no internal detail", () => {
    const limiter = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });
    const req = makeRequest({ socketIp: "198.51.100.42", headers: { "x-student-id": "secret" } });

    send(limiter, req, makeResponse());

    const res = makeResponse();
    send(limiter, req, res);

    assert.deepEqual(Object.keys(res.body).sort(), ["code", "error"]);
    assert.ok(!JSON.stringify(res.body).includes("198.51.100.42"), "the client address must not leak");
    assert.ok(!JSON.stringify(res.body).includes("secret"), "request headers must not leak");
    assert.ok(!/\d/.test(res.body.error), "the message must not reveal limit or window values");
});

test("the 429 advertises how long to wait", () => {
    const clock = fixedClock(1700000000000);
    const limiter = RateLimit.createRateLimiter({ max: 1, windowMs: 60000, now: clock.now });
    const req = makeRequest();

    send(limiter, req, makeResponse());

    const res = makeResponse();
    send(limiter, req, res);

    assert.equal(res.headers["retry-after"], "60");

    clock.advance(45000);

    const later = makeResponse();
    send(limiter, req, later);

    assert.equal(later.headers["retry-after"], "15");
});


/* ============================================================
   Window expiry and independence
   ============================================================ */

test("the allowance returns once the window has passed", () => {
    const clock = fixedClock(1700000000000);
    const limiter = RateLimit.createRateLimiter({ max: 2, windowMs: 60000, now: clock.now });
    const req = makeRequest();

    assert.equal(send(limiter, req, makeResponse()), true);
    assert.equal(send(limiter, req, makeResponse()), true);
    assert.equal(send(limiter, req, makeResponse()), false, "blocked inside the window");

    clock.advance(60000);

    assert.equal(send(limiter, req, makeResponse()), true, "allowed again in the next window");
});

test("each endpoint keeps its own allowance", () => {
    const chat = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });
    const revision = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });
    const req = makeRequest();

    assert.equal(send(chat, req, makeResponse()), true);
    assert.equal(send(chat, req, makeResponse()), false, "chat is spent");
    assert.equal(send(revision, req, makeResponse()), true, "revision is unaffected by chat");
});

test("clients are counted separately", () => {
    const limiter = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });

    assert.equal(send(limiter, makeRequest({ socketIp: "203.0.113.1" }), makeResponse()), true);
    assert.equal(send(limiter, makeRequest({ socketIp: "203.0.113.1" }), makeResponse()), false);
    assert.equal(send(limiter, makeRequest({ socketIp: "203.0.113.2" }), makeResponse()), true);
});


/* ============================================================
   Which header is believed
   ============================================================ */

test("a spoofed X-Forwarded-For cannot reset the counter", () => {
    const limiter = RateLimit.createRateLimiter({ max: 2, windowMs: 60000 });
    let blocked = 0;

    for (let i = 0; i < 5; i++) {
        const req = makeRequest({
            socketIp: "203.0.113.7",
            headers: { "x-forwarded-for": "10.0.0." + i }
        });

        assert.equal(limiter.keyFor(req), "203.0.113.7", "the socket address is the key");

        const res = makeResponse();
        send(limiter, req, res);

        if (res.statusCode === 429) {
            blocked += 1;
        }
    }

    assert.equal(blocked, 3, "changing the header must not buy more requests");
});

test("req.ip is used only when trust proxy is configured", () => {
    const behindProxy = RateLimit.createRateLimiter({ max: 1, windowMs: 60000, trustProxy: true });
    const direct = RateLimit.createRateLimiter({ max: 1, windowMs: 60000, trustProxy: false });

    const first = makeRequest({ ip: "203.0.113.50", socketIp: "10.0.0.1" });
    const second = makeRequest({ ip: "203.0.113.51", socketIp: "10.0.0.1" });

    assert.equal(send(behindProxy, first, makeResponse()), true);
    assert.equal(send(behindProxy, first, makeResponse()), false, "same client is limited");
    assert.equal(send(behindProxy, second, makeResponse()), true, "a different client is not");

    /* Without trust proxy the socket address wins even when req.ip exists. */
    assert.equal(send(direct, first, makeResponse()), true);
    assert.equal(send(direct, second, makeResponse()), false, "both share the proxy socket address");
});

test("IPv4 and IPv4-mapped IPv6 addresses are one client", () => {
    const limiter = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });

    assert.equal(RateLimit.normaliseAddress("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(RateLimit.normaliseAddress("203.0.113.7"), "203.0.113.7");

    assert.equal(send(limiter, makeRequest({ socketIp: "::ffff:203.0.113.7" }), makeResponse()), true);
    assert.equal(send(limiter, makeRequest({ socketIp: "203.0.113.7" }), makeResponse()), false);
});

test("IPv6 loopback and IPv4 loopback are one client", () => {
    assert.equal(RateLimit.normaliseAddress("::1"), "127.0.0.1");
    assert.equal(RateLimit.normaliseAddress("FE80::1%eth0"), "fe80::1");
});

test("requests with no address share a single bucket rather than going unlimited", () => {
    const limiter = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });

    assert.equal(RateLimit.normaliseAddress(undefined), RateLimit.UNKNOWN_CLIENT);

    assert.equal(send(limiter, makeRequest({ socketIp: undefined }), makeResponse()), true);
    assert.equal(send(limiter, makeRequest({ socketIp: undefined }), makeResponse()), false);
});


/* ============================================================
   Memory stays bounded
   ============================================================ */

test("tracked clients are capped so a flood of addresses cannot grow the map", () => {
    const clock = fixedClock(1700000000000);
    const limiter = RateLimit.createRateLimiter({ max: 5, windowMs: 60000, maxClients: 3, now: clock.now });

    for (let i = 0; i < 50; i++) {
        send(limiter, makeRequest({ socketIp: "198.51.100." + i }), makeResponse());

        assert.ok(limiter.trackedClients() <= 3, "the map must stay inside its cap");
    }
});

test("expired buckets are dropped instead of accumulating", () => {
    const clock = fixedClock(1700000000000);
    const limiter = RateLimit.createRateLimiter({ max: 5, windowMs: 1000, maxClients: 2, now: clock.now });

    send(limiter, makeRequest({ socketIp: "198.51.100.1" }), makeResponse());
    send(limiter, makeRequest({ socketIp: "198.51.100.2" }), makeResponse());

    clock.advance(5000);

    send(limiter, makeRequest({ socketIp: "198.51.100.3" }), makeResponse());

    assert.ok(limiter.trackedClients() <= 2);
});

test("reset clears every counter", () => {
    const limiter = RateLimit.createRateLimiter({ max: 1, windowMs: 60000 });
    const req = makeRequest();

    send(limiter, req, makeResponse());
    assert.equal(limiter.trackedClients(), 1);

    limiter.reset();

    assert.equal(limiter.trackedClients(), 0);
    assert.equal(send(limiter, req, makeResponse()), true);
});
