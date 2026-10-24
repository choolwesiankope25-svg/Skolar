/* ============================================================
   Skolar — per-client AI rate limiting

   The Groq key is shared by everyone using the deployment, so one
   client looping /chat can spend the whole token budget and take the
   app away from every other student. This module stops that in front
   of the provider call.

   HOW IT WORKS
     A fixed window per client: the first request in a window creates
     a counter, later requests increment it, and once the counter
     passes the ceiling the middleware answers 429 without calling
     next(), so the route handler - and therefore callGroq() - never
     runs.

   WHO THE CLIENT IS
     By default the key is the TCP peer address from req.socket.remoteAddress.
     Request headers are never consulted, so a client cannot reset its
     own counter by sending a header. Only when the operator sets
     TRUST_PROXY to the real number of proxy hops does the middleware
     use req.ip, which Express derives from X-Forwarded-For according
     to that hop count. Setting TRUST_PROXY higher than the true number
     of proxies would make the header forgeable again, so it must match
     the deployment.

   KNOWN LIMITATIONS (deliberate, and worth stating plainly)
     - Counters live in this process's memory. They reset every time the
       server restarts or redeploys, so a client gets a fresh allowance
       after each deploy.
     - Nothing is shared between instances. With two or more servers
       behind a load balancer, each instance counts separately, so the
       effective ceiling is the configured limit times the number of
       instances. Fixing that needs shared storage, which is exactly the
       database this project does not have and does not need yet.
     - The map is capped at maxClients entries and expired buckets are
       dropped, so a flood of distinct addresses cannot grow memory
       without bound. Evicting a bucket does let that client start its
       window again, which is the trade for staying predictable in a
       single process.
     - It is a blunt deterrent against a single noisy client, not a
       defence against a distributed attack.
     - IPv6 addresses are compared exactly. A client that can rotate
       addresses inside its own /64 has more than one bucket.
   ============================================================ */

(function (root, factory) {
    var api = factory();

    if (typeof module === "object" && module && module.exports) {
        module.exports = api;
    }

    if (root && typeof root === "object") {
        root.SkolarRateLimit = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /* Shown to the student as-is by app.js, which recognises the
       "rate_limited" code and adds "Your question is still in the box".
       It names no internal detail, no limit value and no address. */
    var TOO_MANY_MESSAGE = "Too many AI requests from this device. Please wait a moment and try again.";

    var UNKNOWN_CLIENT = "unknown";

    var DEFAULT_MAX = 10;
    var DEFAULT_WINDOW_MS = 60000;
    var DEFAULT_MAX_CLIENTS = 10000;

    function boundedInteger(value, fallback, minimum, maximum) {
        var number = typeof value === "number" ? value : Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        var rounded = Math.round(number);

        if (rounded < minimum) {
            return minimum;
        }

        if (rounded > maximum) {
            return maximum;
        }

        return rounded;
    }

    /* "::ffff:127.0.0.1" and "127.0.0.1" are the same client, and IPv6
       addresses compare case-insensitively. A missing address becomes one
       shared bucket, which fails closed rather than leaving a hole. */
    function normaliseAddress(address) {
        if (typeof address !== "string") {
            return UNKNOWN_CLIENT;
        }

        var text = address.trim();

        if (!text) {
            return UNKNOWN_CLIENT;
        }

        var zone = text.indexOf("%");

        if (zone !== -1) {
            text = text.slice(0, zone);
        }

        if (text.indexOf("::ffff:") === 0) {
            text = text.slice(7);
        }

        text = text.toLowerCase();

        /* IPv4 and IPv6 loopback are the same machine. */
        if (text === "::1") {
            return "127.0.0.1";
        }

        return text;
    }

    /* options: { max, windowMs, trustProxy, maxClients, now } */
    function createRateLimiter(options) {
        var settings = options || {};

        var max = boundedInteger(settings.max, DEFAULT_MAX, 1, 1000000);
        var windowMs = boundedInteger(settings.windowMs, DEFAULT_WINDOW_MS, 1, 86400000);
        var maxClients = boundedInteger(settings.maxClients, DEFAULT_MAX_CLIENTS, 1, 1000000);
        var trustProxy = settings.trustProxy === true;
        var now = typeof settings.now === "function" ? settings.now : function () { return Date.now(); };

        var buckets = new Map();

        function keyFor(req) {
            if (trustProxy && req && typeof req.ip === "string" && req.ip) {
                return normaliseAddress(req.ip);
            }

            if (req && req.socket && typeof req.socket.remoteAddress === "string") {
                return normaliseAddress(req.socket.remoteAddress);
            }

            return UNKNOWN_CLIENT;
        }

        function dropExpired(current) {
            buckets.forEach(function (bucket, key) {
                if (bucket.resetAt <= current) {
                    buckets.delete(key);
                }
            });
        }

        /* Keeps memory bounded. Only runs when the cap is reached. */
        function makeRoom(current) {
            if (buckets.size < maxClients) {
                return;
            }

            dropExpired(current);

            while (buckets.size >= maxClients) {
                var oldest = buckets.keys().next();

                if (oldest.done) {
                    return;
                }

                buckets.delete(oldest.value);
            }
        }

        function respondTooMany(res, retryAfterSeconds) {
            if (typeof res.set === "function") {
                res.set("Retry-After", String(retryAfterSeconds));
            } else if (typeof res.setHeader === "function") {
                res.setHeader("Retry-After", String(retryAfterSeconds));
            }

            /* Only a message the student can act on. No limit config, no
               address, no request body. */
            res.status(429).json({
                error: TOO_MANY_MESSAGE,
                code: "rate_limited"
            });
        }

        function middleware(req, res, next) {
            var current = now();

            makeRoom(current);

            var key = keyFor(req);
            var bucket = buckets.get(key);

            if (!bucket || bucket.resetAt <= current) {
                bucket = { count: 0, resetAt: current + windowMs };
                buckets.set(key, bucket);
            }

            bucket.count += 1;

            if (bucket.count > max) {
                respondTooMany(res, Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)));
                return;
            }

            next();
        }

        middleware.keyFor = keyFor;
        middleware.limit = max;
        middleware.windowMs = windowMs;
        middleware.trackedClients = function () { return buckets.size; };
        middleware.reset = function () { buckets.clear(); };

        return middleware;
    }

    return {
        TOO_MANY_MESSAGE: TOO_MANY_MESSAGE,
        UNKNOWN_CLIENT: UNKNOWN_CLIENT,

        normaliseAddress: normaliseAddress,
        createRateLimiter: createRateLimiter
    };
});
