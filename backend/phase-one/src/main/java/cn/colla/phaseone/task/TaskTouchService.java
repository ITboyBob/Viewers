package cn.colla.phaseone.task;

import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.task.TaskDtos.TaskTimestamp;
import cn.colla.phaseone.team.TeamPolicy;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TaskTouchService {
    private final TaskRepository tasks;
    private final TeamPolicy teams;
    private final Clock clock;
    public TaskTouchService(TaskRepository tasks, TeamPolicy teams, Clock clock) {
        this.tasks = tasks; this.teams = teams; this.clock = clock;
    }
    @Transactional
    public TaskTimestamp touch(String uid, String teamId, String taskId, JsonNode input) {
        teams.requireMember(uid, teamId);
        if (input == null || !input.isObject() || !input.isEmpty()) throw ApiException.validation();
        var target = tasks.lockForTouch(teamId, taskId)
            .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "任务不存在，请重新导入"));
        if (!uid.equals(target.importerUid()))
            throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "只有本次影像导入者可以更新项目时间");
        var minimum = target.updatedAt().plusMillis(1);
        var now = clock.instant();
        var updatedAt = now.isAfter(minimum) ? now : minimum;
        tasks.updateTimestamp(taskId, updatedAt);
        return new TaskTimestamp(taskId, updatedAt);
    }
}
