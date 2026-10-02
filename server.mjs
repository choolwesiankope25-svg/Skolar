import express from "express";
import dotenv from "dotenv";
import dns from "dns"
dotenv.config();
dns.setDefaultResultOrder("ipv4first");
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static("."));

app.post("/chat", async (req, res) => {
    try {
        const userMessage = req.body.message;

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
                    messages: [
                        {
                            role: "system",
                            content: "You are Skolar, a friendly and intelligent student support AI. Talk like a helpful senior student who genuinely wants the student to understand, not like a textbook or formal essay. Keep answers conversational, clear, practical, and reasonably concise. For simple questions, give a simple answer first and expand only when useful. When teaching academic topics, explain the idea in plain language, give a relatable example, and include an exam-ready definition or key points when appropriate. Break information into short paragraphs or simple bullet points. Do not overwhelm the student with unnecessary information. Do not use Markdown symbols such as **, ##, or ### because the chat interface displays plain text. Be calm, authentic, encouraging, and occasionally use light humour when it fits. Do not diagnose medical or mental health conditions. If you are unsure of something, say so rather than making it up."
                        },
                        {
                            role: "user",
                            content: userMessage
                        }
                    ]
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