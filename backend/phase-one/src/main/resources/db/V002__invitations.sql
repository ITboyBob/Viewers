CREATE TABLE IF NOT EXISTS team_invitation (
    invitation_id VARCHAR(36) PRIMARY KEY,
    team_id VARCHAR(36) NOT NULL REFERENCES team(team_id),
    inviter_uid VARCHAR(36) NOT NULL REFERENCES app_user(uid),
    invitee_uid VARCHAR(36) NOT NULL REFERENCES app_user(uid),
    created_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP(9) WITH TIME ZONE NOT NULL,
    decision VARCHAR(16) NOT NULL CHECK (decision IN ('pending', 'accepted', 'rejected')),
    decided_at TIMESTAMP(9) WITH TIME ZONE,
    CHECK (inviter_uid <> invitee_uid),
    CHECK (expires_at > created_at),
    CHECK ((decision = 'pending' AND decided_at IS NULL) OR
           (decision IN ('accepted', 'rejected') AND decided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_invitation_cooldown ON team_invitation(team_id, invitee_uid, created_at);
CREATE INDEX IF NOT EXISTS idx_invitation_recipient ON team_invitation(invitee_uid, created_at, invitation_id);
