/**
 * Cloudflare Worker — gapfill-ai-googledrive
 *
 * Secrets: BUNNY_API_KEY, BUNNY_LIBRARY_ID, BUNNY_CDN_HOST,
 *          ASSEMBLYAI_API_KEY, OPENROUTER_KEY
 * KV binding: LESSONS
 */

function generateId(len = 7) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Google OAuth client ID (used to validate token audience)
const GOOGLE_CLIENT_ID = "187762853414-v7e6kqi1e86pkf0a2s1b92c6q245ralc.apps.googleusercontent.com";

async function verifyGoogleIdToken(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    const payload = await res.json();
    // Verify audience
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;
    // Verify expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// D1 helpers: prefer env.DB then env.D1. Ensure schema exists when using D1.
async function getDbBinding(env) {
  return env.DB || env.D1 || env['esl-exercises'] || null;
}

async function ensureDbSchema(db) {
  if (!db) return;
  // Create table for exercises if not exists using the app's D1 schema
  await db.prepare(`CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY,
    teacher_id TEXT,
    title TEXT,
    exercise_json TEXT,
    created_at TEXT,
    updated_at TEXT
  );`).run();
  // Create table for sessions
  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );`).run();
  // Create table for teachers (minimal schema)
  await db.prepare(`CREATE TABLE IF NOT EXISTS teachers (
    id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    created_at TEXT
  );`).run();
  // Student/share lessons use KV when it is bound. This table is only the
  // fallback for deployments that already use the app's D1 binding.
  await db.prepare(`CREATE TABLE IF NOT EXISTS student_lessons (
    id TEXT PRIMARY KEY,
    lesson_json TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );`).run();
}


// ── Session helpers ────────────────────────────────────────────────────────────

async function generateSessionId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(db, teacherId) {
  const sessionId = await generateSessionId();
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
  await db.prepare(
    `INSERT INTO sessions (session_id, teacher_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(sessionId, teacherId, now.toISOString(), expires.toISOString(), now.toISOString()).run();
  return { sessionId, expiresAt: expires };
}

async function getSession(db, sessionId) {
  if (!sessionId) return null;
  const row = await db.prepare(
    `SELECT session_id, teacher_id, expires_at FROM sessions WHERE session_id = ?`
  ).bind(sessionId).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run().catch(() => {});
    return null;
  }
  return row;
}

async function touchSession(db, sessionId) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE session_id = ?`)
    .bind(now, sessionId).run();
}

async function deleteSession(db, sessionId) {
  if (!sessionId || !db) return;
  await db.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run();
}

function getSessionIdFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)session_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function requireTeacher(request, env) {
  const db = await getDbBinding(env);
  if (!db) return null;
  const sessionId = getSessionIdFromCookie(request);
  if (!sessionId) return null;
  const session = await getSession(db, sessionId);
  if (!session) return null;
  // Refresh last_seen_at asynchronously (fire-and-forget)
  touchSession(db, sessionId).catch(() => {});
  return session.teacher_id;
}

// Upsert (insert or update) a teacher row
async function upsertTeacher(db, id, email, name) {
  if (!db || !id) return;
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO teachers (id, email, name, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name`
  ).bind(id, email || '', name || '', now).run();
}

