package cn.colla.phaseone.dashboard;

import cn.colla.phaseone.dashboard.DashboardDtos.*;
import cn.colla.phaseone.dashboard.DashboardTargetResolver.Viewer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** 可替换的纯演示提供器；非入队样本仅声明当前 uid 的可见关系，不写入团队或任务。 */
@Component
public class DashboardMockFixtures {
    private static final String NAMESPACE = "cn.colla.phaseone.dashboard.mock.v1";
    private static final Instant LATEST = Instant.parse("2026-11-03T08:00:00Z");
    private static final Instant PREVIOUS = Instant.parse("2026-11-02T08:00:00Z");

    public record Fixture(List<TeamTaskCard> teamTasks, List<RecentTaskCard> recentTasks) {}

    public Fixture forViewer(Viewer viewer) {
        var ct = new TeamTaskCard(id(viewer.uid(), "team-ct"), viewer.ownedTeamId(), "腹部 CT 示例", "示例数据 · 团队任务", "abdominal-ct");
        var other = new TeamTaskCard(id(viewer.uid(), "team-other"), viewer.ownedTeamId(), "标注任务示例", "示例数据 · 团队任务", "none");
        var external = new TeamTaskCard(id(viewer.uid(), "non-team-task"), id(viewer.uid(), "non-team"),
            "非入队协作示例", "示例数据 · 已访问工作台", "none");
        var team = List.of(ct, other);
        var recent = List.of(recent(external, LATEST), recent(ct, PREVIOUS), recent(other, PREVIOUS));
        return new Fixture(team, recent);
    }

    private RecentTaskCard recent(TeamTaskCard task, Instant entered) {
        return new RecentTaskCard(task.task_id(), task.team_id(), task.title(), task.subtitle(), task.preview_key(), entered);
    }

    private static String id(String scope, String key) {
        return UUID.nameUUIDFromBytes((NAMESPACE + ":" + scope + ":" + key).getBytes(StandardCharsets.UTF_8)).toString();
    }
}
