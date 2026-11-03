package cn.colla.phaseone.dashboard;

import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.team.TeamPolicy;
import java.util.UUID;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** 演示清单和既有真实任务的范围校验分开；所有数据库操作均为只读。 */
@Service
public class DashboardTargetResolver {
    public record Viewer(String uid, String username, String ownedTeamId) {}
    private final IdentityRepository identities;
    private final TeamPolicy teams;
    private final JdbcTemplate jdbc;

    public DashboardTargetResolver(IdentityRepository identities, TeamPolicy teams, JdbcTemplate jdbc) {
        this.identities = identities;
        this.teams = teams;
        this.jdbc = jdbc;
    }

    public Viewer viewer(String uid) {
        var account = identities.byUid(uid).filter(user -> "active".equals(user.status()))
            .orElseThrow(ApiException::unauthorized);
        String defaultTeam;
        try { defaultTeam = identities.defaultTeam(uid); }
        catch (EmptyResultDataAccessException missing) { throw notFound(); }
        var access = teams.requireMember(uid, defaultTeam);
        if (!uid.equals(access.ownerUid()) || !"owner".equals(access.role())) throw notFound();
        return new Viewer(uid, account.username(), defaultTeam);
    }

    public Viewer ownedTeam(String uid, String teamId) {
        String canonical = uuid(teamId);
        var viewer = viewer(uid);
        if (!viewer.ownedTeamId().equals(canonical)) throw notFound();
        return viewer;
    }

    public void requireVisibleRealTask(String uid, String taskId) {
        // 不读取 assignee_uid，不对 touch、登记或真实协作授权产生副作用。
        String teamId = jdbc.query("SELECT task_id,team_id FROM task_record WHERE task_id=?",
            (row, index) -> row.getString("team_id"), taskId).stream().findFirst().orElseThrow(DashboardTargetResolver::notFound);
        teams.requireMember(uid, teamId);
    }

    public static String uuid(String value) {
        try {
            String canonical = UUID.fromString(value).toString();
            if (!canonical.equalsIgnoreCase(value)) throw ApiException.validation();
            return canonical;
        } catch (IllegalArgumentException invalid) { throw ApiException.validation(); }
    }

    private static ApiException notFound() {
        return new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "资源不存在");
    }
}
