package cn.colla.phaseone.invitation;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import cn.colla.phaseone.identity.IdentityDtos.UserSummary;
import cn.colla.phaseone.shared.ApiException;
import org.springframework.http.HttpStatus;
import static cn.colla.phaseone.identity.IdentityRepository.utc;
import static cn.colla.phaseone.invitation.InvitationDtos.*;

@Repository
public class InvitationRepository {
    private final JdbcTemplate jdbc;
    public InvitationRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    private static final String VIEW = """
        SELECT i.*, t.name AS team_name, u.username AS inviter_name, u.avatar_url AS inviter_avatar
        FROM team_invitation i JOIN team t ON t.team_id=i.team_id JOIN app_user u ON u.uid=i.inviter_uid
        """;
    public void lockTeam(String teamId) {
        if (jdbc.queryForList("SELECT team_id FROM team WHERE team_id=? FOR UPDATE", String.class, teamId).isEmpty())
            throw notFound();
    }
    public boolean isMember(String teamId, String uid) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM team_member WHERE team_id=? AND uid=?", Integer.class, teamId, uid) > 0;
    }
    public boolean coolingDown(String teamId, String uid, Instant now) {
        // 任一尚未到期记录都保留窗口，不受接受／拒绝或时间相同的排序影响。
        return jdbc.queryForObject("SELECT COUNT(*) FROM team_invitation WHERE team_id=? AND invitee_uid=? AND expires_at>?",
            Integer.class, teamId, uid, utc(now)) > 0;
    }
    public void insert(String id, String teamId, String sender, String recipient, Instant now) {
        jdbc.update("INSERT INTO team_invitation VALUES(?,?,?,?,?,?,'pending',NULL)", id, teamId, sender, recipient, utc(now), utc(now.plusSeconds(300)));
    }
    public record DecisionRow(String teamId, String recipient, Instant expiresAt, String decision) {}
    public String visibleTeam(String id, String recipient) {
        return jdbc.queryForList("SELECT team_id FROM team_invitation WHERE invitation_id=? AND invitee_uid=?", String.class, id, recipient)
            .stream().findFirst().orElseThrow(InvitationRepository::notFound);
    }
    public DecisionRow lockInvitation(String id, String recipient) {
        return jdbc.query("SELECT team_id,invitee_uid,expires_at,decision FROM team_invitation WHERE invitation_id=? AND invitee_uid=? FOR UPDATE",
            (r, n) -> new DecisionRow(r.getString("team_id"), r.getString("invitee_uid"),
                r.getObject("expires_at", OffsetDateTime.class).toInstant(), r.getString("decision")), id, recipient)
            .stream().findFirst().orElseThrow(InvitationRepository::notFound);
    }
    public void addAnnotator(String teamId, String recipient, Instant now) {
        jdbc.update("INSERT INTO team_member(team_id,uid,role,joined_at) VALUES(?,?,'annotator',?)", teamId, recipient, utc(now));
    }
    public void decide(String id, String decision, Instant now) {
        jdbc.update("UPDATE team_invitation SET decision=?,decided_at=? WHERE invitation_id=?", decision, utc(now), id);
    }
    public InvitationView view(String id) {
        return jdbc.query(VIEW + " WHERE i.invitation_id=?", this::mapView, id).stream().findFirst().orElseThrow(InvitationRepository::notFound);
    }
    public Page<InvitationView> notifications(String recipient, PageQuery page) {
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM team_invitation WHERE invitee_uid=?", Long.class, recipient);
        var rows = jdbc.query(VIEW + " WHERE i.invitee_uid=? ORDER BY i.created_at DESC,i.invitation_id ASC LIMIT ? OFFSET ?",
            this::mapView, recipient, page.size(), page.offset());
        return new Page<>(rows, page.meta(total));
    }
    private InvitationView mapView(ResultSet r, int row) throws SQLException {
        var decided = r.getObject("decided_at", OffsetDateTime.class);
        return new InvitationView(r.getString("invitation_id"), r.getString("team_id"), r.getString("team_name"),
            new UserSummary(r.getString("inviter_uid"), r.getString("inviter_name"), r.getString("inviter_avatar")),
            r.getString("invitee_uid"), r.getObject("created_at", OffsetDateTime.class).toInstant(),
            r.getObject("expires_at", OffsetDateTime.class).toInstant(), r.getString("decision"), decided == null ? null : decided.toInstant());
    }
    public static ApiException notFound() { return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在"); }
}
