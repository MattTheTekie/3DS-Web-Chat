const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

app.use("/uploads", express.static("uploads"));

// Serve index1.html for non-3DS user agents
app.use((req, res, next) => {
  const userAgent = req.get("User-Agent");
  if (!userAgent || !userAgent.includes("3DS")) {
    res.sendFile(path.join(__dirname, "public/index1.html"));
  } else {
    next(); // Continue processing for 3DS requests
  }
});

app.use(express.static("public"));

let rooms = {};
let activeUsers = {};
let lastActive = {};

const MAX_MESSAGES = 100;
const IDLE_TIMEOUT = 30000;

/* ---------- TORONTO TIME ---------- */
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

/* ---------- UTIL ---------- */
function addMessage(room, msg) {
  if (!rooms[room]) return;
  rooms[room].push(msg);
  if (rooms[room].length > MAX_MESSAGES)
    rooms[room].shift();
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

/* ---------- CREATE ROOM ---------- */
app.post("/create-room", (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.sendStatus(400);

  if (rooms[name]) {
    return res.status(409).json({ error: "Room already exists" });
  }

  rooms[name] = [];
  activeUsers[name] = {};
  lastActive[name] = {};

  addMessage(name, {
    system: true,
    text: timestamp() + " Chat room created."
  });

  res.sendStatus(200);
});

/* ---------- GET MESSAGES ---------- */
app.get("/messages", (req, res) => {
  const room = req.query.room;
  if (!rooms[room])
    return res.json({ messages: [], users: [] });

  res.json({
    messages: rooms[room],
    users: Object.keys(activeUsers[room])
  });
});

/* ---------- JOIN ---------- */
app.post("/join", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);

  joinUser(room.trim(), user.trim());
  res.sendStatus(200);
});

/* ---------- LEAVE ---------- */
app.post("/leave", (req, res) => {
  const { room, user } = req.body;
  if (!room || !user) return res.sendStatus(400);

  leaveUser(room.trim(), user.trim());
  res.sendStatus(200);
});

/* ---------- SEND MESSAGE ---------- */
app.post("/send", (req, res) => {
  const { room, user, text } = req.body;
  if (!room || !user || !text)
    return res.sendStatus(400);

  joinUser(room.trim(), user.trim());

  addMessage(room.trim(), {
    system: false,
    user: user.trim(),
    text: timestamp() + " " + text
  });

  lastActive[room.trim()][user.trim()] = Date.now();
  res.sendStatus(200);
});

/* ---------- UPLOAD (IMAGES + VIDEOS) ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = file.mimetype.startsWith("video/") ? path.extname(file.originalname) || ".avi" : ".jpg";
    cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null,
    file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")
  )
});

app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const { room, user } = req.body;
    if (!room || !user || !req.file) return res.sendStatus(400);

    joinUser(room.trim(), user.trim());

    const isVideo = req.file.mimetype.startsWith("video/");
    const inputPath = req.file.path;

    if (isVideo) {
      const outputName = Date.now() + ".avi";
      const outputPath = path.join("uploads", outputName);

      // FFmpeg conversion for 3DS
      const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -s 400x240 -aspect 2:1 -r 20 -vcodec mjpeg -qscale 1 -acodec adpcm_ima_wav -ac 2 "${outputPath}"`;

      await new Promise((resolve, reject) => {
        exec(ffmpegCmd, (err, stdout, stderr) => {
          if (err) {
            console.error("FFmpeg failed:", err);
            console.error(stderr);
            return reject(err);
          }
          resolve();
        });
      });

      fs.unlinkSync(inputPath);
      const mediaUrl = "/uploads/" + outputName;

      addMessage(room.trim(), {
        system: false,
        user: user.trim(),
        text: timestamp() + `<a href="${mediaUrl}" target="_blank">[VIDEO ATTACHMENT]</a>`
      });

    } else {
      // Image processing
      const outputName = Date.now() + ".jpg";
      const outputPath = path.join("uploads", outputName);

      await sharp(inputPath)
        .resize({ width: 400 })
        .jpeg({ quality: 70 })
        .toFile(outputPath);

      fs.unlinkSync(inputPath);
      const imageUrl = "/uploads/" + outputName;

      addMessage(room.trim(), {
        system: false,
        user: user.trim(),
        text: timestamp() + `<br><a href="${imageUrl}" target="_blank"><img src="${imageUrl}" width="150"></a>`
      });
    }

    lastActive[room.trim()][user.trim()] = Date.now();
    res.redirect("/");

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* ---------- IDLE CLEANUP ---------- */
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

/* ---------- START ---------- */
ensureRoom("Lobby");

app.listen(PORT, () => console.log("AIM XP 3DS running on port " + PORT));
