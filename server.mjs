import express from "express";
import dotenv from "dotenv";
import dns from "dns"

dotenv.config();
dns.setDefaultResultOrder("ipv4first");

const app = express();

const PORT = 3000;

/* ============================================================
   Request limits - the browser is never trusted blindly.
   ============================================================ */
const MESSAGE_MAX_LENGTH = 4000;              /* latest user message   */
const HISTORY_MAX_MESSAGES = 40;             /* prior turns accepted  */
const HISTORY_MESSAGE_MAX_LENGTH = 4000;     /* per prior turn        */
const CONTEXT_MAX_SERIALISED_LENGTH = 12000; /* studyContext as JSON  */
const CONTEXT_MAX_DEPTH = 6;
const CONTEXT_MAX_ARRAY_ITEMS = 20;
const CONTEXT_MAX_STRING_LENGTH = 200;
const CONTEXT_MAX_KEYS_PER_OBJECT = 40;

const VALID_ROLES = ["user", "assistant"];

/* Strips control characters so prompt-shaped bytes cannot be smuggled in. */
const CONTROL_CHARS = new RegExp("[\\x00-\\x1f\\x7f]", "g");
const SAFE_KEY = new RegExp("^[A-Za-z][A-Za-z0-9_]{0,39}$");

const SYSTEM_PROMPT = "You are Skolar, a friendly and intelligent student support AI. Talk like a helpful senior student who genuinely wants the student to understand, not like a textbook or formal essay. Keep answers conversational, clear, practical, and reasonably concise. For simple questions, give a simple answer first and expand only when useful. When teaching academic topics, explain the idea in plain language, give a relatable example, and include an exam-ready definition or key points when appropriate. Break information into short paragraphs or simple bullet points. Do not overwhelm the student with unnecessary information. Do not use Markdown symbols such as **, ##, or ### because the chat interface displays plain text. Be calm, authentic, encouraging, and occasionally use light humour when it fits. Do not diagnose medical or mental health conditions. If the student describes distress, a crisis, self-harm, or anything that may be an emergency, do not diagnose and do not attempt to counsel them through it: respond calmly and with care, take it seriously, and encourage them to reach a qualified human - a doctor, counsellor, university wellbeing service, or a trusted person - right away, and suggest emergency services if it is urgent. If you are unsure of something, say so rather than making it up.\n\n" +
    "You have been given a STUDY CONTEXT section describing the student's own Skolar data (their courses, topics, assessments, study sessions and timetable). Use it when it is relevant to the question - for example when they ask what to revise, what is coming up, or what to focus on today. Only refer to items that actually appear in that section, and treat it as a point-in-time snapshot: if the student has changed or deleted something since, trust what they tell you over the snapshot. If the study context is empty, do not invent courses, exams or deadlines; ask the student instead.";


/* ============================================================
   Validation helpers
   ============================================================ */

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value, maxLength) {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.replace(CONTROL_CHARS, " ").trim();

    if (!trimmed) {
        return null;
    }

    return trimmed.slice(0, maxLength);
}

/* Accepts only an array of well-formed {role, content} turns. */
function sanitiseHistory(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const history = [];

    for (const item of raw.slice(-HISTORY_MAX_MESSAGES)) {
        if (!isPlainObject(item) || VALID_ROLES.indexOf(item.role) === -1) {
            continue;
        }

        const content = cleanString(item.content, HISTORY_MESSAGE_MAX_LENGTH);

        if (content) {
            history.push({ role: item.role, content });
        }
    }

    return history;
}

/* Recursively strips anything that is not a bounded JSON primitive. */
function sanitiseContextValue(value, depth) {
    if (depth > CONTEXT_MAX_DEPTH) {
        return null;
    }

    if (value === null) {
        return null;
    }

    if (typeof value === "string") {
        return value.replace(CONTROL_CHARS, " ").slice(0, CONTEXT_MAX_STRING_LENGTH);
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === "boolean") {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .slice(0, CONTEXT_MAX_ARRAY_ITEMS)
            .map(item => sanitiseContextValue(item, depth + 1))
            .filter(item => item !== null);
    }

    if (isPlainObject(value)) {
        const output = {};
        let kept = 0;

        for (const key of Object.keys(value)) {
            if (kept >= CONTEXT_MAX_KEYS_PER_OBJECT) {
                break;
            }

            if (!SAFE_KEY.test(key)) {
                continue;
            }

            const cleaned = sanitiseContextValue(value[key], depth + 1);

            if (cleaned === null) {
                continue;
            }

            output[key] = cleaned;
            kept += 1;
        }

        return output;
    }

    return null;
}

