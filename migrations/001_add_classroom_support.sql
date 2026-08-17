-- D1 Migration: Add classroom/room management tables
-- This migration adds support for classroom-based activity management
-- It does NOT modify any existing tables (exercises, sessions, teachers, student_lessons)

-- Rooms/Classrooms: Groups of students managed by a teacher
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,                    -- "room_<random>" (not exposed ID)
  teacher_id TEXT NOT NULL,               -- References teachers.id
  name TEXT NOT NULL,                     -- e.g., "Class 7A", "Maria's Monday Group"
  room_code TEXT NOT NULL UNIQUE,         -- 6-char random code (e.g., "K7xM9q")
  created_at TEXT NOT NULL,               -- ISO 8601 timestamp
  updated_at TEXT NOT NULL,               -- ISO 8601 timestamp
  archived INTEGER DEFAULT 0              -- 0 = active, 1 = archived (soft delete)
);

-- Room membership: Which students belong to which rooms
CREATE TABLE IF NOT EXISTS room_members (
  id TEXT PRIMARY KEY,                    -- "member_<random>"
  room_id TEXT NOT NULL,                  -- References rooms.id
  student_id TEXT NOT NULL,               -- Google ID "g_<sub>"
  joined_at TEXT NOT NULL,                -- ISO 8601 timestamp when student joined
  
  -- Prevent duplicate memberships
  UNIQUE(room_id, student_id)
);

-- Room-Activity assignments: Which activities are assigned to which rooms
-- An activity is NOT duplicated; it remains owned by the teacher and referenced by rooms
CREATE TABLE IF NOT EXISTS room_activities (
  id TEXT PRIMARY KEY,                    -- "ra_<random>"
  room_id TEXT NOT NULL,                  -- References rooms.id
  activity_id TEXT NOT NULL,              -- References exercises.id
  assigned_at TEXT NOT NULL,              -- ISO 8601 timestamp when assigned
  
  -- Prevent duplicate assignments of the same activity to the same room
  UNIQUE(room_id, activity_id)
);

-- Student attempt records: Each completed activity attempt
-- Each attempt is a separate record; no overwriting
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,                    -- "attempt_<random>"
  student_id TEXT NOT NULL,               -- Google ID "g_<sub>"
  room_id TEXT NOT NULL,                  -- References rooms.id (which room was this from?)
  activity_id TEXT NOT NULL,              -- References exercises.id
  
  score INTEGER NOT NULL,                 -- Number of correct gaps (e.g., 8)
  total INTEGER NOT NULL,                 -- Total gaps in the activity (e.g., 10)
  percentage INTEGER,                     -- Calculated percentage (optional, for fast queries)
  
  submitted_at TEXT NOT NULL,             -- ISO 8601 timestamp of submission
  
  -- Optional: timing and detailed responses
  duration_seconds INTEGER,               -- How long the attempt took
  response_json TEXT                      -- Full student responses/answers (if needed for review)
);

-- Indexes for common queries
-- Rooms by teacher
CREATE INDEX IF NOT EXISTS idx_rooms_teacher_id ON rooms(teacher_id);

-- Room members queries
CREATE INDEX IF NOT EXISTS idx_room_members_room_id ON room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_student_id ON room_members(student_id);

-- Room activities queries
CREATE INDEX IF NOT EXISTS idx_room_activities_room_id ON room_activities(room_id);
CREATE INDEX IF NOT EXISTS idx_room_activities_activity_id ON room_activities(activity_id);

-- Attempt queries
CREATE INDEX IF NOT EXISTS idx_attempts_student_id ON attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_room_id ON attempts(room_id);
CREATE INDEX IF NOT EXISTS idx_attempts_activity_id ON attempts(activity_id);
-- Combined index for finding all attempts by a student on an activity in a room
CREATE INDEX IF NOT EXISTS idx_attempts_student_activity ON attempts(student_id, activity_id);

-- Room code lookup (for student joining rooms)
CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(room_code);
