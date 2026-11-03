package cn.colla.phaseone.dashboard;

import cn.colla.phaseone.dashboard.DashboardDtos.*;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.team.TeamPolicy;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 运行期真实任务及访问投影，不保存影像或标注。 */
@Service
public class DashboardService {
    private final JdbcTemplate jdbc;
    private final TeamPolicy teams;
    private final DashboardTargetResolver targets;
    private final Clock clock;
    public DashboardService(JdbcTemplate jdbc, TeamPolicy teams, DashboardTargetResolver targets, Clock clock) {
        this.jdbc = jdbc; this.teams = teams; this.targets = targets; this.clock = clock;
    }
    private TeamTaskCard card(ResultSet row) throws SQLException {
        return new TeamTaskCard(row.getString("task_id"), row.getString("team_id"), row.getString("title"),
            row.getString("assignee_uid"), row.getObject("created_at", OffsetDateTime.class).toInstant(),
            row.getObject("updated_at", OffsetDateTime.class).toInstant());
    }
    public TaskList<TeamTaskCard> teamTasks(String uid, String teamId) {
        String team = DashboardTargetResolver.uuid(teamId);
        teams.requireMember(uid, team);
        var items = jdbc.query("SELECT * FROM task_record WHERE team_id=? ORDER BY created_at DESC,task_id ASC",
            (row, index) -> card(row), team);
        return new TaskList<>(items, items.size(), false);
    }
    public TaskList<RecentTaskCard> recentTasks(String uid) {
        var items = jdbc.query("SELECT t.*,v.last_entered_at FROM task_visit v JOIN task_record t ON t.task_id=v.task_id JOIN team_member m ON m.team_id=t.team_id AND m.uid=v.uid WHERE v.uid=? ORDER BY v.last_entered_at DESC,t.task_id ASC",
            (row, index) -> new RecentTaskCard(card(row), row.getObject("last_entered_at", OffsetDateTime.class).toInstant()), uid);
        return new TaskList<>(items, items.size(), false);
    }
    @Transactional
    public void visit(String uid, String taskId) {
        String task = DashboardTargetResolver.uuid(taskId);
        targets.requireVisibleRealTask(uid, task);
        jdbc.update("MERGE INTO task_visit v USING (VALUES (CAST(? AS VARCHAR(36)),CAST(? AS VARCHAR(36)),CAST(? AS TIMESTAMP WITH TIME ZONE))) x(uid,task_id,last_entered_at) ON v.uid=x.uid AND v.task_id=x.task_id WHEN MATCHED THEN UPDATE SET last_entered_at=GREATEST(v.last_entered_at,x.last_entered_at) WHEN NOT MATCHED THEN INSERT(uid,task_id,last_entered_at) VALUES(x.uid,x.task_id,x.last_entered_at)",
            uid, task, cn.colla.phaseone.identity.IdentityRepository.utc(clock.instant()));
    }
    public TaskMembers taskMembers(String uid, String taskId) {
        String task = DashboardTargetResolver.uuid(taskId);
        var owner = targets.requireVisibleRealTask(uid, task);
        return new TaskMembers(task, owner.uid(), List.of(owner), false);
    }
}
