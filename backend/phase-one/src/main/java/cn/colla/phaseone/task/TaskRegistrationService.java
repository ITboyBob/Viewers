package cn.colla.phaseone.task;

import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.task.TaskDtos.*;
import cn.colla.phaseone.task.TaskRegistrationTransaction.RegistrationCollision;
import cn.colla.phaseone.team.TeamPolicy;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

@Service
public class TaskRegistrationService {
    private final TaskRepository tasks;
    private final TaskRegistrationTransaction transaction;
    private final TeamPolicy teams;
    private final ObjectMapper json;
    public TaskRegistrationService(TaskRepository tasks, TaskRegistrationTransaction transaction, TeamPolicy teams, ObjectMapper json) {
        this.tasks = tasks; this.transaction = transaction; this.teams = teams; this.json = json;
    }
    public RegistrationResult register(String uid, String team, String rawKey, CreateTask input) {
        teams.requireMember(uid, team);
        if (rawKey == null || !rawKey.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}") || input == null)
            throw ApiException.validation();
        String key = UUID.fromString(rawKey).toString();
        String title = input.validatedTitle();
        String hash = digest(team, title);
        var existing = tasks.registration(uid, key);
        if (existing.isPresent()) return replay(existing.get(), hash);
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                return new RegistrationResult(transaction.create(uid, team, title, key, hash), true);
            } catch (RegistrationCollision collision) {
                // REQUIRES_NEW代理已经完整回滚失败Task；随后SELECT使用新连接事务看到胜者。
                var winner = tasks.registration(uid, key);
                if (winner.isPresent()) return replay(winner.get(), hash);
            }
        }
        throw new ApiException(HttpStatus.CONFLICT, "CONFLICT", "同次登记正在竞争，请保留原登记键重试", "IDEMPOTENCY_BUSY");
    }
    private RegistrationResult replay(Registration existing, String hash) {
        if (!existing.payloadHash().equals(hash))
            throw new ApiException(HttpStatus.CONFLICT, "CONFLICT", "同次登记的请求内容不一致", "IDEMPOTENCY_PAYLOAD_MISMATCH");
        return new RegistrationResult(existing.task(), false);
    }
    private String digest(String team, String title) {
        try {
            String canonical = json.writeValueAsString(List.of("task-registration-v1", team, title, Map.of()));
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (JsonProcessingException | NoSuchAlgorithmException error) {
            throw new IllegalStateException("无法计算登记摘要", error);
        }
    }
}