function sanitiseStudyContext(raw) {
    if (!isPlainObject(raw)) {
        return null;
    }

    let cleaned;

    try {
        cleaned = sanitiseContextValue(raw, 0);
    } catch (error) {
        return null;
    }

    if (!isPlainObject(cleaned)) {
        return null;
    }

    try {
        if (JSON.stringify(cleaned).length > CONTEXT_MAX_SERIALISED_LENGTH) {
            return null;
        }
    } catch (error) {
        return null;
    }

    return cleaned;
}


/* ============================================================
   Study context -> labelled plain-text block
   ============================================================ */

function contextText(value, maxLength) {
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();

    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + "..." : trimmed;
}

function formatStudyContext(context) {
    if (!context) {
        return "STUDY CONTEXT: unavailable. Do not assume the student has any courses, " +
            "assessments or sessions - ask them instead.";
    }

    const today = contextText(context.today, 20);

    const lines = [
        "STUDY CONTEXT - live snapshot from the student's own Skolar data" +
            (today ? " (as of " + today + ")" : "") +
            ". Use only what is listed here."
    ];

    const courses = Array.isArray(context.courses) ? context.courses : [];

    lines.push("", "Courses:");

    if (courses.length) {
        for (const course of courses.slice(0, 15)) {
            if (!isPlainObject(course)) {
                continue;
            }

            const name = contextText(course.name, 100) || "Unnamed course";
            const code = contextText(course.code, 30);
            const total = Number(course.topicCount) || 0;

            let line = "  - " + name + (code ? " (" + code + ")" : "");

            if (total) {
                line += ": " + total + " topics - " +
                    (Number(course.completed) || 0) + " Completed, " +
                    (Number(course.inProgress) || 0) + " In Progress, " +
                    (Number(course.notStarted) || 0) + " Not Started, " +
                    (Number(course.needsRevision) || 0) + " Needs Revision";
            } else {
                line += ": no topics added yet";
            }

            lines.push(line);

            const topics = Array.isArray(course.topics) ? course.topics : [];
            const renderedTopics = topics.slice(0, 12).map(topic => contextText(topic, 90)).filter(Boolean);

            if (renderedTopics.length) {
                lines.push("      Topics: " + renderedTopics.join("; "));
            }

            const revision = Array.isArray(course.needsRevisionTopics) ? course.needsRevisionTopics : [];
            const renderedRevision = revision.slice(0, 6).map(topic => contextText(topic, 80)).filter(Boolean);

            if (renderedRevision.length) {
                lines.push("      Needs revision: " + renderedRevision.join("; "));
            }
        }
    } else {
        lines.push("  (none)");
    }

    const needsRevision = Array.isArray(context.needsRevision) ? context.needsRevision : [];

    lines.push("", "Topics marked Needs Revision (across all courses):");

    if (needsRevision.length) {
        for (const item of needsRevision.slice(0, 15)) {
            if (!isPlainObject(item)) {
                continue;
            }

            lines.push("  - " + (contextText(item.course, 100) || "Unknown course") +
                " / " + (contextText(item.topic, 100) || "Untitled topic"));
        }
    } else {
        lines.push("  (none)");
    }

    lines.push("", "Upcoming assessments (future only, soonest first):");

    const assessments = Array.isArray(context.upcomingAssessments) ? context.upcomingAssessments : [];

    if (assessments.length) {
        for (const item of assessments.slice(0, 8)) {
            if (!isPlainObject(item)) {
                continue;
            }

            lines.push("  - " + (contextText(item.name, 100) || "Untitled assessment") +
                " / " + (contextText(item.course, 100) || "Unknown course") +
                " / " + (contextText(item.type, 30) || "Assessment") +
                (item.date ? " / " + contextText(item.date, 20) : "") +
                (item.time ? " at " + contextText(item.time, 10) : "") +
                (item.when ? " (" + contextText(item.when, 40) + ")" : ""));
        }
    } else {
        lines.push("  (none)");
    }

    lines.push("", "Today's study sessions:");

    const todaySessions = Array.isArray(context.todaySessions) ? context.todaySessions : [];

    if (todaySessions.length) {
        for (const item of todaySessions.slice(0, 8)) {
            if (!isPlainObject(item)) {
                continue;
            }

            lines.push("  - " + (contextText(item.course, 100) || "Unknown course") +
                " / " + (contextText(item.topic, 100) || "No topic") +
                (item.time ? " at " + contextText(item.time, 10) : "") +
                " / " + (Number(item.durationMinutes) || 0) + " min");
        }
    } else {
        lines.push("  (none)");
    }

    lines.push("", "Upcoming planned study sessions:");

    const upcomingSessions = Array.isArray(context.upcomingSessions) ? context.upcomingSessions : [];

    if (upcomingSessions.length) {
        for (const item of upcomingSessions.slice(0, 8)) {
            if (!isPlainObject(item)) {
                continue;
            }

            lines.push("  - " + (contextText(item.course, 100) || "Unknown course") +
                " / " + (contextText(item.topic, 100) || "No topic") +
                (item.date ? " / " + contextText(item.date, 20) : "") +
                (item.time ? " at " + contextText(item.time, 10) : "") +
                " / " + (Number(item.durationMinutes) || 0) + " min");
        }
    } else {
        lines.push("  (none)");
    }

    lines.push("", "Weekly timetable:");

    const timetable = Array.isArray(context.timetable) ? context.timetable : [];

    if (timetable.length) {
        for (const day of timetable.slice(0, 7)) {
            if (!isPlainObject(day)) {
                continue;
            }

            const classes = Array.isArray(day.classes) ? day.classes : [];
            const rendered = classes.slice(0, 5).map(item => {
                if (!isPlainObject(item)) {
                    return null;
                }

                return (contextText(item.course, 100) || "Unknown course") +
                    " " + contextText(item.startTime, 10) + "-" + contextText(item.endTime, 10) +
                    (item.room ? " in " + contextText(item.room, 40) : "");
            }).filter(Boolean);

            if (!rendered.length) {
                continue;
            }

            lines.push("  - " + (contextText(day.day, 20) || "Unnamed day") +
                (day.isToday ? " (today)" : "") + ": " + rendered.join("; "));
        }
    } else {
        lines.push("  (none)");
    }

    return lines.join("\n");
}


/* ============================================================
   Route
   ============================================================ */

app.use(express.json());
app.use(express.static("."));

app.post("/chat", async (req, res) => {
    try {
        const body = isPlainObject(req.body) ? req.body : {};

        const userMessage = cleanString(body.message, MESSAGE_MAX_LENGTH);

        if (!userMessage) {
            return res.status(400).json({
                error: "Please enter a message."
            });
        }

        /* Conversations are never stored on the server - they are accepted,
           used for this single request, and discarded. */
        const history = sanitiseHistory(body.history);
        const studyContext = sanitiseStudyContext(body.studyContext);

        const messages = [
            {
                role: "system",
                content: SYSTEM_PROMPT
            },
            ...history,
            {
                role: "system",
                content: formatStudyContext(studyContext)
            },
            {
                role: "user",
                content: userMessage
            }
        ];

        const response = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "openai/gpt-oss-20b",
                    messages: messages
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error(data);
            return res.status(response.status).json({
                error: "AI request failed."
            });
        }

        const answer = data.choices?.[0]?.message?.content;

        res.json({
            answer: answer || "Sorry, I couldn't generate a response."
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Something went wrong."
        });
    }
});

app.listen(PORT, () => {
    console.log(`Skolar is running at http://localhost:${PORT}`);
});