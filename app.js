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

/* In-memory state (single source of truth while the page lives). */
let chatMessages = [];
let chatIsSending = false;
let chatSendTimestamps = [];

let chatDomReady = false;
let chatInputEl = null;
let chatMessagesEl = null;
let chatSendButtonEl = null;


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
   3. Rendering (plain text only — textContent, never innerHTML)
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

    /* textContent keeps every message inert — no HTML is ever interpreted. */
    bubble.textContent = content;

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

        return;
    }

    for (const message of chatMessages) {
        appendChatBubble(message.role, message.content);
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
}

/* Shows an error state. If the pending "thinking" bubble is still on screen it
   is reused rather than leaving a stale placeholder above the error. */
function showChatError(message, pendingBubble) {
    if (pendingBubble) {
        pendingBubble.className = "message bot error";
        pendingBubble.textContent = message;
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
   4. Sending
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
            thinkingBubble.textContent = answer;
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
   5. Wiring
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