package cn.colla.phaseone.dashboard;

import cn.colla.phaseone.auth.SessionPrincipal;
import cn.colla.phaseone.dashboard.DashboardDtos.*;
import cn.colla.phaseone.identity.IdentityDtos.Data;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class DashboardController {
    private final DashboardMockService dashboard;
    public DashboardController(DashboardMockService dashboard) { this.dashboard = dashboard; }

    @GetMapping("/teams/{teamId}/tasks")
    public Data<TaskList<TeamTaskCard>> teamTasks(@AuthenticationPrincipal SessionPrincipal principal, @PathVariable String teamId) {
        return new Data<>(dashboard.teamTasks(principal.uid(), teamId));
    }

    @GetMapping("/tasks/recent")
    public Data<TaskList<RecentTaskCard>> recentTasks(@AuthenticationPrincipal SessionPrincipal principal) {
        return new Data<>(dashboard.recentTasks(principal.uid()));
    }

    @GetMapping("/tasks/{taskId}/members")
    public Data<TaskMembers> taskMembers(@AuthenticationPrincipal SessionPrincipal principal, @PathVariable String taskId) {
        return new Data<>(dashboard.taskMembers(principal.uid(), taskId));
    }
}
