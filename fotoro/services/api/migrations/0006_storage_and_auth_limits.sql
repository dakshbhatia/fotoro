CREATE TABLE account_storage(account_id TEXT PRIMARY KEY,reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stored_bytes>=0));
CREATE TABLE upload_storage_claims(upload_id TEXT NOT NULL REFERENCES uploads(id),cap TEXT NOT NULL,account_id TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0),expires INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','stored')),PRIMARY KEY(upload_id,cap));
CREATE INDEX upload_storage_expiry ON upload_storage_claims(account_id,state,expires);
CREATE TRIGGER storage_claim_insert AFTER INSERT ON upload_storage_claims BEGIN
 INSERT OR IGNORE INTO account_storage(account_id) VALUES(NEW.account_id);
 UPDATE account_storage SET reserved_bytes=reserved_bytes+CASE WHEN NEW.state='reserved' THEN NEW.bytes ELSE 0 END,stored_bytes=stored_bytes+CASE WHEN NEW.state='stored' THEN NEW.bytes ELSE 0 END WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER storage_claim_update AFTER UPDATE OF state ON upload_storage_claims WHEN OLD.state<>NEW.state BEGIN
 UPDATE account_storage SET reserved_bytes=reserved_bytes-CASE WHEN OLD.state='reserved' THEN OLD.bytes ELSE 0 END+CASE WHEN NEW.state='reserved' THEN NEW.bytes ELSE 0 END,stored_bytes=stored_bytes-CASE WHEN OLD.state='stored' THEN OLD.bytes ELSE 0 END+CASE WHEN NEW.state='stored' THEN NEW.bytes ELSE 0 END WHERE account_id=NEW.account_id;
END;
CREATE TRIGGER storage_claim_delete AFTER DELETE ON upload_storage_claims BEGIN
 UPDATE account_storage SET reserved_bytes=reserved_bytes-CASE WHEN OLD.state='reserved' THEN OLD.bytes ELSE 0 END,stored_bytes=stored_bytes-CASE WHEN OLD.state='stored' THEN OLD.bytes ELSE 0 END WHERE account_id=OLD.account_id;
END;
/* Legacy reservations may have written staging bytes without recording success.
   Only the new Worker can prove that a newly issued lease has not begun writing. */
INSERT INTO upload_storage_claims SELECT id,cap,account_id,json_extract(input,'$.ciphertextBytes'),expires,'stored' FROM uploads;
CREATE TRIGGER upload_storage_insert AFTER INSERT ON uploads BEGIN
 INSERT INTO upload_storage_claims VALUES(NEW.id,NEW.cap,NEW.account_id,json_extract(NEW.input,'$.ciphertextBytes'),NEW.expires,'stored');
END;
CREATE TRIGGER upload_storage_renew AFTER UPDATE OF cap ON uploads WHEN OLD.cap<>NEW.cap BEGIN
 INSERT INTO upload_storage_claims VALUES(NEW.id,NEW.cap,NEW.account_id,json_extract(NEW.input,'$.ciphertextBytes'),NEW.expires,'stored');
END;
CREATE TRIGGER upload_storage_expiry_update AFTER UPDATE OF expires ON uploads WHEN OLD.cap=NEW.cap BEGIN
 UPDATE upload_storage_claims SET expires=NEW.expires WHERE upload_id=NEW.id AND cap=NEW.cap AND state='reserved';
END;
CREATE TABLE auth_rate_limits(key TEXT PRIMARY KEY,expires INTEGER NOT NULL,attempts INTEGER NOT NULL CHECK(attempts>0));
CREATE INDEX auth_rate_limit_expiry ON auth_rate_limits(expires);
