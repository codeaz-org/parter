CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer TEXT UNIQUE,
  created INTEGER NOT NULL
);
-- ids here are SHA-256 hashes of the secret the browser or the email holds
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE login_links (id TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX login_links_email ON login_links (email, created);
CREATE TABLE projects (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  modified INTEGER NOT NULL,
  share TEXT UNIQUE,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE usage (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  chat INTEGER NOT NULL DEFAULT 0,
  renders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
