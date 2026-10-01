ALTER TABLE auth_challenges ADD COLUMN origin TEXT NOT NULL DEFAULT '';
CREATE TABLE grant_views(grant_id TEXT NOT NULL REFERENCES grants(id),account_id TEXT NOT NULL,viewed TEXT NOT NULL,PRIMARY KEY(grant_id,account_id));
