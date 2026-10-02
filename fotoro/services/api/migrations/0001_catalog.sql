CREATE TABLE uploads(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,device_id TEXT NOT NULL,operation_id TEXT NOT NULL,input TEXT NOT NULL,cap TEXT NOT NULL,expires INTEGER NOT NULL,object_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'reserved',etag TEXT,revision INTEGER NOT NULL DEFAULT 1,commit_json TEXT,UNIQUE(account_id,operation_id));
CREATE TABLE objects(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,upload_id TEXT NOT NULL UNIQUE,bytes INTEGER NOT NULL,digest TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'live');
CREATE TABLE photos(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,manifest TEXT NOT NULL,signed TEXT NOT NULL);
CREATE TABLE retention(object_id TEXT NOT NULL REFERENCES objects(id),account_id TEXT NOT NULL,photo_id TEXT NOT NULL REFERENCES photos(id),PRIMARY KEY(object_id,account_id,photo_id));
CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,payload TEXT);
CREATE TABLE guards(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TRIGGER photo_retain AFTER INSERT ON photos BEGIN
 INSERT INTO retention SELECT json_extract(value,'$.objectId'),NEW.account_id,NEW.id FROM json_each(NEW.manifest,'$.representations');
 INSERT INTO retention VALUES(json_extract(NEW.manifest,'$.metadataRepresentation.objectId'),NEW.account_id,NEW.id);
 INSERT INTO changes(account_id,entity,entity_id,payload) VALUES(NEW.account_id,'photo',NEW.id,NEW.signed);
END;
CREATE TRIGGER retention_live BEFORE INSERT ON retention BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM objects WHERE id=NEW.object_id AND state='live') THEN RAISE(ABORT,'OBJECT_UNAVAILABLE') END);
END;
