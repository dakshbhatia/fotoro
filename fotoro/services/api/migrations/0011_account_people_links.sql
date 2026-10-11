CREATE TABLE account_people_links(account_id TEXT PRIMARY KEY REFERENCES accounts(id),revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=2147483647),signed TEXT NOT NULL);
