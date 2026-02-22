const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================================================
   IMPROVED PROFANITY FILTER
========================================================= */

const bannedWords = [
  "fuck",
  "shit",
  "asshole",
  "bastard",
  "damn",
  "crap",
  "dick",
  "piss",
  "bullshit",
  "motherfucker",
  "pussy"
];

// Normalize text to defeat bypass attempts
function normalizeText(text) {
  return text
    .toLowerCase()

    // Replace common leetspeak
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/\$/g, "s")
    .replace(/@/g, "a")

    // Remove symbols
    .replace(/[^a-z]/g, "")

    // Collapse repeated letters (fuuuuuck → fuck)
    .replace(/(.)\1{2,}/g, "$1");
}

function containsBadWord(text) {
  if (!text) return false;

  const normalized = normalizeText(text);

  return bannedWords.some(word =>
    normalized.includes(word)
  );
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

/* =========================================================
   DATA
========================================================= */

let rooms = {};
let activeUsers = {};
let lastActive = {};

const MAX_MESSAGES = 100000;
const IDLE_TIMEOUT = 30000;

/* =========================================================
   TIMESTAMP
========================================================= */

function timestamp() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(new Date());
  const hour = parts.find(p => p.type === "hour").value;
  const minute = parts.find(p => p.type === "minute").value;

  return `[${hour}:${minute}]`;
}

/* =========================================================
   UTIL
========================================================= */

function addMessage(room, msg) {
  if (!rooms[room]) return;
  rooms[room].push(msg);
  if (rooms[room].length > MAX_MESSAGES) rooms[room].shift();
}

function ensureRoom(name) {
  if (!rooms[name]) {
    rooms[name] = [];
    activeUsers[name] = {};
    lastActive[name] = {};
    addMessage(name, {
      system: true,
      text: timestamp() + " Chat room created."
    });
  }
}

function joinUser(room, user) {
  ensureRoom(room);
  if (!activeUsers[room][user]) {
    activeUsers[room][user] = true;
    addMessage(room, {
      system: true,
      text: timestamp() + " " + user + " has entered the room."
    });
  }
  lastActive[room][user] = Date.now();
}

function leaveUser(room, user, reason = "has left the room.") {
  if (!rooms[room]) return;
  if (activeUsers[room][user]) {
    delete activeUsers[room][user];
    delete lastActive[room][user];
    addMessage(room, {
      system: true,
      text: timestamp() + " " + user + " " + reason
    });
  }
}

/* =========================================================
   ROUTES
========================================================= */

app.post("/create-room", (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.sendStatus(400);
  if (rooms[name]) return res.status(409).json({ error: "Room already exists" });

  ensureRoom(name);
  res.sendStatus(200);
});

app.get("/messages", (req, res) => {
  const room = req.query.room;
  if (!rooms[room]) return res.json({ messages: [], users: [] });

  res.json({
    messages: rooms[room],
    users: Object.keys(activeUsers[room])
  });
});

app.post("/join", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);

  joinUser(room.trim(), user.trim());
  res.sendStatus(200);
});

app.post("/leave", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);

  leaveUser(room.trim(), user.trim());
  res.sendStatus(200);
});

app.post("/send", (req, res) => {
  const { room, user, text } = req.body;
  if (!room || !user || !text) return res.sendStatus(400);

  joinUser(room.trim(), user.trim());

  if (containsBadWord(text)) {
    addMessage(room.trim(), {
      system: true,
      text: timestamp() + ` User ${user.trim()} tried to send an inappropriate message.`
    });

    return res.status(400).json({
      warning: "Your message contains inappropriate words."
    });
  }

  addMessage(room.trim(), {
    system: false,
    user: user.trim(),
    text: timestamp() + " " + text.trim()
  });

  lastActive[room.trim()][user.trim()] = Date.now();
  res.sendStatus(200);
});

/* =========================================================
   FILE UPLOAD
========================================================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  }
});

const upload = multer({ storage });

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const { room, user } = req.body;
    if (!room || !user || !req.file) return res.sendStatus(400);

    joinUser(room.trim(), user.trim());

    const inputPath = req.file.path;
    const outputName = Date.now() + ".jpg";
    const outputPath = path.join("uploads", outputName);

    await sharp(inputPath)
      .resize({ width: 400 })
      .jpeg({ quality: 70 })
      .toFile(outputPath);

    fs.unlinkSync(inputPath);

    const imageUrl = "/uploads/" + outputName;
    const caption = timestamp() + ` <a href="${imageUrl}" target="_blank">[IMAGE]</a>`;

    addMessage(room.trim(), {
      system: false,
      user: user.trim(),
      text: caption
    });

    lastActive[room.trim()][user.trim()] = Date.now();
    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* =========================================================
   IDLE CLEANUP
========================================================= */

setInterval(() => {
  const now = Date.now();
  for (const room in lastActive) {
    for (const user in lastActive[room]) {
      if (now - lastActive[room][user] > IDLE_TIMEOUT) {
        leaveUser(room, user, "has been idle and left.");
      }
    }
  }
}, 5000);

/* =========================================================
   START
========================================================= */

ensureRoom("Lobby");

app.listen(PORT, () =>
  console.log("AIM XP 3DS running on port " + PORT)
);
