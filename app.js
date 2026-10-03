/* ============================================================
   Skolar — Chat client (app.js)

   Responsibilities:
     1. Maintain the conversation in memory + localStorage
        under CHAT_HISTORY_KEY, so follow-ups such as
        "explain that again" or "make it simpler" work.
     2. Build a compact, derived Study context from the
        existing Phase 1 Study data (courses / topics /
        assessments / sessions / timetable).
     3. POST { message, history, studyContext } to /chat.

   Notes:
     * The conversation lives in localStorage, NOT in the DOM,
       so it survives the Study pages (which replace
       document.body.innerHTML) and can be re-rendered whenever
       the Home page is shown again.
     * No secret is ever stored or read here. The Groq API key
       lives only on the server.
   ============================================================ */

const CHAT_HISTORY_KEY = "skolar.chatHistory";
const CHAT_GREETING = "Hey 👋 I'm Skolar. What are we working on today?";

/* ---- client-side limits ---- */
const CHAT_MAX_MESSAGE_LENGTH = 2000;      /* characters per student message     */
const CHAT_MAX_HISTORY_MESSAGES = 40;     /* turns kept in memory + storage     */
const CHAT_MAX_STORED_LENGTH = 8000;       /* per stored message, corruption guard */
const CHAT_MAX_SENDS_IN_WINDOW = 5;       /* rate guard: sends per CHAT_RATE_WINDOW_MS */
const CHAT_RATE_WINDOW_MS = 10000;         /* ... within this many milliseconds      */
const CHAT_REQUEST_TIMEOUT_MS = 45000;

/* ---- Study context compaction limits ---- */
const CONTEXT_MAX_COURSES = 15;
const CONTEXT_MAX_TOTAL_TOPICS = 60;
const CONTEXT_MAX_NEEDS_REVISION = 15;
const CONTEXT_MAX_ASSESSMENTS = 8;
const CONTEXT_MAX_TODAY_SESSIONS = 8;
const CONTEXT_MAX_UPCOMING_SESSIONS = 8;
const CONTEXT_MAX_CLASSES_PER_DAY = 5;
const CONTEXT_MAX_TIMETABLE_DAYS = 7;

const CHAT_ROLES = ["user", "assistant"];

/* ---- rich text (safe Markdown rendering) limits ---- */
const RICH_MAX_LENGTH = 20000;   /* hard cap on rendered characters */
const RICH_MAX_NODES = 400;      /* hard cap on created elements   */
const RICH_MAX_DEPTH = 3;        /* nested inline emphasis levels  */

const RICH_FENCE = /^\s*```\s*([A-Za-z0-9_+#-]*)\s*$/;
const RICH_FENCE_END = /^\s*```\s*$/;
const RICH_BULLET = /^\s*[-*+]\s+(.*)$/;
const RICH_NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RICH_ANY_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const RICH_INDENTED = /^\s{2,}\S/;

/* Ordered alternatives matter: fenced code, then code, then bold, then italic.
   Emphasis never spans a newline - without that guard a stray ** on one line
   pairs with one many lines later and swallows whole paragraphs.
   Stored as a source string and compiled per call, because a shared global
   regex is corrupted by the recursive calls below (lastIndex is state). */
const RICH_INLINE_SOURCE = "(`+)([^`\\n]+?)\\1|\\*\\*([^\\n]+?)\\*\\*|__([^\\n]+?)__|\\*([^*\\n]+?)\\*|_([^_\\n]+?)_";

/* In-memory state (single source of truth while the page lives). */
let chatMessages = [];
let chatIsSending = false;
let chatSendTimestamps = [];

const CHAT_STARTERS = [
    "What should I revise today?",
    "What's coming up this week?",
    "Explain a topic I'm stuck on",
    "I'm stressed about my exams"
];

let chatDomReady = false;
let chatInputEl = null;
let chatMessagesEl = null;
let chatSendButtonEl = null;
let chatStartersEl = null;
let chatNewChatEl = null;


/* ============================================================
   1. Conversation storage
   ============================================================ */

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/* Accepts only well-formed {role, content} turns. Anything else is dropped,
   so a corrupted localStorage entry can never crash the app. */
