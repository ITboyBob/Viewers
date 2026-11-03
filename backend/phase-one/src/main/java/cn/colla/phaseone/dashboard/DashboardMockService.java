package cn.colla.phaseone.dashboard;

import cn.colla.phaseone.dashboard.DashboardDtos.*;
import java.util.Comparator;
import java.util.LinkedHashMap;
import org.springframework.stereotype.Service;

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
        var viewer = targets.viewer(uid);
        var result = fixtures.forViewer(viewer).visibleTasks().get(canonical);
        if (result == null) {
            targets.requireVisibleRealTask(uid, canonical);
            result = fixtures.members(viewer, canonical);
        }
        // 夹具不合法必须失败，不能伪装成无 Owner 或空名单的成功响应。
        String ownerUid = result.owner_uid();
        if (!canonical.equals(result.task_id()) || !result.mock()
            || result.members().stream().filter(member -> member.uid().equals(ownerUid)).count() != 1
            || result.members().stream().map(Member::uid).distinct().count() != result.members().size()) {
            throw new IllegalStateException("任务成员演示模板不符合契约");
        }
        return result;
    }
}
