package cn.colla.phaseone.dashboard;

import cn.colla.phaseone.dashboard.DashboardDtos.*;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import org.springframework.stereotype.Service;

/** 列表保留演示投影；任务成员只来自已授权的真实任务。 */
@Service
public class DashboardMockService {
    private final DashboardTargetResolver targets;
    private final DashboardMockFixtures fixtures;

    public DashboardMockService(DashboardTargetResolver targets, DashboardMockFixtures fixtures) {
        this.targets = targets;
        this.fixtures = fixtures;
    }

    public TaskList<TeamTaskCard> teamTasks(String uid, String teamId) {
        var viewer = targets.ownedTeam(uid, teamId);
        var unique = new LinkedHashMap<String, TeamTaskCard>();
        fixtures.forViewer(viewer).teamTasks().forEach(task -> unique.putIfAbsent(task.task_id(), task));
        var items = unique.values().stream().toList();
        return new TaskList<>(items, items.size(), true);
    }

    public TaskList<RecentTaskCard> recentTasks(String uid) {
        var viewer = targets.viewer(uid);
        var unique = new LinkedHashMap<String, RecentTaskCard>();
        // 先排序再去重，重复访问保留最新模板时间；不依赖当前时钟。
        fixtures.forViewer(viewer).recentTasks().stream()
            .sorted(Comparator.comparing(RecentTaskCard::last_entered_at).reversed().thenComparing(RecentTaskCard::task_id))
            .forEach(task -> unique.putIfAbsent(task.task_id(), task));
        var items = unique.values().stream().toList();
        return new TaskList<>(items, items.size(), true);
    }

    public TaskMembers taskMembers(String uid, String taskId) {
        String canonical = DashboardTargetResolver.uuid(taskId);
        var owner = targets.requireVisibleRealTask(uid, canonical);
        return new TaskMembers(canonical, owner.uid(), List.of(owner), false);
    }
}
