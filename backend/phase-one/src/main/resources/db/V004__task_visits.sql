-- 仅存在于当前H2内存库；访问不改变任务的标注更新时间。
CREATE TABLE IF NOT EXISTS task_visit (
    uid VARCHAR(36) NOT NULL REFERENCES app_user(uid) ON DELETE CASCADE,
    task_id VARCHAR(36) NOT NULL REFERENCES task_record(task_id) ON DELETE CASCADE,
    last_entered_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
    PRIMARY KEY (uid, task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_visit_recent ON task_visit(uid, last_entered_at DESC, task_id);
