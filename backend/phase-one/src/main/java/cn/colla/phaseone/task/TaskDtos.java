package cn.colla.phaseone.task;

import cn.colla.phaseone.shared.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.Map;

public final class TaskDtos {
    private TaskDtos() {}
    public record CreateTask(JsonNode title, JsonNode metadata) {
        public String validatedTitle() {
            if (title == null || !title.isTextual() || title.textValue().isBlank() || title.textValue().length() > 1024
                || (metadata != null && (!metadata.isObject() || !metadata.isEmpty()))) throw ApiException.validation();
            return title.textValue();
        }
        @Override public String toString() { return "CreateTask[已隐藏标题]"; }
    }
    public record Task(String task_id, String team_id, String title, String assignee_uid,
                       Map<String, Object> metadata, Instant created_at, Instant updated_at) {}
    public record Registration(Task task, String payloadHash) {}
    public record RegistrationResult(Task task, boolean created) {}
}
