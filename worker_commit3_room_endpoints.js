// ════════════════════════════════════════════════════
// ROOM MANAGEMENT ENDPOINTS (COMMIT 3)
// ════════════════════════════════════════════════════

// Generate a random 6-character room code
function generateRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // No confusing 0/O, 1/I
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Helper: Verify room ownership (teacher must own the room)
async function verifyRoomOwnership(db, roomId, teacherId) {
  if (!db || !roomId || !teacherId) return null;
  const row = await db.prepare(
    `SELECT id, teacher_id FROM rooms WHERE id = ?`
  ).bind(roomId).first();
  if (!row) return null;
  if (row.teacher_id !== teacherId) return null;
  return row;
}

// ════════════════════════════════════════════════════
// POST /room/create
// Body: { name }
// Returns: { roomId, roomCode, name, createdAt }
// Authenticated teacher creates a new room
// ════════════════════════════════════════════════════
if (path === "/room/create" && request.method === "POST") {
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const body = await request.json().catch(() => ({}));
  const name = (body.name || "New Room").trim();
  if (!name) return err("Room name is required", 400);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const roomId = "room_" + generateId(12);
  let roomCode = generateRoomCode();
  
  // Verify room code is unique (extremely unlikely, but handle it)
  let existing = await db.prepare(
    `SELECT id FROM rooms WHERE room_code = ?`
  ).bind(roomCode).first();
  if (existing) {
    roomCode = generateRoomCode();
    existing = await db.prepare(
      `SELECT id FROM rooms WHERE room_code = ?`
    ).bind(roomCode).first();
    if (existing) return err("Could not generate unique room code", 500);
  }
  
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO rooms (id, teacher_id, name, room_code, created_at, updated_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(roomId, teacherId, name, roomCode, now, now).run();
  
  return ok({ roomId, roomCode, name, createdAt: now });
}

// ════════════════════════════════════════════════════
// GET /room/list
// Returns: { rooms: [{ roomId, roomCode, name, created_at, member_count, activity_count }] }
// List all rooms for authenticated teacher
// ════════════════════════════════════════════════════
if (path === "/room/list" && request.method === "GET") {
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const rows = await db.prepare(
    `SELECT id, name, room_code, created_at, updated_at, archived
     FROM rooms
     WHERE teacher_id = ? AND archived = 0
     ORDER BY updated_at DESC`
  ).bind(teacherId).all();
  
  const results = (rows && rows.results) ? rows.results : [];
  const rooms = [];
  
  for (const row of results) {
    // Count members
    const membersRes = await db.prepare(
      `SELECT COUNT(*) as count FROM room_members WHERE room_id = ?`
    ).bind(row.id).first();
    const memberCount = membersRes ? membersRes.count : 0;
    
    // Count activities
    const activitiesRes = await db.prepare(
      `SELECT COUNT(*) as count FROM room_activities WHERE room_id = ?`
    ).bind(row.id).first();
    const activityCount = activitiesRes ? activitiesRes.count : 0;
    
    rooms.push({
      roomId: row.id,
      roomCode: row.room_code,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      memberCount,
      activityCount,
    });
  }
  
  return ok({ rooms });
}

// ════════════════════════════════════════════════════
// GET /room/:roomId
// Returns: { room, members, activities }
// Get room details, members, and assigned activities
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+$/) && request.method === "GET") {
  const roomId = path.split("/")[2];
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  // Verify ownership
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  const roomRow = await db.prepare(
    `SELECT id, name, room_code, created_at, updated_at FROM rooms WHERE id = ?`
  ).bind(roomId).first();
  
  const membersRows = await db.prepare(
    `SELECT rm.id, rm.student_id, rm.joined_at
     FROM room_members rm
     WHERE rm.room_id = ?
     ORDER BY rm.joined_at DESC`
  ).bind(roomId).all();
  const members = (membersRows && membersRows.results) ? membersRows.results.map(m => ({
    memberId: m.id,
    studentId: m.student_id,
    joinedAt: m.joined_at,
  })) : [];
  
  const activitiesRows = await db.prepare(
    `SELECT ra.id, ra.activity_id, ra.assigned_at, e.title
     FROM room_activities ra
     LEFT JOIN exercises e ON ra.activity_id = e.id
     WHERE ra.room_id = ?
     ORDER BY ra.assigned_at DESC`
  ).bind(roomId).all();
  const activities = (activitiesRows && activitiesRows.results) ? activitiesRows.results.map(a => ({
    assignmentId: a.id,
    activityId: a.activity_id,
    activityTitle: a.title || "Untitled",
    assignedAt: a.assigned_at,
  })) : [];
  
  return ok({
    room: {
      roomId: roomRow.id,
      name: roomRow.name,
      roomCode: roomRow.room_code,
      createdAt: roomRow.created_at,
      updatedAt: roomRow.updated_at,
    },
    members,
    activities,
  });
}

