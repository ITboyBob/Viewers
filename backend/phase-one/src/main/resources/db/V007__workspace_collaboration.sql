-- 协作邀请不是入队邀请；全部记录随本次 H2 实例失效。
CREATE TABLE IF NOT EXISTS workspace_collaboration_invitation (
 invitation_id VARCHAR(36) PRIMARY KEY,
 task_id VARCHAR(36) NOT NULL REFERENCES task_record(task_id) ON DELETE CASCADE,
 inviter_uid VARCHAR(36) NOT NULL REFERENCES app_user(uid) ON DELETE CASCADE,
 invitee_uid VARCHAR(36) NOT NULL REFERENCES app_user(uid) ON DELETE CASCADE,
 permission VARCHAR(8) NOT NULL CHECK(permission IN ('edit','view')),
 decision VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','accepted','rejected')),
 created_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
 expires_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
 decided_at TIMESTAMP(9) WITH TIME ZONE,
 read_at TIMESTAMP(9) WITH TIME ZONE,
 CHECK(inviter_uid <> invitee_uid),
 CHECK(expires_at > created_at),
 CHECK((decision='pending' AND decided_at IS NULL) OR (decision<>'pending' AND decided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_workspace_invitation_sender ON workspace_collaboration_invitation(task_id,inviter_uid,invitee_uid,expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_invitation_recipient ON workspace_collaboration_invitation(invitee_uid,created_at,invitation_id);
CREATE TABLE IF NOT EXISTS workspace_collaboration_grant (
 task_id VARCHAR(36) NOT NULL REFERENCES task_record(task_id) ON DELETE CASCADE,
 uid VARCHAR(36) NOT NULL REFERENCES app_user(uid) ON DELETE CASCADE,
 permission VARCHAR(8) NOT NULL CHECK(permission IN ('edit','view')),
 invitation_id VARCHAR(36) NOT NULL UNIQUE REFERENCES workspace_collaboration_invitation(invitation_id) ON DELETE CASCADE,
 accepted_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
 PRIMARY KEY(task_id,uid)
);
ALTER TABLE task_material ADD COLUMN IF NOT EXISTS initial_segmentation_ids CLOB NOT NULL DEFAULT '[]';
