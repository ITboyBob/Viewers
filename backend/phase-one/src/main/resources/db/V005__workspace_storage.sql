-- 本轮运行期扩展；随H2实例失效，不提供跨进程恢复。
ALTER TABLE team_invitation ADD COLUMN IF NOT EXISTS read_at TIMESTAMP(9) WITH TIME ZONE;
CREATE TABLE IF NOT EXISTS workspace_preference (
 uid VARCHAR(36) PRIMARY KEY REFERENCES app_user(uid) ON DELETE CASCADE,
 team_id VARCHAR(36) NOT NULL REFERENCES team(team_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_read_only (
 task_id VARCHAR(36) NOT NULL REFERENCES task_record(task_id) ON DELETE CASCADE,
 uid VARCHAR(36) NOT NULL REFERENCES app_user(uid) ON DELETE CASCADE,
 PRIMARY KEY(task_id,uid)
);
CREATE TABLE IF NOT EXISTS task_import (
 import_id VARCHAR(36) PRIMARY KEY,
 uid VARCHAR(36) NOT NULL REFERENCES app_user(uid) ON DELETE CASCADE,
 team_id VARCHAR(36) NOT NULL REFERENCES team(team_id) ON DELETE CASCADE,
 registration_key VARCHAR(36) NOT NULL,
 manifest CLOB NOT NULL,
 task_id VARCHAR(36),
 UNIQUE(uid,registration_key)
);
CREATE TABLE IF NOT EXISTS task_material (
 task_id VARCHAR(36) PRIMARY KEY REFERENCES task_record(task_id) ON DELETE CASCADE,
 import_id VARCHAR(36) NOT NULL,
 manifest CLOB NOT NULL,
 revision BIGINT NOT NULL DEFAULT 0,
 results CLOB NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS task_result_operation (
 task_id VARCHAR(36) NOT NULL REFERENCES task_record(task_id) ON DELETE CASCADE,
 operation_id VARCHAR(36) NOT NULL,
 actor_uid VARCHAR(36) NOT NULL,
 payload CLOB NOT NULL,
 response CLOB NOT NULL,
 PRIMARY KEY(task_id,operation_id)
);
