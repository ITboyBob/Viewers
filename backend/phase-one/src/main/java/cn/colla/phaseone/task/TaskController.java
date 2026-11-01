package cn.colla.phaseone.task;

import cn.colla.phaseone.auth.SessionPrincipal;
import cn.colla.phaseone.identity.IdentityDtos.Data;
import cn.colla.phaseone.task.TaskDtos.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/teams/{teamId}/tasks")
public class TaskController {
    private final TaskRegistrationService registrations;
    public TaskController(TaskRegistrationService registrations) { this.registrations = registrations; }
    @PostMapping
    public ResponseEntity<Data<Task>> create(@AuthenticationPrincipal SessionPrincipal principal,
        @PathVariable String teamId, @RequestHeader(value = "Idempotency-Key", required = false) String key,
        @RequestBody CreateTask input, HttpServletRequest request) {
        var result = registrations.register(principal.uid(), teamId, key, input);
        request.setAttribute("colla.actor", principal.uid()); request.setAttribute("colla.team", teamId);
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(new Data<>(result.task()));
    }
}
