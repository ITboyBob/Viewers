package cn.colla.phaseone.task;

import cn.colla.phaseone.auth.SessionPrincipal;
import cn.colla.phaseone.identity.IdentityDtos.Data;
import cn.colla.phaseone.task.TaskDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/teams/{teamId}/tasks")
public class TaskController {
    private final TaskRegistrationService registrations;
    private final TaskTouchService touches;
    public TaskController(TaskRegistrationService registrations, TaskTouchService touches) {
        this.registrations = registrations; this.touches = touches;
    }
    @PostMapping
    public ResponseEntity<Data<Task>> create(@AuthenticationPrincipal SessionPrincipal principal,
        @PathVariable String teamId, @RequestHeader(value = "Idempotency-Key", required = false) String key,
        @RequestBody CreateTask input, HttpServletRequest request) {
        var result = registrations.register(principal.uid(), teamId, key, input);
        request.setAttribute("colla.actor", principal.uid()); request.setAttribute("colla.team", teamId);
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(new Data<>(result.task()));
    }
    @PatchMapping("/{taskId}/updated-at")
    public Data<TaskTimestamp> touch(@AuthenticationPrincipal SessionPrincipal principal,
        @PathVariable String teamId, @PathVariable String taskId,
        @RequestBody(required = false) JsonNode input, HttpServletRequest request) {
        var result = touches.touch(principal.uid(), teamId, taskId, input);
        request.setAttribute("colla.actor", principal.uid()); request.setAttribute("colla.team", teamId);
        return new Data<>(result);
    }
}
