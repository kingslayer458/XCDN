const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");

const app = express();
const PORT = process.env.PORT || 7000;
const CDN_BASE_URL = process.env.CDN_BASE_URL || "";
const MAX_UPLOAD_MB = Number.parseInt(process.env.MAX_UPLOAD_MB || "5120", 10);

const ROOT_DIR = __dirname;
const STORAGE_DIR = path.join(ROOT_DIR, "storage");
const VIDEOS_DIR = path.join(STORAGE_DIR, "videos");
const META_FILE = path.join(STORAGE_DIR, "metadata.json");

ensureStorage();

app.set("trust proxy", 1);
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  res.on("finish", () => {
    const elapsedMs = Date.now() - startedAt;
    const length = res.getHeader("content-length") || 0;
    const logLine = [
      new Date().toISOString(),
      req.method,
      req.originalUrl,
      res.statusCode,
      `${elapsedMs}ms`,
      `ip=${clientIp}`,
      `bytes=${length}`,
    ].join(" | ");
    console.log(logLine);
  });

  next();
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.static(path.join(ROOT_DIR, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIDEOS_DIR),
    filename: (_req, file, cb) => {
      const videoId = crypto.randomUUID();
      const ext = path.extname(file.originalname || "") || ".mp4";
      cb(null, `${videoId}${ext.toLowerCase()}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("video/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only video files are allowed."));
  },
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mini-cdn-video" });
});

app.get("/api/videos", (req, res) => {
  const all = readMetadata();
  const existing = all.filter((item) => fs.existsSync(path.join(VIDEOS_DIR, item.storedName)));

  const payload = existing
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map((item) => toApiVideo(item, req));

  res.json({ count: payload.length, videos: payload });
});

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded. Use form-data key: video" });
    return;
  }

  const ext = path.extname(req.file.filename);
  const id = path.basename(req.file.filename, ext);

  const entry = {
    id,
    storedName: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    contentType: req.file.mimetype || mime.lookup(req.file.filename) || "application/octet-stream",
    uploadedAt: new Date().toISOString(),
  };

  const meta = readMetadata();
  meta.push(entry);
  writeMetadata(meta);

  res.status(201).json({
    message: "Uploaded",
    video: toApiVideo(entry, req),
  });
});

app.delete("/api/videos/:id", (req, res) => {
  const result = deleteVideo(req.params.id);

  if (!result.found) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  res.json({
    message: "Video deleted",
    id: req.params.id,
    fileDeleted: result.fileDeleted,
  });
});

app.get("/cdn/:id", (req, res) => {
  const item = findVideo(req.params.id);
  if (!item) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const filePath = path.join(VIDEOS_DIR, item.storedName);
  res.setHeader("Content-Type", item.contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${sanitizeFileName(item.originalName)}"`);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(filePath).pipe(res);
});

app.get("/stream/:id", (req, res) => {
  const item = findVideo(req.params.id);
  if (!item) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const filePath = path.join(VIDEOS_DIR, item.storedName);
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  res.setHeader("Content-Type", item.contentType || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  if (!rangeHeader) {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const [rawStart, rawEnd] = rangeHeader.replace(/bytes=/, "").split("-");
  const start = Number.parseInt(rawStart, 10);
  const parsedEnd = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1;
  const end = Number.isNaN(parsedEnd) ? fileSize - 1 : parsedEnd;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= fileSize) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  fs.createReadStream(filePath, { start, end }).pipe(res);
});

app.use((err, _req, res, _next) => {
  console.error(`[${new Date().toISOString()}]`, err);
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: `File too large. Max upload size is ${MAX_UPLOAD_MB} MB. You can change it with MAX_UPLOAD_MB.`,
      });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message || "Upload error" });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Mini CDN server running on http://localhost:${PORT}`);
});

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  }
  if (!fs.existsSync(META_FILE)) {
    fs.writeFileSync(META_FILE, "[]", "utf8");
  }
}

function readMetadata() {
  try {
    const raw = fs.readFileSync(META_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMetadata(data) {
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2), "utf8");
}

function findVideo(id) {
  const item = readMetadata().find((video) => video.id === id);
  if (!item) {
    return null;
  }

  const exists = fs.existsSync(path.join(VIDEOS_DIR, item.storedName));
  return exists ? item : null;
}

function sanitizeFileName(value) {
  return String(value || "video").replace(/[\\/\r\n\t\0]+/g, "_");
}

function getBaseUrl(req) {
  if (CDN_BASE_URL) {
    return CDN_BASE_URL.replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function toApiVideo(item, req) {
  const streamPath = `/stream/${item.id}`;
  const downloadPath = `/cdn/${item.id}`;
  const baseUrl = getBaseUrl(req);
  return {
    id: item.id,
    originalName: item.originalName,
    size: item.size,
    contentType: item.contentType,
    uploadedAt: item.uploadedAt,
    streamUrl: streamPath,
    downloadUrl: downloadPath,
    streamUrlAbsolute: `${baseUrl}${streamPath}`,
    downloadUrlAbsolute: `${baseUrl}${downloadPath}`,
    videoTag: `<video controls preload="metadata" src="${baseUrl}${streamPath}"></video>`,
  };
}

function deleteVideo(id) {
  const meta = readMetadata();
  const index = meta.findIndex((video) => video.id === id);
  if (index === -1) {
    return { found: false, fileDeleted: false };
  }

  const [removed] = meta.splice(index, 1);
  writeMetadata(meta);

  const filePath = path.join(VIDEOS_DIR, removed.storedName);
  if (!fs.existsSync(filePath)) {
    return { found: true, fileDeleted: false };
  }

  fs.unlinkSync(filePath);
  return { found: true, fileDeleted: true };
}
