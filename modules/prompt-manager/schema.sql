-- Prompt Manager Schema
-- Levels: GLOBAL (_prompts) or PROJECT (specific project)

-- Prompts base
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  slot_type TEXT DEFAULT 'system',  -- 'system', 'context', 'prefix', 'suffix', 'format'
  content TEXT NOT NULL,
  variables TEXT DEFAULT '[]',       -- JSON array of variable names
  tags TEXT DEFAULT '[]',            -- JSON array of tags
  metadata TEXT DEFAULT '{}',        -- JSON object
  current_version TEXT DEFAULT '1.0.0',
  created_at TEXT,
  updated_at TEXT
);

-- Prompt versions (history)
CREATE TABLE IF NOT EXISTS prompt_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  variables TEXT DEFAULT '[]',
  created_at TEXT,
  created_by TEXT DEFAULT 'system',
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE,
  UNIQUE(prompt_id, version)
);

-- Slot presets (saved combinations)
CREATE TABLE IF NOT EXISTS slot_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Preset-Prompt relationship (multiple prompts per slot)
CREATE TABLE IF NOT EXISTS slot_preset_prompts (
  preset_id TEXT NOT NULL,
  slot_type TEXT NOT NULL,        -- 'system', 'context', 'prefix', 'suffix', 'format'
  prompt_id TEXT NOT NULL,
  position INTEGER DEFAULT 0,     -- order within slot
  created_at TEXT,
  PRIMARY KEY (preset_id, slot_type, prompt_id),
  FOREIGN KEY (preset_id) REFERENCES slot_presets(id) ON DELETE CASCADE,
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
);

-- Analytics
CREATE TABLE IF NOT EXISTS prompt_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id TEXT NOT NULL,
  version TEXT,
  usage_count INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_latency_ms INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  first_used TEXT,
  last_used TEXT,
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE,
  UNIQUE(prompt_id, version)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_prompts_slot_type ON prompts(slot_type);
CREATE INDEX IF NOT EXISTS idx_prompts_tags ON prompts(tags);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt_id ON prompt_versions(prompt_id);
CREATE INDEX IF NOT EXISTS idx_slot_preset_prompts_preset ON slot_preset_prompts(preset_id);
CREATE INDEX IF NOT EXISTS idx_slot_preset_prompts_prompt ON slot_preset_prompts(prompt_id);
