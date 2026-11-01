package cn.colla.phaseone.task;

import cn.colla.phaseone.task.TaskDtos.Task;
import cn.colla.phaseone.team.TeamPolicy;
import java.sql.SQLException;
import java.time.Clock;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TaskRegistrationTransaction {
    private final TaskRepository tasks;
    private final TeamPolicy teams;
    private final Clock clock;
    public TaskRegistrationTransaction(TaskRepository tasks, TeamPolicy teams, Clock clock) {
        this.tasks = tasks; this.teams = teams; this.clock = clock;
    }
    public static final class RegistrationCollision extends RuntimeException {
        RegistrationCollision(DuplicateKeyException cause) { super("同次登记发生并发竞争", cause); }
    }
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Task create(String uid, String team, String title, String key, String hash) {
        teams.requireMember(uid, team);
        var now = clock.instant();
        var task = new Task(UUID.randomUUID().toString(), team, title, uid, Map.of(), now, now);
        tasks.insertTask(task);
        try {
            tasks.insertRegistration(uid, key, hash, task);
        } catch (DuplicateKeyException error) {
            // 只识别已验证H2复合主键的约束诊断，不把task_id唯一约束等异常当重放。
            for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                if (cause instanceof SQLException sql && "23505".equals(sql.getSQLState())
                    && sql.getMessage().contains(" ON PUBLIC.TASK_REGISTRATION(UID, REGISTRATION_KEY) "))
                    throw new RegistrationCollision(error);
            }
            throw error;
        }
        return task;
    }
}