// (CORS helpers are now defined inside the fetch handler for per-request origin support)

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // Per-request CORS — must reflect origin (not '*') so cookies are accepted
    const requestOrigin = request.headers.get('Origin');
    const cors = {
      "Access-Control-Allow-Origin":      requestOrigin || '*',
      "Access-Control-Allow-Methods":     "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":     "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Vary":                             "Origin",
    };
    const ok  = (data, extra = {}) => new Response(JSON.stringify(data), {
      status:  200,
      headers: { "Content-Type": "application/json", ...cors, ...extra },
    });
    const err = (msg, status = 500) => new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json", ...cors },
    });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {

      // ════════════════════════════════════════════════════
      // POST /create-bunny-video
      // ════════════════════════════════════════════════════
      if (path === "/create-bunny-video" && request.method === "POST") {
        const { title } = await request.json().catch(() => ({}));
        const res = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos`,
          {
            method: "POST",
            headers: { AccessKey: env.BUNNY_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ title: title || "exercise" }),
          }
        );
        if (!res.ok) return err("Bunny create failed: " + res.status);
        const data = await res.json();
        return ok({ guid: data.guid, libraryId: env.BUNNY_LIBRARY_ID, cdnHost: env.BUNNY_CDN_HOST });
      }

      // ════════════════════════════════════════════════════
      // PUT /upload-bunny-chunk?guid=...
      // ════════════════════════════════════════════════════
      if (path === "/upload-bunny-chunk" && request.method === "PUT") {
        const guid = url.searchParams.get("guid");
        if (!guid) return err("Missing guid", 400);
        const res = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${guid}`,
          { method: "PUT", headers: { AccessKey: env.BUNNY_API_KEY }, body: request.body, duplex: "half" }
        );
        if (!res.ok) return err("Bunny upload failed: " + res.status);
        return ok({ ok: true });
      }

      // ════════════════════════════════════════════════════
      // GET /bunny-status?guid=...
      // ════════════════════════════════════════════════════
      if (path === "/bunny-status" && request.method === "GET") {
        const guid = url.searchParams.get("guid");
        if (!guid) return err("Missing guid", 400);
        const res = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${guid}`,
          { headers: { AccessKey: env.BUNNY_API_KEY } }
        );
        if (!res.ok) return err("Bunny status failed: " + res.status);
        const data = await res.json();
        const done   = data.status === 4;
        const failed = data.status === 5 || data.status === 6;
        const cdnUrl = done ? `https://${env.BUNNY_CDN_HOST}/${guid}/play_360p.mp4` : null;
        return ok({ done, failed, cdnUrl, encodeProgress: data.encodeProgress || 0 });
      }

      // ════════════════════════════════════════════════════
      // POST /transcribe
      // ════════════════════════════════════════════════════
      if (path === "/transcribe" && request.method === "POST") {
        const { audioUrl } = await request.json().catch(() => ({}));
        if (!audioUrl) return err("Missing audioUrl", 400);
        const res = await fetch("https://api.assemblyai.com/v2/transcript", {
          method: "POST",
          headers: { authorization: env.ASSEMBLYAI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            audio_url:     audioUrl,
            speech_models: ["universal-3-5-pro","universal-2"],
            punctuate:     true,
            format_text:   true,
            disfluencies:  false,
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          return err("AssemblyAI submit failed: " + (e.error || res.status));
        }
        const data = await res.json();
        return ok({ pending: true, jobId: data.id });
      }

      // ════════════════════════════════════════════════════
      // GET /transcribe-status?jobId=...
      // ════════════════════════════════════════════════════
      if (path === "/transcribe-status" && request.method === "GET") {
        const jobId = url.searchParams.get("jobId");
        if (!jobId) return err("Missing jobId", 400);
        const res = await fetch(`https://api.assemblyai.com/v2/transcript/${jobId}`, {
          headers: { authorization: env.ASSEMBLYAI_API_KEY },
        });
        if (!res.ok) return err("AssemblyAI status failed: " + res.status);
        const data = await res.json();
        if (data.status === "completed") {
          const words = (data.words || []).map(w => ({ text: w.text, start: w.start, end: w.end }));
          return ok({ done: true, text: data.text || "", words });
        } else if (data.status === "error") {
          return ok({ done: false, error: data.error || "Transcription failed" });
        } else {
          return ok({ done: false });
        }
      }

      // ════════════════════════════════════════════════════
      // POST /generate-gaps
      // ════════════════════════════════════════════════════
      if (path === "/generate-gaps" && request.method === "POST") {
        const { transcript, level } = await request.json().catch(() => ({}));
        if (!transcript) return err("Missing transcript", 400);

        const prompt =
`You are an English language teacher creating a gap-fill listening exercise at ${level || "B1"} CEFR level.

Given the following transcript, select the most appropriate words to remove as gaps for students at this level.

Rules:
- Choose content words (nouns, verbs, adjectives, key adverbs) — NOT grammar/function words like "the", "a", "is", "and"
- Choose words suitable for ${level || "B1"} difficulty
- Aim for roughly one gap per sentence, more for longer sentences
- Return ONLY valid JSON, nothing else

Return this exact structure:
{
  "sections": [
    { "sentence": "the original sentence text", "answers": ["word1"] },
    { "sentence": "another sentence", "answers": ["word2", "word3"] }
  ]
}

Transcript:
${transcript}`;

        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "openai/gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.3,
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          return err("OpenRouter failed: " + (e.error?.message || res.status));
        }
        const data = await res.json();
        let result;
        try { result = JSON.parse(data.choices[0].message.content); }
        catch (e) { return err("AI returned invalid JSON", 502); }
        return ok(result);
      }

      // ════════════════════════════════════════════════════
      // POST /save-lesson  (student lessons — existing)
      // ════════════════════════════════════════════════════
      if (path === "/save-lesson" && request.method === "POST") {
        const lesson = await request.json().catch(() => null);
        if (!lesson || !lesson.videoUrl) return err("Missing or invalid lesson", 400);

        // Preserve the established KV implementation whenever LESSONS is bound.
        if (env.LESSONS) {
          let id = generateId();
          if (await env.LESSONS.get(id)) id = generateId();
          await env.LESSONS.put(id, JSON.stringify(lesson), { expirationTtl: 31_536_000 });
          return ok({ id });
        }

        // The deployed app already supports D1 for teacher activities. Use it
        // only as a safe storage fallback if this Worker has no KV binding.
        const db = await getDbBinding(env);
        if (!db) return err("No lesson storage is bound (configure KV LESSONS or D1)", 500);
        await ensureDbSchema(db);
        let id = generateId();
        if (await db.prepare(`SELECT id FROM student_lessons WHERE id = ?`).bind(id).first()) id = generateId();
        const expiresAt = new Date(Date.now() + 31_536_000_000).toISOString();
        await db.prepare(`INSERT INTO student_lessons (id, lesson_json, expires_at) VALUES (?, ?, ?)`)
          .bind(id, JSON.stringify(lesson), expiresAt).run();
        return ok({ id });
      }

      // ════════════════════════════════════════════════════
      // GET /load-lesson?id=...
      // ════════════════════════════════════════════════════
      if (path === "/load-lesson" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return err("Missing id", 400);

        // Existing and new KV-backed share links continue to use KV unchanged.
        if (env.LESSONS) {
          const raw = await env.LESSONS.get(id);
          if (!raw) return err("Lesson not found", 404);
          return ok(JSON.parse(raw));
        }

        const db = await getDbBinding(env);
        if (!db) return err("No lesson storage is bound (configure KV LESSONS or D1)", 500);
        await ensureDbSchema(db);
        const row = await db.prepare(`SELECT lesson_json, expires_at FROM student_lessons WHERE id = ?`).bind(id).first();
        if (!row || new Date(row.expires_at) < new Date()) {
          if (row) await db.prepare(`DELETE FROM student_lessons WHERE id = ?`).bind(id).run();
          return err("Lesson not found", 404);
        }
        return ok(JSON.parse(row.lesson_json));
      }

      // ════════════════════════════════════════════════════
      // POST /gdrive-to-bunny
      // ════════════════════════════════════════════════════
      if (path === "/gdrive-to-bunny" && request.method === "POST") {
        const { driveUrl, title } = await request.json().catch(() => ({}));
        if (!driveUrl) return err("Missing driveUrl", 400);

        let fileId = null;
        const m1 = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
        const m2 = driveUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (m1) fileId = m1[1];
        else if (m2) fileId = m2[1];
        if (!fileId) return err("Could not extract Google Drive file ID.", 400);

        const downloadUrl =
          `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

        const driveRes = await fetch(downloadUrl, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (compatible; GapFillBot/1.0)" },
        });
        if (!driveRes.ok) {
          return err(`Google Drive download failed (${driveRes.status}). Make sure the file is shared publicly.`, 502);
        }
        const ct = driveRes.headers.get("content-type") || "";
        if (ct.includes("text/html")) {
          return err("Google Drive returned an HTML page. Ensure the file is shared publicly.", 502);
        }

        const createRes = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos`,
          {
            method: "POST",
            headers: { AccessKey: env.BUNNY_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ title: title || "gdrive-import" }),
          }
        );
        if (!createRes.ok) return err("Bunny create failed: " + createRes.status);
        const created = await createRes.json();
        const guid = created.guid;

        const uploadRes = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${guid}`,
          { method: "PUT", headers: { AccessKey: env.BUNNY_API_KEY }, body: driveRes.body, duplex: "half" }
        );
        if (!uploadRes.ok) return err("Bunny upload from Drive failed: " + uploadRes.status);

        return ok({ guid, libraryId: env.BUNNY_LIBRARY_ID, cdnHost: env.BUNNY_CDN_HOST });
      }
      // ================================
// IMPORT VIDEO (Tunelio)
// ================================
if (path === "/import-video" && request.method === "POST") {
  try {

    const body = await request.json();
    const url = body.url;

    if (!url) {
      return err("Missing video URL.", 400);
    }

    const tunelioUrl =
    `https://tunelio.dev/create?quality=360p&url=${encodeURIComponent(url)}`;

