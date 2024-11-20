const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static("public")); // Serve static files (your HTML, CSS, JS)

// Contact form submission route
app.post("/send-email", (req, res) => {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ success: false, message: "Please fill in all fields." });
    }

    // Setup Nodemailer transporter
    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com", // SMTP server for Outlook/Office 365
        port: 587, // Port number
        secure: false, // Use TLS (not SSL)
        auth: {
            user: "pmitch45@students.kennesaw.edu", // Your KSU email
            pass: "YourEmailPassword", // Your email password
        },
    });    

    const mailOptions = {
        from: email,
        to: "pmitch45@students.kennesaw.edu", // Your email address to receive the message
        subject: `Contact form submission from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nMessage: ${message}`,
    };

    // Send the email
    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            return res.status(500).json({ success: false, message: "Error sending email." });
        }
        res.status(200).json({ success: true, message: "Email sent successfully." });
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
