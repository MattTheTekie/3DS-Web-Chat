const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));
app.use("/emotes", express.static("emotes")); // emojis

let rooms = {};
let typing = {};     // { room: { user: true/false } }
let lastActive = {}; // { room: { user: timestamp } }
const MAX_MESSAGES = 100;
const IDLE_TIMEOUT = 30000; // 30 seconds

/* ---------- Utilities ---------- */
function timestamp() {
  const d = new Date();
  const offset = -5 * 60; // Toronto UTC-5
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const toronto = new Date(utc + offset * 60000);
  let h = toronto.getHours(), m = toronto.getMinutes();
  if (h < 10) h = "0" + h;
  if (m < 10) m = "0" + m;
  return `[${h}:${m}]`;
}

function addMessage(room, msg) {
  if (!rooms[room]) return;
  rooms[room].push(msg);
  if (rooms[room].length > MAX_MESSAGES) rooms[room].shift();
}

function escapeHTML(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatMessage(text) {
  text = escapeHTML(text);
  text = text.replace(/:\)/g, '<img src="/emotes/smile.gif">');
  text = text.replace(/:\(/g, '<img src="/emotes/sad.gif">');
  text = text.replace(/;\)/g, '<img src="/emotes/wink.gif">');
  text = text.replace(/:D/g, '<img src="/emotes/grin.gif">');
  text = text.replace(/(https?:\/\/[^\s]+)/g, function(url) {
    if (url.match(/\.(jpg|jpeg|png|gif)$/i)) return `<br><a href="${url}" target="_blank"><img src="${url}" width="150"></a><br>`;
    return `<a href="${url}" target="_blank">${url}</a>`;
  });
  return text;
}

/* ---------- Multer Storage + Sharp ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/"))
});

/* ---------- Routes ---------- */

// Create Room
app.post("/create-room", (req, res) => {
  const name = req.body.name;
  if (!rooms[name]) {
    rooms[name] = [];
    typing[name] = {};
    lastActive[name] = {};
    addMessage(name, { system: true, text: timestamp() + " Chat room created." });
  }
  res.sendStatus(200);
});

// Get Messages (merge typing info)
app.get("/messages", (req, res) => {
  const room = req.query.room;
  if (!rooms[room]) return res.json([]);
  const msgs = rooms[room].map(m => {
    if (!m.system && typing[room]?.[m.user]) m.typing = true;
    return m;
  });
  res.json(msgs);
});

// Join Room
app.post("/join", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);
  if (!rooms[room]) return res.sendStatus(400);

  addMessage(room, { system: true, text: timestamp() + " " + user + " has entered the room." });
  typing[room][user] = false;
  lastActive[room][user] = Date.now();
  res.sendStatus(200);
});

// Leave Room
app.post("/leave", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);
  if (!rooms[room]) return res.sendStatus(400);

  addMessage(room, { system: true, text: timestamp() + " " + user + " has left the room." });
  delete typing[room][user];
  delete lastActive[room][user];
  res.sendStatus(200);
});

// Send Message
app.post("/send", (req, res) => {
  const { room, user, text } = req.body;
  if (!room || !user || !text) return res.sendStatus(400);
  if (!rooms[room]) return res.sendStatus(400);

  addMessage(room, { system: false, user, text: timestamp() + " " + formatMessage(text) });
  lastActive[room][user] = Date.now(); // reset idle timer
  typing[room][user] = false;
  res.sendStatus(200);
});

// Typing Indicator
app.post("/typing", (req, res) => {
  const { room, user, typing: isTyping } = req.body;
  if (!room || !user) return res.sendStatus(400);
  if (!rooms[room]) return res.sendStatus(400);

  typing[room][user] = !!isTyping;
  lastActive[room][user] = Date.now(); // reset idle timer
  res.sendStatus(200);
});

// Upload Image
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const { room, user } = req.body;
    if (!room || !user || !req.file) return res.sendStatus(400);
    if (!rooms[room]) return res.sendStatus(400);

    const originalPath = req.file.path;
    const outputName = Date.now() + "-" + Math.round(Math.random()*1e9) + ".jpg";
    const outputPath = path.join("uploads", outputName);

    await sharp(originalPath)
      .resize({ width: 400 })
      .jpeg({ quality: 70 })
      .toFile(outputPath);

    fs.unlinkSync(originalPath);

    const imageUrl = "/uploads/" + outputName;
    addMessage(room, {
      system: false,
      user,
      text: timestamp() + `<br><a href="${imageUrl}" target="_blank"><img src="${imageUrl}" width="150"></a>`
    });
    lastActive[room][user] = Date.now();
    typing[room][user] = false;

    // <-- redirect back to chat page
    res.redirect("/");

  } catch (err) {
    console.error("Upload error:", err);
    res.sendStatus(500);
  }
});

/* ---------- Auto-leave Idle Users ---------- */
setInterval(() => {
  const now = Date.now();
  for (const room in lastActive) {
    for (const user in lastActive[room]) {
      if (now - lastActive[room][user] > IDLE_TIMEOUT) {
        addMessage(room, { system: true, text: timestamp() + " " + user + " has been idle and left." });
        delete lastActive[room][user];
        delete typing[room][user];
      }
    }
  }
}, 5000); // check every 5s

/* ---------- Start Server ---------- */
app.listen(PORT, () => console.log("AIM 3DS running on port " + PORT));