function sanitiseChatMessages(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const cleaned = [];

    for (const item of raw) {
        if (!isPlainObject(item)) {
            continue;
        }

        if (CHAT_ROLES.indexOf(item.role) === -1) {
            continue;
        }

        if (typeof item.content !== "string") {
            continue;
        }

        const content = item.content.replace(/\s+$/, "").slice(0, CHAT_MAX_STORED_LENGTH);

        if (!content.trim()) {
            continue;
        }

        cleaned.push({ role: item.role, content: content });
    }

    /* Keep the most recent turns. */
    return cleaned.slice(-CHAT_MAX_HISTORY_MESSAGES);
}

function loadChatHistory() {
    try {
        const raw = localStorage.getItem(CHAT_HISTORY_KEY);

        if (!raw) {
            return [];
        }

        return sanitiseChatMessages(JSON.parse(raw));

    } catch (error) {
        console.error(error);

        return [];
    }
}

function saveChatHistory() {
    try {
        localStorage.setItem(
            CHAT_HISTORY_KEY,
            JSON.stringify(chatMessages.slice(-CHAT_MAX_HISTORY_MESSAGES))
        );

        return true;

    } catch (error) {
        console.error(error);

        return false;
    }
}

function clearChatHistory() {
    chatMessages = [];

    try {
        localStorage.removeItem(CHAT_HISTORY_KEY);
    } catch (error) {
        console.error(error);
    }

    renderChat();
}


/* ============================================================
   2. Study context (derived, compact, no internal IDs)
   ============================================================ */

