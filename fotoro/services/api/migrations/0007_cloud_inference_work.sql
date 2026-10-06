/* Only work counts are retained; no preview pixels, model results or photo IDs. */
CREATE TABLE cloud_inference_work(scope TEXT NOT NULL,window TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL CHECK(attempts>0),PRIMARY KEY(scope,window));
CREATE INDEX cloud_inference_work_expiry ON cloud_inference_work(expires);
