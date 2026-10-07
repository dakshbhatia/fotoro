CREATE TABLE albums(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES accounts(id),definition TEXT NOT NULL,created_at INTEGER NOT NULL,ended INTEGER);
CREATE TABLE album_members(album_id TEXT NOT NULL REFERENCES albums(id),account_id TEXT NOT NULL REFERENCES accounts(id),status TEXT NOT NULL CHECK(status IN ('invited','accepted')),accepted_payload TEXT,PRIMARY KEY(album_id,account_id));
CREATE INDEX album_members_account ON album_members(account_id,album_id);
CREATE TABLE album_photos(sequence INTEGER PRIMARY KEY AUTOINCREMENT,album_id TEXT NOT NULL REFERENCES albums(id),photo_id TEXT NOT NULL REFERENCES photos(id),owner TEXT NOT NULL REFERENCES accounts(id),entry TEXT NOT NULL,UNIQUE(album_id,photo_id));
CREATE INDEX album_photos_page ON album_photos(album_id,sequence);
CREATE INDEX album_photos_access ON album_photos(photo_id,album_id);
CREATE TABLE album_operations(album_id TEXT NOT NULL REFERENCES albums(id),account_id TEXT NOT NULL REFERENCES accounts(id),operation_id TEXT NOT NULL,body TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(album_id,account_id,operation_id));
