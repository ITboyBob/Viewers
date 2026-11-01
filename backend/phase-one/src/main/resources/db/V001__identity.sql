CREATE TABLE IF NOT EXISTS app_user (
    uid VARCHAR(36) PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    email VARCHAR(254),
    avatar_url VARCHAR(2048),
    status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE TABLE IF NOT EXISTS team (
    team_id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    description VARCHAR(1024) NOT NULL DEFAULT '',
    owner_uid VARCHAR(36) NOT NULL UNIQUE REFERENCES app_user(uid),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE TABLE IF NOT EXISTS team_member (
    team_id VARCHAR(36) NOT NULL REFERENCES team(team_id),
    uid VARCHAR(36) NOT NULL REFERENCES app_user(uid),
    role VARCHAR(16) NOT NULL CHECK (role IN ('owner', 'annotator')),
    joined_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (team_id, uid)
);
CREATE TABLE IF NOT EXISTS auth_session (
    token_hash CHAR(64) PRIMARY KEY,
    uid VARCHAR(36) NOT NULL REFERENCES app_user(uid),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_auth_session_uid ON auth_session(uid);