const res = await fetch(tunelioUrl, {
    headers: {
        "Authorization": `Bearer ${env.TUNELIO_API_KEY}`
    }
});

const data = await res.json();

if (!res.ok) {
    return err(
        data.message || data.error || "Tunelio request failed.",
        res.status
    );
}

return ok(data);

  } catch (e) {
    return err(e.message || "Import failed.", 500);
  }
}
      // ════════════════════════════════════════════════════
      // POST /save-teacher-exercise
      // Body: { teacherId, exerciseId?, name, sentences,
      //         videoUrl, createdAt, lessonId? }
      // Returns: { exerciseId }
      // Stores index under teacher_index_{teacherId}
      // Stores exercise under teacher_ex_{exerciseId}
      // ════════════════════════════════════════════════════
      if (path === "/save-teacher-exercise" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return err("Missing request body", 400);

        // Authenticate via session cookie (preferred) or fall back to body.teacherId
        // for anonymous (non-Google) users who have no session.
        let teacherId = await requireTeacher(request, env);
        if (!teacherId) {
          teacherId = body.teacherId || null;
        }
        if (!teacherId) return err("Not authenticated", 401);
        const exerciseId = body.exerciseId || ("ex_" + generateId(10));
        const now        = new Date().toISOString();

        // Full exercise data (with sentences for re-opening)
        const exerciseData = {
  exerciseId,
  teacherId,
  name: body.name || "Untitled Exercise",
  createdAt: body.createdAt || now,
  updatedAt: now,

  lessonId: body.lessonId || null,

  videoMode: body.videoMode || null,

  videoUrl: body.videoUrl || "",

  youtubeVideoId: body.youtubeVideoId || null,

  youtubeTitle: body.youtubeTitle || null,

  sentences: body.sentences || [],

  tags: Array.isArray(body.tags) ? body.tags : [],

  originalTranscript: body.originalTranscript || null,
};

        // Prefer D1 if available, otherwise fallback to KV LESSONS
        const db = await getDbBinding(env);
        if (db) {
          await ensureDbSchema(db);
          // Ensure teacher row exists in D1 (session was already verified; upsert with id only)
          try {
            await upsertTeacher(db, teacherId, '', '');
          } catch (e) {
            // ignore
          }
          // Upsert into D1
          const sentencesStr = JSON.stringify(exerciseData.sentences || []);
          // Insert using existing D1 schema
          await db.prepare(
            `INSERT INTO exercises (id, teacher_id, title, exercise_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               teacher_id=excluded.teacher_id, title=excluded.title, exercise_json=excluded.exercise_json, updated_at=excluded.updated_at`)
            .bind(exerciseId, exerciseData.teacherId, exerciseData.name, JSON.stringify(exerciseData), exerciseData.createdAt, exerciseData.updatedAt)
            .run();

          return ok({ exerciseId });
        }

        // Fallback: KV-based storage
        if (!env.LESSONS) return err("KV namespace LESSONS not bound", 500);
        await env.LESSONS.put(
          "teacher_ex_" + exerciseId,
          JSON.stringify(exerciseData),
          { expirationTtl: 31_536_000 }
        );

        // Update teacher index (list of exerciseIds + metadata)
        const indexKey = "teacher_index_" + teacherId;
        let index = [];
        const rawIndex = await env.LESSONS.get(indexKey);
        if (rawIndex) {
          try { index = JSON.parse(rawIndex); } catch {}
        }

        // Update or insert in index
        const existingIdx = index.findIndex(e => e.exerciseId === exerciseId);
        const indexEntry = {
          exerciseId,
          name:      exerciseData.name,
          createdAt: exerciseData.createdAt,
          updatedAt: now,
          lessonId:  exerciseData.lessonId,
          videoUrl:  exerciseData.videoUrl,
          // Store sentence/gap counts for display (lightweight)
          sentenceCount: (body.sentences || []).length,
          gapCount: (body.sentences || []).reduce((n, s) =>
            n + (s.words || []).filter(w => w.g).length, 0),
          // Slim sentences for the list view
          sentences: body.sentences || [],
        };

        if (existingIdx >= 0) {
          index[existingIdx] = indexEntry;
        } else {
          index.unshift(indexEntry); // newest first
        }

        // Keep max 200 exercises per teacher
        if (index.length > 200) index = index.slice(0, 200);

        await env.LESSONS.put(indexKey, JSON.stringify(index), { expirationTtl: 31_536_000 });

        return ok({ exerciseId });
      }

      // ════════════════════════════════════════════════════
      // GET /list-teacher-exercises?teacherId=...
      // Returns: { exercises: [...] }
      // ════════════════════════════════════════════════════
      if (path === "/list-teacher-exercises" && request.method === "GET") {
        const teacherId = url.searchParams.get("teacherId");
        if (!teacherId) return err("Missing teacherId", 400);

        const db = await getDbBinding(env);
        if (db) {
          await ensureDbSchema(db);
          const rows = await db.prepare(
            `SELECT id, title, exercise_json, created_at, updated_at FROM exercises WHERE teacher_id = ? ORDER BY updated_at DESC LIMIT 200`
          ).bind(teacherId).all();
          const results = (rows && rows.results) ? rows.results : [];
          const exercises = results.map(r => {
            let parsed = {};
            try { parsed = JSON.parse(r.exercise_json || '{}'); } catch (e) { parsed = {}; }
            return {
              exerciseId: r.id,
              name: r.title || parsed.name || parsed.title || '',
              createdAt: r.created_at || parsed.createdAt || parsed.created_at || null,
              updatedAt: r.updated_at || parsed.updatedAt || parsed.updated_at || null,
              lessonId: parsed.lessonId || parsed.lesson_id || null,
              videoUrl: parsed.videoUrl || parsed.video_url || null,
              sentences: parsed.sentences || [],
              tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            };
          });
          return ok({ exercises });
        }

        if (!env.LESSONS) return err("KV namespace LESSONS not bound", 500);
        const rawIndex = await env.LESSONS.get("teacher_index_" + teacherId);
        if (!rawIndex) return ok({ exercises: [] });
        let index = [];
        try { index = JSON.parse(rawIndex); } catch {}
        return ok({ exercises: index });
      }

      // ════════════════════════════════════════════════════
      // POST /verify-google-token
      // Body: { idToken }
      // Returns: { valid: true, payload } or error
      // ════════════════════════════════════════════════════
      if (path === "/verify-google-token" && request.method === "POST") {
        const { idToken } = await request.json().catch(() => ({}));
        if (!idToken) return err("Missing idToken", 400);
        const payload = await verifyGoogleIdToken(idToken);
        if (!payload) return err("Invalid or expired idToken", 401);
        return ok({ valid: true, payload });
      }


      // ════════════════════════════════════════════════════
      // POST /google-login
      // Body: { idToken, oldTeacherId? }
      // Verifies the Google ID token ONCE, creates a server-side session,
      // returns a secure HttpOnly cookie. All future requests use the cookie.
      // ════════════════════════════════════════════════════
      if (path === "/google-login" && request.method === "POST") {
        const { idToken, oldTeacherId } = await request.json().catch(() => ({}));
        if (!idToken) return err("Missing idToken", 400);
        const payload = await verifyGoogleIdToken(idToken);
        if (!payload) return err("Invalid or expired idToken", 401);
        const teacherId = "g_" + payload.sub;

        const db = await getDbBinding(env);
        if (!db) return err("Database not available", 500);
        await ensureDbSchema(db);
        await upsertTeacher(db, teacherId, payload.email || '', payload.name || '');

        // Migrate anonymous exercises if oldTeacherId provided
        if (oldTeacherId && typeof oldTeacherId === 'string' && oldTeacherId.startsWith('t_') && env.LESSONS) {
          try {
            const rawIndex = await env.LESSONS.get("teacher_index_" + oldTeacherId);
            if (rawIndex) {
              const oldIndex = JSON.parse(rawIndex).catch ? [] : JSON.parse(rawIndex);
              for (const entry of (Array.isArray(oldIndex) ? oldIndex : [])) {
                const exId = entry.exerciseId;
                if (!exId) continue;
                const raw = await env.LESSONS.get("teacher_ex_" + exId);
                if (!raw) continue;
                const exerciseData = JSON.parse(raw);
                exerciseData.teacherId = teacherId;
                await db.prepare(
                  `INSERT INTO exercises (id, teacher_id, title, exercise_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     teacher_id=excluded.teacher_id, title=excluded.title,
                     exercise_json=excluded.exercise_json, updated_at=excluded.updated_at`
                ).bind(exId, teacherId, exerciseData.name || '', JSON.stringify(exerciseData),
                       exerciseData.createdAt || new Date().toISOString(),
                       exerciseData.updatedAt || new Date().toISOString()).run();
                await env.LESSONS.delete("teacher_ex_" + exId);
              }
              await env.LESSONS.delete("teacher_index_" + oldTeacherId);
            }
          } catch (migErr) {
            console.warn("Migration error during /google-login:", migErr);
          }
        }

        const { sessionId, expiresAt } = await createSession(db, teacherId);
        const cookieValue = `session_id=${encodeURIComponent(sessionId)}; HttpOnly; Secure; SameSite=None; Max-Age=2592000; Path=/`;
        return ok(
          { ok: true, teacherId, name: payload.name || '', email: payload.email || '' },
          { "Set-Cookie": cookieValue }
        );
      }

      // ════════════════════════════════════════════════════
      // POST /logout
      // Deletes the server-side session and clears the cookie.
      // ════════════════════════════════════════════════════
      if (path === "/logout" && request.method === "POST") {
        const db = await getDbBinding(env);
        if (db) {
          const sessionId = getSessionIdFromCookie(request);
          await deleteSession(db, sessionId);
        }
        const clearCookie = `session_id=; HttpOnly; Secure; SameSite=None; Max-Age=0; Path=/`;
        return ok({ ok: true }, { "Set-Cookie": clearCookie });
      }

      // ════════════════════════════════════════════════════
      // POST /migrate-teacher-exercises
      // Body: { oldTeacherId }
      // Authenticated via session cookie. Moves exercises from KV (old anonymous teacher index)
      // into D1 under the signed-in Google teacher id.
      // ════════════════════════════════════════════════════
      if (path === "/migrate-teacher-exercises" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const { oldTeacherId } = body || {};
        // Authenticate via session cookie
        const newTeacherId = await requireTeacher(request, env);
        if (!newTeacherId) return err("Not authenticated", 401);
        if (!oldTeacherId || typeof oldTeacherId !== 'string') return ok({ migrated: 0 });
        // Only migrate from anonymous-style teacher ids (t_...)
        if (!oldTeacherId.startsWith('t_')) return ok({ migrated: 0 });

        // If D1 is available, migrate into D1. Otherwise, migrate within KV indices.
        const db = await getDbBinding(env);
        let migrated = 0;

        // Read old index from KV (if present)
        const rawIndex = env.LESSONS ? await env.LESSONS.get("teacher_index_" + oldTeacherId) : null;
        let oldIndex = [];
        if (rawIndex) {
          try { oldIndex = JSON.parse(rawIndex); } catch (e) { oldIndex = []; }
        }

        // If there are no entries in KV index, nothing to migrate
        if (!oldIndex.length) return ok({ migrated: 0 });

        if (db) {
          await ensureDbSchema(db);
          // For each exercise in oldIndex, try to read KV exercise and upsert into D1
          for (const entry of oldIndex) {
            try {
              const exId = entry.exerciseId;
              if (!exId) continue;
              // If exercise already exists in D1, skip or update teacherId
              const existRes = await db.prepare(`SELECT id, teacher_id FROM exercises WHERE id = ?`).bind(exId).first();
              const existRow = existRes && existRes.results ? existRes.results[0] : existRes;
              if (existRow && existRow.teacher_id === newTeacherId) continue;

              // Load KV backing (if present)
              let raw = null;
              if (env.LESSONS) raw = await env.LESSONS.get("teacher_ex_" + exId);
              if (!raw) {
                // Nothing to migrate for this id
                continue;
              }
              const exerciseData = JSON.parse(raw);
              exerciseData.teacherId = newTeacherId;
              const sentencesStr = JSON.stringify(exerciseData.sentences || []);

              await db.prepare(
                `INSERT INTO exercises (id, teacher_id, title, exercise_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   teacher_id=excluded.teacher_id, title=excluded.title, exercise_json=excluded.exercise_json, updated_at=excluded.updated_at`
              ).bind(exId, exerciseData.teacherId, exerciseData.name || '', JSON.stringify(exerciseData), exerciseData.createdAt || new Date().toISOString(), exerciseData.updatedAt || new Date().toISOString()).run();

              migrated++;
              // Optionally remove old KV entry and index entry
              if (env.LESSONS) {
                await env.LESSONS.delete("teacher_ex_" + exId);
              }
            } catch (e) {
              // ignore individual failures
            }
          }

          // Remove old index key
          if (env.LESSONS) await env.LESSONS.delete("teacher_index_" + oldTeacherId);
          return ok({ migrated });
        }

        // Fallback: move entries in KV by copying to new index and updating stored exercise teacherId
        if (env.LESSONS) {
          const newIndexKey = "teacher_index_" + newTeacherId;
          let newIndex = [];
          const rawNew = await env.LESSONS.get(newIndexKey);
          if (rawNew) {
            try { newIndex = JSON.parse(rawNew); } catch (e) { newIndex = []; }
          }

          for (const entry of oldIndex) {
            try {
              const exId = entry.exerciseId;
              if (!exId) continue;
              const raw = await env.LESSONS.get("teacher_ex_" + exId);
              if (!raw) continue;
              const exerciseData = JSON.parse(raw);
              exerciseData.teacherId = newTeacherId;
              await env.LESSONS.put("teacher_ex_" + exId, JSON.stringify(exerciseData), { expirationTtl: 31_536_000 });
              // Add to new index if not present
              if (!newIndex.find(e => e.exerciseId === exId)) {
                newIndex.unshift({ exerciseId: exId, name: exerciseData.name, createdAt: exerciseData.createdAt, updatedAt: exerciseData.updatedAt, lessonId: exerciseData.lessonId, videoUrl: exerciseData.videoUrl, sentenceCount: (exerciseData.sentences || []).length, gapCount: (exerciseData.sentences || []).reduce((n,s)=> n + (s.words||[]).filter(w=>w.g).length,0), sentences: exerciseData.sentences || [] });
              }
              migrated++;
            } catch (e) {
              // ignore
            }
          }

          // Save new index and remove old index
          await env.LESSONS.put(newIndexKey, JSON.stringify(newIndex), { expirationTtl: 31_536_000 });
          await env.LESSONS.delete("teacher_index_" + oldTeacherId);
          return ok({ migrated });
        }

        return ok({ migrated: 0 });
      }

      // ════════════════════════════════════════════════════
      // GET /load-teacher-exercise?teacherId=...&exerciseId=...
      // Returns: full exercise object
      // ════════════════════════════════════════════════════
      if (path === "/load-teacher-exercise" && request.method === "GET") {
        const teacherId  = url.searchParams.get("teacherId");
        const exerciseId = url.searchParams.get("exerciseId");
        if (!teacherId || !exerciseId) return err("Missing teacherId or exerciseId", 400);

        const db = await getDbBinding(env);
        if (db) {
          await ensureDbSchema(db);
          const rowRes = await db.prepare(`SELECT id, teacher_id, title, exercise_json, created_at, updated_at FROM exercises WHERE id = ?`).bind(exerciseId).first();
          const row = rowRes && rowRes.results ? rowRes.results[0] : rowRes;
          if (!row) return err("Exercise not found", 404);
          if (row.teacher_id !== teacherId) return err("Not authorised", 403);
          let parsed = {};
          try { parsed = JSON.parse(row.exercise_json || '{}'); } catch (e) { parsed = {}; }
          const exercise = {
            exerciseId: row.id,
            teacherId: row.teacher_id,
            name: row.title || parsed.name || parsed.title || '',
            createdAt: row.created_at || parsed.createdAt || parsed.created_at || null,
            updatedAt: row.updated_at || parsed.updatedAt || parsed.updated_at || null,
            lessonId: parsed.lessonId || parsed.lesson_id || null,

videoMode: parsed.videoMode || parsed.video_mode || null,

videoUrl: parsed.videoUrl || parsed.video_url || null,

youtubeVideoId:
  parsed.youtubeVideoId ||
  parsed.youtube_video_id ||
  null,

youtubeTitle:
  parsed.youtubeTitle ||
  parsed.youtube_title ||
  null,

sentences: parsed.sentences || [],
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            originalTranscript: parsed.originalTranscript || null,
          };
          return ok(exercise);
        }

        if (!env.LESSONS) return err("KV namespace LESSONS not bound", 500);
        const raw = await env.LESSONS.get("teacher_ex_" + exerciseId);
        if (!raw) return err("Exercise not found", 404);
        const exercise = JSON.parse(raw);
        // Security: only return if it belongs to this teacher
        if (exercise.teacherId !== teacherId) return err("Not authorised", 403);
        return ok(exercise);
      }

     async function getTranscriptFromTranscriptAPI(videoUrl, apiKey) {

  const endpoint =
    "https://transcriptapi.com/api/v2/youtube/transcript?" +
    new URLSearchParams({
      video_url: videoUrl,
      include_timestamp: "true",
      send_metadata: "true"
    });

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.message || data.error || "TranscriptAPI request failed."
    );
  }

  return data;
}
      // ════════════════════════════════════════════════════