// ════════════════════════════════════════════════════
// PUT /room/:roomId
// Body: { name }
// Rename a room
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+$/) && request.method === "PUT") {
  const roomId = path.split("/")[2];
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const body = await request.json().catch(() => ({}));
  const newName = (body.name || "").trim();
  if (!newName) return err("Name is required", 400);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE rooms SET name = ?, updated_at = ? WHERE id = ?`
  ).bind(newName, now, roomId).run();
  
  return ok({ roomId, name: newName, updatedAt: now });
}

// ════════════════════════════════════════════════════
// POST /room/:roomId/archive
// Archive a room (soft delete)
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+\/archive$/) && request.method === "POST") {
  const roomId = path.split("/")[2];
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE rooms SET archived = 1, updated_at = ? WHERE id = ?`
  ).bind(now, roomId).run();
  
  return ok({ archived: true });
}

// ════════════════════════════════════════════════════
// GET /room/:roomId/members
// List all members in a room
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+\/members$/) && request.method === "GET") {
  const roomId = path.split("/")[2];
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  const rows = await db.prepare(
    `SELECT id, student_id, joined_at FROM room_members
     WHERE room_id = ?
     ORDER BY joined_at DESC`
  ).bind(roomId).all();
  
  const members = (rows && rows.results) ? rows.results.map(m => ({
    memberId: m.id,
    studentId: m.student_id,
    joinedAt: m.joined_at,
  })) : [];
  
  return ok({ members });
}

// ════════════════════════════════════════════════════
// DELETE /room/:roomId/members/:memberId
// Remove a student from a room
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+\/members\/[a-z0-9_]+$/) && request.method === "DELETE") {
  const parts = path.split("/");
  const roomId = parts[2];
  const memberId = parts[4];
  
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  // Verify member belongs to this room
  const member = await db.prepare(
    `SELECT id FROM room_members WHERE id = ? AND room_id = ?`
  ).bind(memberId, roomId).first();
  if (!member) return err("Member not found", 404);
  
  await db.prepare(
    `DELETE FROM room_members WHERE id = ?`
  ).bind(memberId).run();
  
  return ok({ removed: true });
}

// ════════════════════════════════════════════════════
// GET /room/:roomId/activities
// List all activities assigned to a room
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+\/activities$/) && request.method === "GET") {
  const roomId = path.split("/")[2];
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  const rows = await db.prepare(
    `SELECT ra.id, ra.activity_id, ra.assigned_at, e.title, e.teacher_id
     FROM room_activities ra
     LEFT JOIN exercises e ON ra.activity_id = e.id
     WHERE ra.room_id = ?
     ORDER BY ra.assigned_at DESC`
  ).bind(roomId).all();
  
  const activities = (rows && rows.results) ? rows.results.map(a => ({
    assignmentId: a.id,
    activityId: a.activity_id,
    activityTitle: a.title || "Untitled",
    assignedAt: a.assigned_at,
  })) : [];
  
  return ok({ activities });
}

// ════════════════════════════════════════════════════
// POST /room/:roomId/activity/:activityId
// Assign an activity to a room
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+\/activity\/[a-z0-9_]+$/) && request.method === "POST") {
  const parts = path.split("/");
  const roomId = parts[2];
  const activityId = parts[4];
  
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  // Verify teacher owns the activity
  const activity = await db.prepare(
    `SELECT id, teacher_id FROM exercises WHERE id = ?`
  ).bind(activityId).first();
  if (!activity || activity.teacher_id !== teacherId) {
    return err("Activity not found or not authorized", 404);
  }
  
  // Check if already assigned
  const existing = await db.prepare(
    `SELECT id FROM room_activities WHERE room_id = ? AND activity_id = ?`
  ).bind(roomId, activityId).first();
  if (existing) {
    return err("Activity already assigned to this room", 409);
  }
  
  const assignmentId = "ra_" + generateId(12);
  const now = new Date().toISOString();
  
  await db.prepare(
    `INSERT INTO room_activities (id, room_id, activity_id, assigned_at)
     VALUES (?, ?, ?, ?)`
  ).bind(assignmentId, roomId, activityId, now).run();
  
  return ok({ assignmentId, roomId, activityId, assignedAt: now });
}

// ════════════════════════════════════════════════════
// DELETE /room/:roomId/activity/:activityId
// Unassign an activity from a room
// ════════════════════════════════════════════════════
if (path.match(/^\/room\/[a-z0-9_]+\/activity\/[a-z0-9_]+$/) && request.method === "DELETE") {
  const parts = path.split("/");
  const roomId = parts[2];
  const activityId = parts[4];
  
  const teacherId = await requireTeacher(request, env);
  if (!teacherId) return err("Not authenticated", 401);
  
  const db = await getDbBinding(env);
  if (!db) return err("Database not available", 500);
  await ensureDbSchema(db);
  
  const room = await verifyRoomOwnership(db, roomId, teacherId);
  if (!room) return err("Room not found or not authorized", 404);
  
  const assignment = await db.prepare(
    `SELECT id FROM room_activities WHERE room_id = ? AND activity_id = ?`
  ).bind(roomId, activityId).first();
  if (!assignment) return err("Assignment not found", 404);
  
  await db.prepare(
    `DELETE FROM room_activities WHERE room_id = ? AND activity_id = ?`
  ).bind(roomId, activityId).run();
  
  return ok({ unassigned: true });
}
