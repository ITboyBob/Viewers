package cn.colla.phaseone.dashboard;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import java.time.Instant;
import java.util.List;

/** 真实任务列表与成员的只读投影。 */
public final class DashboardDtos {
    private DashboardDtos() {}
    public record TeamTaskCard(String task_id, String team_id, String title, String assignee_uid,
                               Instant created_at, Instant updated_at) {}
    public record RecentTaskCard(@JsonUnwrapped TeamTaskCard task, Instant last_entered_at) {}
    public record TaskList<T>(List<T> items, int total, boolean mock) {
        public TaskList { items = List.copyOf(items); }
    }
    public record Member(String uid, String username) {}
    public record TaskMembers(String task_id, String owner_uid, List<Member> members, boolean mock) {
        public TaskMembers { members = List.copyOf(members); }
    }
}
