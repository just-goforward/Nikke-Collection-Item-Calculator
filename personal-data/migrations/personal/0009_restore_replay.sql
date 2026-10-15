-- Private, resumable restore work. PUBLIC retains only its identifier-free gate/version.
CREATE TABLE restore_replay (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  intent_version INTEGER NOT NULL CHECK (intent_version >= 0),
  cursor TEXT NOT NULL,
  page TEXT CHECK (page IS NULL OR json_valid(page)),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  CHECK (complete = 0 OR page IS NULL)
);
