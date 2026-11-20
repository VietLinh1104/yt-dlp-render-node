# yt-dlp Render API

Node.js API for streaming YouTube audio as MP3 and downloading MP3 files.
Uses the standalone Linux yt-dlp binary and FFmpeg. Python is not installed.

## Endpoints

- `GET /health` — public health check
- `GET /api/audio/stream?url=<youtube-url>` — transcodes audio to MP3 and streams it
- `GET /api/audio/download?url=<youtube-url>` — downloads/extracts MP3 and returns it as an attachment

Protected endpoints require `x-api-key`.

Example:

```bash
curl -G 'http://localhost:3000/api/audio/stream' \
  -H 'x-api-key: YOUR_API_KEY' \
  --data-urlencode 'url=https://www.youtube.com/watch?v=VIDEO_ID' \
  --output preview.mp3
```

Download:

```bash
curl -G 'http://localhost:3000/api/audio/download' \
  -H 'x-api-key: YOUR_API_KEY' \
  --data-urlencode 'url=https://www.youtube.com/watch?v=VIDEO_ID' \
  --output audio.mp3
```

The stream endpoint transcodes on the fly, so the response starts while FFmpeg is processing.
It does not support HTTP Range requests / seeking. The download endpoint creates a temporary
MP3 first, then streams the completed file to the client. Temporary files are deleted after
the response.

## Run locally

Requires Docker (recommended), or Node.js 20+ plus FFmpeg and yt-dlp installed separately.

```bash
cp .env.example .env
# Set API_KEY in .env
npm install
npm start
```

## Deploy to Render

1. Push this project to a Git repository.
2. In Render, create **New → Web Service** and connect the repository.
3. Select **Docker** as the runtime/environment.
4. Set environment variable `API_KEY` to a long random secret.
5. Deploy. Render will build the Dockerfile, installing yt-dlp and FFmpeg.
6. Test `https://YOUR-SERVICE.onrender.com/health`.

Use a **Web Service**, not a Background Worker, because these endpoints receive HTTP requests.

## Supabase Edge Function

Keep `RENDER_API_URL` and `RENDER_API_KEY` in Edge Function secrets, not in frontend code.
The Edge Function should authenticate the user, validate the request, then call Render with
`x-api-key`. Do not expose the Render API key to the browser.

## Notes

- Only standard YouTube video URLs and youtu.be links are accepted.
- Add rate limiting, user quotas, job tracking, and request timeouts before public production use.
- Streaming endpoint does not support seeking because it is a live transcode pipeline.
- Use only for content you have the rights or permission to access and download, and comply with YouTube's terms.