function contextIsoDate(timestamp) {
    const date = new Date(timestamp);

    if (isNaN(date.getTime())) {
        return null;
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return year + "-" + month + "-" + day;
}

function contextWeekday(timestamp) {
    const date = new Date(timestamp);

    if (isNaN(date.getTime())) {
        return null;
    }

    return date.toLocaleDateString("en-GB", { weekday: "long" });
}

function contextDaysUntil(timestamp) {
    if (isNaN(timestamp)) {
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const target = new Date(timestamp);
    target.setHours(0, 0, 0, 0);

    return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function contextName(value, maxLength) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim().slice(0, maxLength || 120);
}

function contextCourseName(courseId) {
    if (!courseId) {
        return "Unknown course";
    }

    try {
        const course = getCourseById(courseId);

        return course ? contextName(course.name) || "Unnamed course" : "Unknown course";

    } catch (error) {
        return "Unknown course";
    }
}

function contextTopicName(session) {
    if (!session || !session.topicId) {
        return "No topic selected";
    }

    try {
        return contextName(sessionTopicName(session), 100) || "No topic selected";

    } catch (error) {
        return "No topic selected";
    }
}

function contextTimeLabel(time) {
    return typeof time === "string" && /^\d{2}:\d{2}$/.test(time) ? time : "time not set";
}

function buildCoursesContext() {
    let courses = [];

    try {
        courses = loadCourses() || [];
    } catch (error) {
        return [];
    }

    const result = [];
    let topicBudget = CONTEXT_MAX_TOTAL_TOPICS;

    for (const course of courses.slice(0, CONTEXT_MAX_COURSES)) {
        let topics = [];

        try {
            topics = loadTopicsFor(course.id) || [];
        } catch (error) {
            topics = [];
        }

        const counts = {
            "Not Started": 0,
            "In Progress": 0,
            "Completed": 0,
            "Needs Revision": 0
        };

        const revision = [];
        const topicNames = [];

        for (const topic of topics) {
            const status = TOPIC_STATUSES.indexOf(topic.status) !== -1
                ? topic.status
                : "Not Started";

            counts[status] += 1;

            if (status === "Needs Revision") {
                const name = contextName(topic.name, 80);

                if (name && revision.length < 6) {
                    revision.push(name);
                }

                continue;
            }

            if (topicBudget > 0 && topicNames.length < 12) {
                const name = contextName(topic.name, 80);

                if (name) {
                    topicNames.push(name + " (" + status + ")");
                    topicBudget -= 1;
                }
            }
        }

        const entry = {
            name: contextName(course.name) || "Unnamed course",
            code: contextName(course.code, 30),
            topicCount: topics.length,
            completed: counts["Completed"],
            inProgress: counts["In Progress"],
            notStarted: counts["Not Started"],
            needsRevision: counts["Needs Revision"]
        };

        if (topicNames.length) {
            entry.topics = topicNames;
        }

        if (revision.length) {
            entry.needsRevisionTopics = revision;
        }

        result.push(entry);
    }

    return result;
}

function buildNeedsRevisionContext(courses) {
    const result = [];

    for (const course of courses) {
        const topics = course.needsRevisionTopics || [];

        for (const topic of topics) {
            if (result.length >= CONTEXT_MAX_NEEDS_REVISION) {
                return result;
            }

            result.push({ course: course.name, topic: topic });
        }
    }

    return result;
}

function buildAssessmentsContext() {
    let assessments = [];

    try {
        assessments = sortAssessments(loadAssessments() || []);

    } catch (error) {
        return [];
    }

    const now = Date.now();
    const result = [];

    for (const assessment of assessments) {
        if (result.length >= CONTEXT_MAX_ASSESSMENTS) {
            break;
        }

        const timestamp = assessmentTimestamp(assessment);

        if (isNaN(timestamp) || timestamp < now) {
            continue;
        }

        let countdown = { label: "" };

        try {
            countdown = countdownFor(assessment) || { label: "" };
        } catch (error) {
            countdown = { label: "" };
        }

        result.push({
            name: contextName(assessment.name) || "Untitled assessment",
            course: contextCourseName(assessment.courseId),
            type: contextName(assessment.type, 30),
            date: typeof assessment.date === "string" ? assessment.date.slice(0, 10) : "",
            time: assessment.time ? contextTimeLabel(assessment.time) : "",
            when: contextDaysUntil(timestamp) === 0 ? "today" : String(countdown.label || "")
        });
    }

    return result;
}

function sessionContextEntry(session) {
    return {
        course: contextCourseName(session.courseId),
        topic: contextTopicName(session),
        date: typeof session.date === "string" ? session.date.slice(0, 10) : "",
        time: contextTimeLabel(session.startTime),
        durationMinutes: sessionDurationMinutes(session)
    };
}

function buildSessionsContext() {
    let sessions = [];

    try {
        sessions = sortSessions(loadSessions() || []);

    } catch (error) {
        return { today: [], upcoming: [] };
    }

    const now = Date.now();
    const todayIso = contextIsoDate(now);
    const today = [];
    const upcoming = [];

    for (const session of sessions) {
        const timestamp = sessionTimestamp(session);

        if (isNaN(timestamp) || timestamp < now) {
            continue;
        }

        let isUpcoming = false;

        try {
            isUpcoming = sessionIsUpcoming(session, now);
        } catch (error) {
            isUpcoming = session.status === "Planned";
        }

        if (!isUpcoming) {
            continue;
        }

        if (typeof session.date === "string" && session.date.slice(0, 10) === todayIso) {
            if (today.length < CONTEXT_MAX_TODAY_SESSIONS) {
                today.push(sessionContextEntry(session));
            }

            continue;
        }

        if (upcoming.length < CONTEXT_MAX_UPCOMING_SESSIONS) {
            upcoming.push(sessionContextEntry(session));
        }
    }

    return { today: today, upcoming: upcoming };
}

function buildTimetableContext() {
    let entries = [];

    try {
        entries = loadTimetable() || [];

    } catch (error) {
        return [];
    }

    const todayName = contextWeekday(Date.now());
    const result = [];

    for (const day of TIMETABLE_DAYS) {
        if (result.length >= CONTEXT_MAX_TIMETABLE_DAYS) {
            break;
        }

        const dayEntries = entries
            .filter(item => item && item.day === day)
            .sort((a, b) => String(a.startTime || "").localeCompare(String(b.startTime || "")))
            .slice(0, CONTEXT_MAX_CLASSES_PER_DAY);

        if (!dayEntries.length) {
            continue;
        }

        result.push({
            day: day,
            isToday: day === todayName,
            classes: dayEntries.map(item => ({
                course: contextCourseName(item.courseId),
                startTime: contextTimeLabel(item.startTime),
                endTime: contextTimeLabel(item.endTime),
                room: contextName(item.room, 40)
            }))
        });
    }

    return result;
}

/* Builds the compact studyContext payload sent with every /chat request.
   Returns a plain, JSON-safe object containing no secrets and no internal IDs. */
function buildStudyContext() {
    let todaySessions = { today: [], upcoming: [] };
    let timetable = [];

    try {
        todaySessions = buildSessionsContext();
    } catch (error) {
        todaySessions = { today: [], upcoming: [] };
    }

    try {
        timetable = buildTimetableContext();
    } catch (error) {
        timetable = [];
    }

    const courses = buildCoursesContext();

    return {
        today: contextIsoDate(Date.now()),
        courses: courses,
        needsRevision: buildNeedsRevisionContext(courses),
        upcomingAssessments: buildAssessmentsContext(),
        todaySessions: todaySessions.today,
        upcomingSessions: todaySessions.upcoming,
        timetable: timetable
    };
}


/* ============================================================
   3. Rendering — safe rich text

   Messages arrive from the model as plain strings that often contain
   Markdown. We convert that Markdown into real DOM nodes so it renders
   as formatting instead of literal symbols.

   SAFETY MODEL
   -------------
   Every piece of message text - from the student and from the model -
   is treated as untrusted. Text is only ever placed into the document
   through document.createTextNode() or element.textContent, so message
   content can never become markup or execute. innerHTML is never used.
   ============================================================ */

function appendRichTextNode(target, text, budget) {
    if (!text) {
        return budget;
    }

    const parts = text.split("\n");

    for (let i = 0; i < parts.length; i++) {
        if (budget <= 0) {
            return budget;
        }

        if (i > 0) {
            target.appendChild(document.createElement("br"));
            budget -= 1;
        }

        if (parts[i]) {
            target.appendChild(document.createTextNode(parts[i]));
            budget -= 1;
        }
    }

    return budget;
}

function richIsWordChar(character) {
    return !!character && /[A-Za-z0-9]/.test(character);
}

/* True when emphasis content is padded with whitespace, which Markdown does
   not treat as emphasis - "a ** b ** c" must stay literal. */
function richIsPadded(content) {
    return !content || /^\s/.test(content) || /\s$/.test(content);
}

/* Renders `code`, **bold**, *italic* and single newlines into one parent.
   Anything that is not a confident match is emitted as literal text. */
function appendRichInline(parent, text, budget, depth) {
    const source = typeof text === "string" ? text : "";
    const level = depth || 0;

    if (level >= RICH_MAX_DEPTH) {
        return appendRichTextNode(parent, source, budget);
    }

    const pattern = new RegExp(RICH_INLINE_SOURCE, "g");

    let cursor = 0;
    let match;

    while (budget > 0 && (match = pattern.exec(source)) !== null) {
        let content = null;
        let tag = null;

        if (match[2] !== undefined) {
            content = match[2];
            tag = "code";
        } else if (match[3] !== undefined || match[4] !== undefined) {
            content = match[3] !== undefined ? match[3] : match[4];

            if (!richIsPadded(content)) {
                tag = "strong";
            }
        } else {
            content = match[5] !== undefined ? match[5] : match[6];
            const before = match.index > 0 ? source.charAt(match.index - 1) : "";
            const after = source.charAt(match.index + match[0].length);
            const intrawordUnderscore =
                match[6] !== undefined && (richIsWordChar(before) || richIsWordChar(after));

            if (!richIsPadded(content) && !intrawordUnderscore) {
                tag = "em";
            }
        }

        if (!tag) {
            /* Not confident - emit one literal character and rescan the rest. */
            budget = appendRichTextNode(parent, source.slice(cursor, match.index + 1), budget);
            cursor = match.index + 1;
            pattern.lastIndex = cursor;
            continue;
        }

        if (match.index > cursor) {
            budget = appendRichTextNode(parent, source.slice(cursor, match.index), budget);
        }

        const node = document.createElement(tag);

        if (tag === "code") {
            /* Code content is never re-parsed. */
            node.textContent = content;
        } else {
            budget = appendRichInline(node, content, budget, level + 1);
        }

        parent.appendChild(node);
        budget -= 1;

        cursor = match.index + match[0].length;
    }

    if (cursor < source.length) {
        budget = appendRichTextNode(parent, source.slice(cursor), budget);
    }

    return budget;
}

/* Renders a whole message into `target`, replacing nothing. */
function renderRichText(target, text) {
    if (!target) {
        return;
    }

    const source = typeof text === "string" ? text : "";
    const clipped = source.length > RICH_MAX_LENGTH
        ? source.slice(0, RICH_MAX_LENGTH)
        : source;

    let budget = RICH_MAX_NODES;
    const lines = clipped.split("\n");
    let i = 0;

    while (i < lines.length && budget > 0) {
        const line = lines[i];

        /* Fenced code block - preserved verbatim, never parsed as Markdown. */
        if (RICH_FENCE.test(line)) {
            const codeLines = [];
            i += 1;

            while (i < lines.length) {
                if (RICH_FENCE_END.test(lines[i])) {
                    i += 1;
                    break;
                }

                codeLines.push(lines[i]);
                i += 1;
            }

            const pre = document.createElement("pre");
            pre.className = "chat-code-block";

            const code = document.createElement("code");
            code.textContent = codeLines.join("\n");

            pre.appendChild(code);
            target.appendChild(pre);

            budget -= 2;
            continue;
        }

        if (!line.trim()) {
            i += 1;
            continue;
        }

        const bullet = RICH_BULLET.exec(line);
        const numbered = RICH_NUMBERED.exec(line);

        /* Consecutive list items share one list element. */
        if (bullet || numbered) {
            const ordered = !!numbered;
            const list = document.createElement(ordered ? "ol" : "ul");
            list.className = "chat-list " + (ordered ? "ordered" : "unordered");

            let lastItem = null;

            while (i < lines.length && budget > 0) {
                const nextBullet = RICH_BULLET.exec(lines[i]);
                const nextNumbered = RICH_NUMBERED.exec(lines[i]);
                const isMarker = ordered ? !!nextNumbered : !!nextBullet;

                if (isMarker) {
                    lastItem = document.createElement("li");
                    lastItem.className = "chat-list-item";
                    budget = appendRichInline(lastItem, (ordered ? nextNumbered : nextBullet)[1].trim(), budget);
                    list.appendChild(lastItem);
                    budget -= 1;
                    i += 1;
                    continue;
                }

                /* Indented, non-marker lines continue the previous item. */
                if (lastItem && !RICH_ANY_MARKER.test(lines[i]) && RICH_INDENTED.test(lines[i])) {
                    lastItem.appendChild(document.createTextNode(" "));
                    budget = appendRichInline(lastItem, lines[i].trim(), budget);
                    i += 1;
                    continue;
                }

                break;
            }

            target.appendChild(list);
            budget -= 1;
            continue;
        }

        /* Plain block - gather until a blank line, a fence or a list marker. */
        const paragraphLines = [];

        while (i < lines.length) {
            const current = lines[i];

            if (!current.trim()) { break; }
            if (current.indexOf("```") === 0) { break; }
            if (RICH_ANY_MARKER.test(current)) { break; }

            paragraphLines.push(current);
            i += 1;
        }

        if (!paragraphLines.length) {
            continue;
        }

        const paragraph = document.createElement("div");
        paragraph.className = "chat-paragraph";

        budget = appendRichInline(paragraph, paragraphLines.join("\n").trim(), budget);

        target.appendChild(paragraph);
        budget -= 1;
    }
}

function setRichText(target, text) {
    if (!target) {
        return;
    }

    target.replaceChildren();
    renderRichText(target, text);
}

/* ============================================================
   4. Chat DOM and bubbles
   ============================================================ */

function chatDom() {
    if (chatDomReady) {
        return chatMessagesEl && chatInputEl;
    }

    chatMessagesEl = document.getElementById("messages");
    chatInputEl = document.getElementById("userInput");
    chatSendButtonEl = chatMessagesEl
        ? chatMessagesEl.parentElement.querySelector(".chat-input-area button")
        : null;
    chatStartersEl = document.getElementById("chatStarters");
    chatNewChatEl = document.getElementById("newChatButton");

    chatDomReady = !!(chatMessagesEl && chatInputEl);

    return chatDomReady;
}

function scrollChatToBottom() {
    if (!chatMessagesEl) {
        return;
    }

    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function appendChatBubble(role, content, extraClass) {
    if (!chatMessagesEl) {
        return null;
    }

    const bubble = document.createElement("div");
    bubble.className = "message " + role + (extraClass ? " " + extraClass : "");

    /* Message content is never assigned as HTML - only as inert text nodes. */
    renderRichText(bubble, content);

    chatMessagesEl.appendChild(bubble);

    scrollChatToBottom();

    return bubble;
}

function renderChat() {
    if (!chatDom()) {
        return;
    }

    chatMessagesEl.textContent = "";

    if (!chatMessages.length) {
        appendChatBubble("bot", CHAT_GREETING);
        renderChatStarters();

        return;
    }

    renderChatStarters();

    for (const message of chatMessages) {
        appendChatBubble(message.role, message.content);
    }
}

/* Starters are a "here's where to begin" hint, so they exist only while the
   conversation is empty. They are rebuilt from scratch on every call, which
   makes repeated renders (and repeated New chat presses) idempotent rather
   than appending duplicates. */
function renderChatStarters() {
    if (!chatStartersEl) {
        return;
    }

    chatStartersEl.textContent = "";

    /* A real conversation - or a send already under way - means the student
       no longer needs the shortcuts. */
    if (chatMessages.length || chatIsSending) {
        chatStartersEl.hidden = true;

        return;
    }

    chatStartersEl.hidden = false;

    for (const starter of CHAT_STARTERS) {
        const button = document.createElement("button");

        button.type = "button";
        button.className = "chat-starter";
        button.textContent = starter;
        button.addEventListener("click", () => startChatFromStarter(starter));

        chatStartersEl.appendChild(button);
    }
}

/* Starters reuse the normal send path: the text goes through the input box
   so validation, rate limiting, Study context, history persistence, safety
   handling and rich-text rendering all behave exactly as they do for typed
   messages. */
function startChatFromStarter(text) {
    if (chatIsSending || !chatDom()) {
        return;
    }

    chatInputEl.value = text;

    sendMessage();
}

/* New chat never touches Study data - it clears the conversation key only.
   While a reply is in flight the control is disabled, because the pending
   request would otherwise write its reply back into the fresh conversation. */
function handleNewChat() {
    if (chatIsSending) {
        return;
    }

    /* renderChat() re-adds the greeting and the starters for the now-empty
       conversation, so there is nothing else to rebuild here. */
    clearChatHistory();
    clearChatInput();

    if (chatInputEl) {
        chatInputEl.focus();
    }
}

function setChatSending(sending) {
    if (chatSendButtonEl) {
        chatSendButtonEl.disabled = sending;
        chatSendButtonEl.textContent = sending ? "Sending…" : "Send";
    }

    if (chatInputEl) {
        chatInputEl.disabled = sending;
    }

    if (chatNewChatEl) {
        chatNewChatEl.disabled = sending;
    }

    renderChatStarters();
}

/* Shows an error state. If the pending "thinking" bubble is still on screen it
   is reused rather than leaving a stale placeholder above the error. */
function showChatError(message, pendingBubble) {
    if (pendingBubble) {
        pendingBubble.className = "message bot error";
        setRichText(pendingBubble, message);
        scrollChatToBottom();

        return;
    }

    appendChatBubble("bot", message, "error");
}

function chatRateLimited() {
    const now = Date.now();

    chatSendTimestamps = chatSendTimestamps.filter(
        stamp => now - stamp < CHAT_RATE_WINDOW_MS
    );

    if (chatSendTimestamps.length >= CHAT_MAX_SENDS_IN_WINDOW) {
        return true;
    }

    chatSendTimestamps.push(now);

    return false;
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, Object.assign({}, options, { signal: controller.signal }));

    } finally {
        clearTimeout(timer);
    }
}


/* ============================================================
   5. Sending
   ============================================================ */

function readChatInput() {
    if (!chatInputEl) {
        return "";
    }

    return chatInputEl.value.replace(/\s+$/, "");
}

function clearChatInput() {
    if (chatInputEl) {
        chatInputEl.value = "";
    }
}

async function sendMessage() {
    if (!chatDom()) {
        return;
    }

    if (chatIsSending) {
        return;
    }

    const text = readChatInput();

    if (!text.trim()) {
        return;
    }

    if (text.length > CHAT_MAX_MESSAGE_LENGTH) {
        showChatError(
            "That message is too long (" + text.length + " characters). " +
            "Please keep it under " + CHAT_MAX_MESSAGE_LENGTH + " characters."
        );

        return;
    }

    if (chatRateLimited()) {
        showChatError("You're sending messages very quickly. Give me a moment, then try again.");
        clearChatInput();

        return;
    }

    /* Snapshot history BEFORE adding the new turn, and only commit on success,
       so a failed request leaves the stored conversation untouched. */
    const previousMessages = chatMessages.slice();
    const history = previousMessages.map(message => ({
        role: message.role,
        content: message.content
    }));

    chatIsSending = true;
    setChatSending(true);

    appendChatBubble("user", text);
    clearChatInput();

    const thinkingBubble = appendChatBubble("bot", "Skolar is thinking…");

    /* If the request fails the typed text is put back so nothing is lost. */
    const restoreInputOnFailure = () => {
        if (chatInputEl && !chatInputEl.value) {
            chatInputEl.value = text;
        }
    };

    try {
        const response = await fetchWithTimeout("/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: text,
                history: history,
                studyContext: buildStudyContext()
            })
        }, CHAT_REQUEST_TIMEOUT_MS);

        let data = null;

        try {
            data = await response.json();
        } catch (parseError) {
            data = null;
        }

        if (!response.ok) {
            const reason = data && typeof data.error === "string" ? data.error : null;

            restoreInputOnFailure();

            showChatError(
                reason
                    ? "Skolar couldn't reply just now (" + reason + "). Your conversation is saved — please try again."
                    : "Skolar couldn't reply just now (error " + response.status + "). Your conversation is saved — please try again.",
                thinkingBubble
            );

            return;
        }

        const answer = data && typeof data.answer === "string"
            ? data.answer.trim()
            : "";

        if (!answer) {
            restoreInputOnFailure();

            showChatError("Skolar sent back an empty reply. Please try rephrasing that.", thinkingBubble);

            return;
        }

        chatMessages = previousMessages.concat([
            { role: "user", content: text },
            { role: "assistant", content: answer.slice(0, CHAT_MAX_STORED_LENGTH) }
        ]);

        saveChatHistory();

        if (thinkingBubble) {
            setRichText(thinkingBubble, answer);
        }

    } catch (error) {
        console.error(error);

        restoreInputOnFailure();

        showChatError(
            "I couldn't connect right now, so your conversation hasn't changed. Please try again.",
            thinkingBubble
        );

    } finally {
        chatIsSending = false;
        setChatSending(false);
        scrollChatToBottom();
    }
}


/* ============================================================
   6. Wiring
   ============================================================ */

function initChat() {
    chatMessages = loadChatHistory();

    if (!chatDom()) {
        return;
    }

    if (chatInputEl && !chatInputEl.getAttribute("maxlength")) {
        chatInputEl.setAttribute("maxlength", String(CHAT_MAX_MESSAGE_LENGTH));
    }

    if (chatInputEl && !chatInputEl.getAttribute("enterkeyhint")) {
        chatInputEl.setAttribute("enterkeyhint", "send");
    }

    if (chatNewChatEl && !chatNewChatEl.getAttribute("aria-label")) {
        chatNewChatEl.setAttribute("aria-label", "Start a new chat");
    }

    if (chatNewChatEl) {
        chatNewChatEl.addEventListener("click", handleNewChat);
    }

    chatInputEl.addEventListener("keydown", event => {
        if (event.isComposing) {
            return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    renderChat();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initChat);
} else {
    initChat();
}