// POST /youtube-transcript
// Tests YouTube integration
// ════════════════════════════════════════════════════
if (path === "/youtube-transcript" && request.method === "POST") {

  if (!env.TRANSCRIPT_API_KEY) {
    return err("TRANSCRIPT_API_KEY secret is missing.", 500);
  }

  const body = await request.json().catch(() => null);

  if (!body?.youtubeUrl) {
    return err("Missing YouTube URL.", 400);
  }

  const transcript = await getTranscriptFromTranscriptAPI(
    body.youtubeUrl,
    env.TRANSCRIPT_API_KEY
);

return ok(transcript);

}

// ════════════════════════════════════════════════════
// POST /refine-youtube-timings
// Refines only YouTube sentence boundaries from TranscriptAPI captions.
// ════════════════════════════════════════════════════
if (path === "/refine-youtube-timings" && request.method === "POST") {
  const body = await request.json().catch(() => null);
  const { transcript, sentences } = body || {};

  if (!Array.isArray(transcript) || !Array.isArray(sentences) || !sentences.length) {
    return err("transcript and sentences are required arrays", 400);
  }
  if (!transcript.every(chunk =>
    chunk && typeof chunk.text === "string" &&
    Number.isFinite(chunk.start) && Number.isFinite(chunk.duration)
  ) || !sentences.every(sentence => typeof sentence === "string" && sentence.trim())) {
    return err("Invalid transcript or sentence data", 400);
  }

  const prompt = `You refine timing boundaries for a YouTube listening exercise.

Caption chunks (each has text, start, and duration):
${JSON.stringify(transcript)}

Exercise sentences, in their required unchanged order:
${JSON.stringify(sentences)}

Return JSON only in this exact shape:
{"sentences":[{"text":"exact original exercise sentence","start":0.42,"end":2.91}]}

Rules:
- Return exactly one object for every exercise sentence, in the same order.
- Copy every sentence text character-for-character from the exercise-sentence list. Never change, add, remove, or invent words.
- Use caption chunks only to improve sentence boundaries.
- Timings must be chronological and must not overlap. A natural silence between sentences is allowed.
- Each sentence must begin where its first spoken word begins and end where its final spoken word ends.
- Do not extend a sentence into the next caption's spoken content. When an exercise sentence exactly equals one caption chunk, keep that chunk's start and end window.
- Each end must be greater than its start.
- Return JSON only.`;

  const ai = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.OPENROUTER_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!ai.ok) {
    const error = await ai.json().catch(() => ({}));
    return err("OpenRouter failed: " + (error.error?.message || ai.status), 502);
  }

  let result;
  try {
    result = JSON.parse((await ai.json()).choices[0].message.content);
  } catch (e) {
    return err("AI returned invalid JSON", 502);
  }

  const refined = result && result.sentences;
  const isValid = Array.isArray(refined) && refined.length === sentences.length &&
    refined.every((item, index) =>
      item && item.text === sentences[index] &&
      Number.isFinite(item.start) && Number.isFinite(item.end) &&
      item.start >= 0 && item.end > item.start &&
      (index === 0 || item.start >= refined[index - 1].end)
    );
  if (!isValid) return err("AI returned invalid sentence timings", 502);

  return ok({ sentences: refined });
}

