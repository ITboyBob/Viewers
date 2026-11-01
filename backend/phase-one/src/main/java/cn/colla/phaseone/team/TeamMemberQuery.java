package cn.colla.phaseone.team;

import java.time.Instant;
import java.time.OffsetDateTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import static cn.colla.phaseone.invitation.InvitationDtos.*;

@Service
public class TeamMemberQuery {
    private final JdbcTemplate jdbc;
    private final TeamPolicy teams;
    public TeamMemberQuery(JdbcTemplate jdbc, TeamPolicy teams) { this.jdbc = jdbc; this.teams = teams; }
    public record MemberView(String uid, String username, String avatar_url, String role, Instant joined_at) {}
    public Page<MemberView> list(String actor, String teamId, PageQuery page) {
        teams.requireOwner(actor, teamId);
        long total = jdbc.queryForObject("SELECT COUNT(*) FROM team_member WHERE team_id=?", Long.class, teamId);
        var rows = jdbc.query("""
            SELECT u.uid,u.username,u.avatar_url,m.role,m.joined_at FROM team_member m JOIN app_user u ON u.uid=m.uid
            WHERE m.team_id=? ORDER BY m.joined_at ASC,m.uid ASC LIMIT ? OFFSET ?
            """, (r, n) -> new MemberView(r.getString("uid"), r.getString("username"), r.getString("avatar_url"),
                r.getString("role"), r.getObject("joined_at", OffsetDateTime.class).toInstant()), teamId, page.size(), page.offset());
        return new Page<>(rows, page.meta(total));
    }
}
