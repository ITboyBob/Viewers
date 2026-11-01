package cn.colla.phaseone.identity;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import cn.colla.phaseone.auth.SessionService;
import cn.colla.phaseone.identity.IdentityDtos.Credentials;
import cn.colla.phaseone.identity.IdentityDtos.IssuedSession;
import cn.colla.phaseone.shared.ApiException;

@Service
public class RegistrationService {
    private final IdentityRepository identities;
    private final SessionService sessions;
    private final PasswordEncoder passwords;
    private final TransactionTemplate transaction;
    private final Clock clock;
    public RegistrationService(IdentityRepository identities, SessionService sessions, PasswordEncoder passwords, TransactionTemplate transaction, Clock clock) {
        this.identities = identities; this.sessions = sessions; this.passwords = passwords; this.transaction = transaction; this.clock = clock;
    }
    public static void validatePassword(String password) {
        if (password == null || password.isEmpty() || password.getBytes(StandardCharsets.UTF_8).length > 72) throw ApiException.validation();
    }
    public IssuedSession register(Credentials input) {
        validatePassword(input.password());
        String hash = passwords.encode(input.password());
        // 哈希在事务外计算；原 Token 仅在 execute 成功提交后返回控制器。
        return transaction.execute(status -> {
            String uid = UUID.randomUUID().toString(); var now = clock.instant();
            try { identities.insertUser(uid, input.username(), hash, now); }
            catch (DuplicateKeyException duplicate) { throw new ApiException(HttpStatus.CONFLICT, "CONFLICT", "用户名已存在"); }
            identities.insertOwnedTeam(UUID.randomUUID().toString(), uid, input.username() + "的团队", now);
            return sessions.issue(uid);
        });
    }
}
