ALTER TABLE team_invitation ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMP(9) WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS idx_invitation_sender_deadline ON team_invitation(team_id, inviter_uid, expires_at, created_at, invitation_id);
CREATE INDEX IF NOT EXISTS idx_invitation_recipient_validity ON team_invitation(team_id, invitee_uid, decision, expires_at);
