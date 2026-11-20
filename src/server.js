import express from "express";
import helmet from "helmet";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "16kb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 3));
let activeJobs = 0;

if (!API_KEY) {
  console.error("Missing API_KEY. Set a strong API_KEY environment variable.");
  process.exit(1);
}

function requireApiKey(req, res, next) {
  const supplied = req.get("x-api-key");
  if (!supplied || supplied !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function validateYouTubeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;

  try {
    const url = new URL(value);
    const allowedHosts = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ]);

    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) return null;

    const isShortLink = url.hostname === "youtu.be";
    const videoId = isShortLink
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v");

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return null;
  }
}

function acquireJob(res) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    res.status(429).json({ error: "Server is busy. Try again later." });
    return false;
  }
  activeJobs += 1;
  return true;
}

function releaseJob() {
  activeJobs = Math.max(0, activeJobs - 1);
}

function killProcess(child) {
  if (child && child.exitCode === null) child.kill("SIGKILL");
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Streams transcoded MP3 bytes to the client.
 * The yt-dlp audio output is piped through FFmpeg; no complete audio file
 * is written to disk. HTTP range/seek is not supported by this live pipeline.
 */
app.get("/api/audio/stream", requireApiKey, async (req, res) => {
  const url = validateYouTubeUrl(req.query.url);
  if (!url) return res.status(400).json({ error: "A valid YouTube video URL is required." });
  if (!acquireJob(res)) return;

  const ytdlp = spawn(YTDLP, [
    "--no-playlist",
    "--no-warnings",
    "-f", "bestaudio/best",
    "-o", "-",
    url
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const ffmpeg = spawn(FFMPEG, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-vn",
    "-codec:a", "libmp3lame",
    "-b:a", "192k",
    "-f", "mp3",
    "pipe:1"
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseJob();
    }
  };

  let stderr = "";
  ytdlp.stderr.on("data", chunk => { stderr += chunk.toString(); });
  ffmpeg.stderr.on("data", chunk => { stderr += chunk.toString(); });

  res.on("close", () => {
    if (!res.writableEnded) {
      killProcess(ytdlp);
      killProcess(ffmpeg);
      release();
    }
  });

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", 'inline; filename="youtube-audio.mp3"');
  res.setHeader("Cache-Control", "no-store");

  const fail = (child, other) => {
    child.once("error", () => {
      killProcess(other);
      if (!res.headersSent) res.status(500).json({ error: "Audio processing failed." });
      else res.destroy();
      release();
    });
  };
  fail(ytdlp, ffmpeg);
  fail(ffmpeg, ytdlp);

  ffmpeg.once("close", code => {
    if (code !== 0 && !res.destroyed) {
      if (!res.headersSent) res.status(502).json({ error: "Unable to stream this video.", detail: stderr.slice(-1500) });
      else res.destroy();
    }
    release();
  });

  ytdlp.once("close", code => {
    if (code !== 0) {
      killProcess(ffmpeg);
      if (!res.headersSent) res.status(502).json({ error: "yt-dlp could not process this video.", detail: stderr.slice(-1500) });
      else res.destroy();
      release();
    }
  });
});

/**
 * Downloads and converts audio to MP3, then streams the completed file
 * as an attachment. Temporary files are removed after the response ends.
 */
app.get("/api/audio/download", requireApiKey, async (req, res) => {
  const url = validateYouTubeUrl(req.query.url);
  if (!url) return res.status(400).json({ error: "A valid YouTube video URL is required." });
  if (!acquireJob(res)) return;

  let tempDir;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "yt-dlp-"));
    const outputTemplate = path.join(tempDir, "audio.%(ext)s");

    const child = spawn(YTDLP, [
      "--no-playlist",
      "--no-warnings",
      "-f", "bestaudio/best",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--ffmpeg-location", FFMPEG,
      "-o", outputTemplate,
      url
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });

    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
      res.once("close", () => {
        if (!res.writableEnded) killProcess(child);
      });
    });

    if (exitCode !== 0) {
      return res.status(502).json({
        error: "yt-dlp could not download this video.",
        detail: stderr.slice(-1500)
      });
    }

    const entries = await readdir(tempDir);
    const audioFile = entries.find(name => name.toLowerCase().endsWith(".mp3"));
    if (!audioFile) return res.status(500).json({ error: "MP3 output was not created." });

    res.download(path.join(tempDir, audioFile), "audio.mp3", async () => {
      await rm(tempDir, { recursive: true, force: true });
      releaseJob();
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Download failed.", detail: error.message });
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    releaseJob();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`yt-dlp API listening on port ${PORT}`);
});
