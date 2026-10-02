async function sendMessage() {
    const input = document.getElementById("userInput");
    const messages = document.getElementById("messages");

    const text = input.value.trim();

    if (text === "") {
        return;
    }

    // Show the student's message
    const userMessage = document.createElement("div");
    userMessage.className = "message user";
    userMessage.textContent = text;
    messages.appendChild(userMessage);

    input.value = "";

    // Show a temporary loading message
    const botMessage = document.createElement("div");
    botMessage.className = "message bot";
    botMessage.textContent = "Skolar is thinking...";
    messages.appendChild(botMessage);

    messages.scrollTop = messages.scrollHeight;

    try {
        const response = await fetch("/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: text
            })
        });

        const data = await response.json();

        if (data.answer) {
            botMessage.textContent = data.answer;
        } else {
            botMessage.textContent = "Sorry, something went wrong.";
        }

    } catch (error) {
        console.error(error);
        botMessage.textContent =
            "I couldn't connect right now. Please try again.";
    }

    messages.scrollTop = messages.scrollHeight;
}