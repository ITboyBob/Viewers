package cn.colla.phaseone.team;

import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class TeamPolicy {
    private final IdentityRepository identities;
    private final JdbcTemplate jdbc;
    public TeamPolicy(IdentityRepository identities, JdbcTemplate jdbc) { this.identities = identities; this.jdbc = jdbc; }
    public record TeamAccess(String teamId, String ownerUid, String role) {}
    public TeamAccess requireMember(String uid, String teamId) {
        identities.byUid(uid).filter(user -> user.status().equals("active")).orElseThrow(ApiException::unauthorized);
        return jdbc.query("SELECT t.team_id,t.owner_uid,m.role FROM team t JOIN team_member m ON m.team_id=t.team_id WHERE t.team_id=? AND m.uid=?",
            (r, n) -> new TeamAccess(r.getString("team_id"), r.getString("owner_uid"), r.getString("role")), teamId, uid)
            .stream().findFirst().orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在"));
    }
    public TeamAccess requireOwner(String uid, String teamId) {
        var access = requireMember(uid, teamId);
        if (!uid.equals(access.ownerUid()) || !access.role().equals("owner")) throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "没有权限执行该操作");
        return access;
    }
}
