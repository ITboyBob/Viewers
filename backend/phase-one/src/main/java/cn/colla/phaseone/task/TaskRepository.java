package cn.colla.phaseone.task;

import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.task.TaskDtos.*;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class TaskRepository {
    private final JdbcTemplate jdbc;
    public TaskRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public Optional<Registration> registration(String uid, String key) {
        return jdbc.query("SELECT t.*,r.payload_hash FROM task_registration r JOIN task_record t ON t.task_id=r.task_id WHERE r.uid=? AND r.registration_key=?",
            (row, n) -> new Registration(new Task(row.getString("task_id"), row.getString("team_id"), row.getString("title"), row.getString("assignee_uid"),
                Map.of(), row.getObject("created_at", OffsetDateTime.class).toInstant(), row.getObject("updated_at", OffsetDateTime.class).toInstant()), row.getString("payload_hash")), uid, key)
            .stream().findFirst();
    }
    public void insertTask(Task task) {
        jdbc.update("INSERT INTO task_record(task_id,team_id,title,assignee_uid,metadata,created_at,updated_at) VALUES(?,?,?,?,JSON '{}',?,?)",
            task.task_id(), task.team_id(), task.title(), task.assignee_uid(), IdentityRepository.utc(task.created_at()), IdentityRepository.utc(task.updated_at()));
    }
    public void insertRegistration(String uid, String key, String hash, Task task) {
        jdbc.update("INSERT INTO task_registration(uid,registration_key,payload_hash,task_id,created_at) VALUES(?,?,?,?,?)",
            uid, key, hash, task.task_id(), IdentityRepository.utc(task.created_at()));
    }
    public Optional<TouchTarget> lockForTouch(String teamId, String taskId) {
        return jdbc.query("SELECT assignee_uid,updated_at FROM task_record WHERE team_id=? AND task_id=? FOR UPDATE",
            (row, n) -> new TouchTarget(row.getString("assignee_uid"), row.getObject("updated_at", OffsetDateTime.class).toInstant()), teamId, taskId)
            .stream().findFirst();
    }
    public void updateTimestamp(String taskId, java.time.Instant updatedAt) {
        jdbc.update("UPDATE task_record SET updated_at=? WHERE task_id=?", IdentityRepository.utc(updatedAt), taskId);
    }
}
