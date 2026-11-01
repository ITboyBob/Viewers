-- 一期H2运行期任务；不保存影像、标注或任务状态，不承诺跨进程恢复。
CREATE TABLE IF NOT EXISTS task_record (
    task_id VARCHAR(36) PRIMARY KEY,
    team_id VARCHAR(36) NOT NULL REFERENCES team(team_id),
    title VARCHAR(1024) NOT NULL,
    assignee_uid VARCHAR(36) NOT NULL REFERENCES app_user(uid),
    metadata JSON NOT NULL,
    created_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
    CHECK (updated_at >= created_at)
);
CREATE TABLE IF NOT EXISTS task_registration (
    uid VARCHAR(36) NOT NULL REFERENCES app_user(uid),
    registration_key VARCHAR(36) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    task_id VARCHAR(36) NOT NULL UNIQUE REFERENCES task_record(task_id),
    created_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_task_registration PRIMARY KEY (uid, registration_key)
);
