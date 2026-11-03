package cn.colla.phaseone.dashboard;

import java.time.Instant;
import java.util.List;

/** 阶段性演示读投影，不扩充真实任务或成员存储。 */
public final class DashboardDtos {
    private DashboardDtos() {}
    public record TeamTaskCard(String task_id, String team_id, String title, String subtitle, String preview_key) {}
    public record RecentTaskCard(String task_id, String team_id, String title, String subtitle, String preview_key,
                                 Instant last_entered_at) {}
    public record TaskList<T>(List<T> items, int total, boolean mock) {
        public TaskList { items = List.copyOf(items); }
    }
    public record Member(String uid, String username) {}
    public record TaskMembers(String task_id, String owner_uid, List<Member> members, boolean mock) {
        public TaskMembers { members = List.copyOf(members); }
    }
}
