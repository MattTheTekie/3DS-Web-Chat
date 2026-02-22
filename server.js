const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- BAD WORD LIST ----------
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
  "motherfucker"
];
function containsBadWord(text) {
  if (!text) return false;
  return bannedWords.some(word => new RegExp(`\\b${word}\\b`, "i").test(text));
}

// ---------- MIDDLEWARE ----------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

// 3DS-safe static serving
app.use("/uploads", express.static("uploads"));
app.use(express.static("public"));

// ---------- DATA ----------
let rooms = {};
let activeUsers = {};
let lastActive = {};
const MAX_MESSAGES = 10000000000000000;
const IDLE_TIMEOUT = 30000;

// ---------- TIMESTAMP ----------
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

// ---------- UTIL ----------
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

// ---------- ROUTES ----------

// Create room
app.post("/create-room", (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.sendStatus(400);
  if (rooms[name]) return res.status(409).json({ error: "Room already exists" });

  rooms[name] = [];
  activeUsers[name] = {};
  lastActive[name] = {};
  addMessage(name, { system: true, text: timestamp() + " Chat room created." });

  res.sendStatus(200);
});

// Get messages
app.get("/messages", (req, res) => {
  const room = req.query.room;
  if (!rooms[room]) return res.json({ messages: [], users: [] });
  res.json({
    messages: rooms[room],
    users: Object.keys(activeUsers[room])
  });
});

// Join
app.post("/join", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);
  joinUser(room.trim(), user.trim());
  res.sendStatus(200);
});

// Leave
app.post("/leave", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);
  leaveUser(room.trim(), user.trim());
  res.sendStatus(200);
});

// Send message with bad word announcement
app.post("/send", (req, res) => {
  const { room, user, text } = req.body;
  if (!room || !user || !text) return res.sendStatus(400);

  joinUser(room.trim(), user.trim());

  if (containsBadWord(text)) {
    // Announce bad message attempt
    addMessage(room.trim(), {
      system: true,
      text: timestamp() + ` User ${user.trim()} tried to send a message with inappropriate words.`
    });
    return res.status(400).json({ warning: "Your message contains inappropriate words." });
  }

  // Normal message
  addMessage(room.trim(), {
    system: false,
    user: user.trim(),
    text: timestamp() + " " + text.trim()
  });

  lastActive[room.trim()][user.trim()] = Date.now();
  res.sendStatus(200);
});

// ---------- UPLOAD ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  }
});

const upload = multer({
  storage,
  limits: {},
  fileFilter: (req, file, cb) => cb(null, true)
});

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const { room, user } = req.body;
    if (!room || !user || !req.file) return res.sendStatus(400);

    joinUser(room.trim(), user.trim());

    const inputPath = req.file.path;
    const isImage = req.file.mimetype.startsWith("image/");
    const isVideo = req.file.mimetype.startsWith("video/");

    if (isImage) {
      const outputName = Date.now() + ".jpg";
      const outputPath = path.join("uploads", outputName);
      await sharp(inputPath).resize({ width: 400 }).jpeg({ quality: 70 }).toFile(outputPath);
      fs.unlinkSync(inputPath);

      const imageUrl = "/uploads/" + outputName;
      const caption = timestamp() + `<br><a href="${imageUrl}" target="_blank"><img src="${imageUrl}" width="150"></a><br><a>chat.veltron.net${imageUrl}</a></br>`;

      if (containsBadWord(caption)) {
        // Announce bad upload attempt
        addMessage(room.trim(), {
          system: true,
          text: timestamp() + ` User ${user.trim()} tried to upload content with inappropriate words.`
        });
        fs.unlinkSync(outputPath);
        return res.status(400).json({ warning: "Your upload contains inappropriate words in caption." });
      }

      addMessage(room.trim(), { system: false, user: user.trim(), text: caption });

    } else if (isVideo || req.file.mimetype.startsWith("audio/") || req.file.mimetype.startsWith("application/")) {
      const outputName = Date.now() + ".mp4";
      const outputPath = path.join("uploads", outputName);
      const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -profile:v high -b:v 682k -r 30 -c:a aac -b:a 128k -ar 48000 -ac 2 -s 640x360 -metadata:s:v:0 language=eng "${outputPath}"`;

      await new Promise((resolve, reject) => {
        exec(ffmpegCmd, (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve();
        });
      });

      fs.unlinkSync(inputPath);

      const mediaUrl = "/uploads/" + outputName;
      const caption = timestamp() + `<a href="${mediaUrl}" target="_blank">[VIDEO ATTACHMENT]</a> <br><a>chat.veltron.net${mediaUrl}</a></br>`;

      if (containsBadWord(caption)) {
        addMessage(room.trim(), {
          system: true,
          text: timestamp() + ` User ${user.trim()} tried to upload content with inappropriate words.`
        });
        fs.unlinkSync(outputPath);
        return res.status(400).json({ warning: "Your upload contains inappropriate words in caption." });
      }

      addMessage(room.trim(), { system: false, user: user.trim(), text: caption });

    } else {
      fs.unlinkSync(inputPath);
      return res.status(400).json({ error: "Unsupported file type." });
    }

    lastActive[room.trim()][user.trim()] = Date.now();
    res.redirect("/");

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ---------- 3DS-SAFE VIDEO DELIVERY ----------
app.get("/uploads/:file", (req, res) => {
  const file = path.join("uploads", req.params.file);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const stat = fs.statSync(file);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(file).pipe(res);
});

// ---------- IDLE CLEANUP ----------
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

// ---------- START ----------
ensureRoom("Lobby");
app.listen(PORT, () => console.log("AIM XP 3DS running on port " + PORT));
