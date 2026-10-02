CREATE TABLE photo_annotations(photo_id TEXT PRIMARY KEY REFERENCES photos(id),account_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),signed TEXT NOT NULL);
CREATE TRIGGER annotation_insert AFTER INSERT ON photo_annotations BEGIN
 INSERT INTO changes(account_id,entity,entity_id,payload) VALUES(NEW.account_id,'annotation',NEW.photo_id,NEW.signed);
END;
CREATE TRIGGER annotation_update AFTER UPDATE ON photo_annotations BEGIN
 INSERT INTO changes(account_id,entity,entity_id,payload) VALUES(NEW.account_id,'annotation',NEW.photo_id,NEW.signed);
END;
