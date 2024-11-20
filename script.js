// Form validation and submission handling
document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("contact-form");
    const formMessage = document.getElementById("form-message");

    form.addEventListener("submit", (event) => {
        event.preventDefault(); // Prevent the default form submission

        const name = document.getElementById("name").value;
        const email = document.getElementById("email").value;
        const message = document.getElementById("message").value;

        // Simple validation
        if (!name || !email || !message) {
            formMessage.textContent = "Please fill in all fields.";
            formMessage.style.color = "red";
            formMessage.style.display = "block";
        } else {
            formMessage.textContent = "Thank you for your message! I will get back to you soon.";
            formMessage.style.color = "green";
            formMessage.style.display = "block";

            // Send the form data to the server (Node.js backend)
            fetch('/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, message })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    formMessage.textContent = "Message sent successfully!";
                    formMessage.style.color = "green";
                    form.reset();
                } else {
                    formMessage.textContent = "Error sending message. Please try again.";
                    formMessage.style.color = "red";
                }
            })
            .catch(error => {
                formMessage.textContent = "An error occurred. Please try again later.";
                formMessage.style.color = "red";
            });
        }
    });
});