// ════════════════════════════════════════════════════
// POST /align-youtube-sentences
// Uses AI to improve sentence timings from TranscriptAPI captions
// ════════════════════════════════════════════════════
if (path === "/align-youtube-sentences" && request.method === "POST") {

  const body = await request.json().catch(() => null);

  if (!body) {
    return err("Missing request body.", 400);
  }

  const { transcript, sentences } = body;

  if (!Array.isArray(transcript) || !Array.isArray(sentences)) {
    return err("Invalid request.", 400);
  }

 const prompt = `
You are aligning subtitles for an English listening exercise.

You are given:

1. Caption chunks from YouTube.
Each chunk contains:
- text
- start time
- duration

2. A list of complete sentences.

Your job is to determine the best start and end time for EACH sentence.

Rules:

- Every sentence must begin where its first spoken word begins.
- Every sentence must end where its final spoken word ends.
- Never invent words.
- Never change sentence order.
- Use the caption timings to estimate the correct boundaries.
- If a sentence spans multiple caption chunks, merge them.
- Return ONLY valid JSON.

Format:

{
  "sentences":[
    {
      "start":0.00,
      "end":4.52
    }
  ]
}

Caption chunks:

${JSON.stringify(transcript)}

Sentences:

${JSON.stringify(sentences)}
`;
const ai = await fetch(
  "https://openrouter.ai/api/v1/chat/completions",
  {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.OPENROUTER_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: {
        type: "json_object"
      },
      temperature: 0,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  }
);
if (!ai.ok) {

  const error = await ai.text();

  return err(error, 500);

}
const data = await ai.json();

const result = JSON.parse(
  data.choices[0].message.content
);

return ok(result);
}
      // ════════════════════════════════════════════════════
      // DELETE /delete-teacher-exercise
      // Body: { teacherId, exerciseId }
      // ════════════════════════════════════════════════════
      if (path === "/delete-teacher-exercise" && request.method === "DELETE") {
        const body = await request.json().catch(() => ({}));
        if (!body) return err("Missing request body", 400);
        let { teacherId, exerciseId } = body;

        // Authenticate via session cookie (preferred) or fall back to body.teacherId
        const sessionTeacherId = await requireTeacher(request, env);
        if (sessionTeacherId) {
          teacherId = sessionTeacherId;
        }
        if (!teacherId || !exerciseId) return err("Missing teacherId or exerciseId", 400);

        const db = await getDbBinding(env);
        if (db) {
          await ensureDbSchema(db);
          // Verify ownership and delete in one step (use D1 schema columns)
          const rowRes = await db.prepare(`SELECT id, teacher_id FROM exercises WHERE id = ?`).bind(exerciseId).first();
          const row = rowRes && rowRes.results ? rowRes.results[0] : rowRes;
          if (!row) return ok({ deleted: true }); // nothing to delete
          if (row.teacher_id !== teacherId) return err("Not authorised", 403);
          await db.prepare(`DELETE FROM exercises WHERE id = ?`).bind(exerciseId).run();
          return ok({ deleted: true });
        }

        if (!env.LESSONS) return err("KV namespace LESSONS not bound", 500);
        // Verify ownership before deleting
        const raw = await env.LESSONS.get("teacher_ex_" + exerciseId);
        if (raw) {
          const exercise = JSON.parse(raw);
          if (exercise.teacherId !== teacherId) return err("Not authorised", 403);
          await env.LESSONS.delete("teacher_ex_" + exerciseId);
        }

        // Remove from index
        const indexKey = "teacher_index_" + teacherId;
        const rawIndex = await env.LESSONS.get(indexKey);
        if (rawIndex) {
          let index = [];
          try { index = JSON.parse(rawIndex); } catch {}
          index = index.filter(e => e.exerciseId !== exerciseId);
          await env.LESSONS.put(indexKey, JSON.stringify(index), { expirationTtl: 31_536_000 });
        }

        return ok({ deleted: true });
      }

      // ════════════════════════════════════════════════════
      // POST /generate-summary (kept for future use)
      // ════════════════════════════════════════════════════
      if (path === "/generate-summary" && request.method === "POST") {
        const { transcript } = await request.json().catch(() => ({}));
        if (!transcript) return err("Missing transcript", 400);
        const prompt =
`You are an English language teacher. Given the video transcript below, write a clear summary of 4-6 sentences. Plain text only, no formatting.\n\nTranscript:\n${transcript}`;
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.OPENROUTER_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.4 }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          return err("OpenRouter summary failed: " + (e.error?.message || res.status));
        }
        const data = await res.json();
        return ok({ summary: (data.choices[0].message.content || "").trim() });
      }

      return err("Not found", 404);

    } catch (e) {
      console.error(e);
      return err(e.message || "Internal server error", 500);
    }
  },
};
