package cn.colla.phaseone.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.time.OffsetDateTime;
import org.springframework.security.crypto.password.PasswordEncoder;
import cn.colla.phaseone.identity.IdentityDtos.Credentials;
import cn.colla.phaseone.identity.RegistrationService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import cn.colla.phaseone.identity.IdentityDtos.IssuedSession;
import cn.colla.phaseone.identity.IdentityDtos.SessionContext;
import cn.colla.phaseone.identity.IdentityRepository;
import cn.colla.phaseone.shared.ApiException;

@Service
public class SessionService {
    private final JdbcTemplate jdbc;
    private final IdentityRepository identities;
    private final Clock clock;
    private final PasswordEncoder passwords;
    private final String dummyHash;
    private final SecureRandom random = new SecureRandom();
    public SessionService(JdbcTemplate jdbc, IdentityRepository identities, Clock clock, PasswordEncoder passwords) {
        this.jdbc = jdbc; this.identities = identities; this.clock = clock; this.passwords = passwords;
        this.dummyHash = passwords.encode(java.util.UUID.randomUUID().toString());
    }
    public static String digest(String token) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("运行环境缺少 SHA-256", impossible); }
    }
    @Transactional
    public IssuedSession login(Credentials input) {
        RegistrationService.validatePassword(input.password());
        var account = identities.byUsername(input.username());
        boolean matches = passwords.matches(input.password(), account.map(IdentityRepository.Account::passwordHash).orElse(dummyHash));
        if (!matches || account.isEmpty() || !account.get().status().equals("active")) throw ApiException.unauthorized();
        return issue(account.get().uid());
    }
    public SessionPrincipal resolve(String token) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{43}")) throw ApiException.unauthorized();
        var rows = jdbc.query("SELECT s.uid,s.expires_at FROM auth_session s JOIN app_user u ON u.uid=s.uid WHERE s.token_hash=? AND u.status='active' AND s.expires_at>?",
            (row, index) -> new SessionPrincipal(row.getString("uid"), row.getObject("expires_at", OffsetDateTime.class).toInstant()), digest(token), IdentityRepository.utc(clock.instant()));
        return rows.stream().findFirst().orElseThrow(ApiException::unauthorized);
    }
    public SessionContext context(SessionPrincipal principal) {
        var user = identities.byUid(principal.uid()).filter(a -> a.status().equals("active")).orElseThrow(ApiException::unauthorized);
        return new SessionContext(user.summary(), principal.expiresAt(), identities.defaultTeam(user.uid()), identities.memberships(user.uid()), selectedTeam(user.uid()));
    }
    private String selectedTeam(String uid) {
        return jdbc.query("SELECT p.team_id FROM workspace_preference p JOIN team_member m ON m.team_id=p.team_id AND m.uid=p.uid WHERE p.uid=?",
            (r,n) -> r.getString(1), uid).stream().findFirst().orElseGet(() -> identities.defaultTeam(uid));
    }
    @Transactional
    public SessionContext selectTeam(SessionPrincipal principal, String team) {
        if (team == null || !identities.memberships(principal.uid()).stream().anyMatch(m -> m.team_id().equals(team)))
            throw new ApiException(org.springframework.http.HttpStatus.NOT_FOUND, "NOT_FOUND", "团队不存在或无权访问");
        jdbc.update("MERGE INTO workspace_preference(uid,team_id) KEY(uid) VALUES(?,?)", principal.uid(), team);
        return context(principal);
    }
    @Transactional
    public String revoke(String token) {
        if (token == null) return null;
        String hash = digest(token);
        var users = jdbc.queryForList("SELECT uid FROM auth_session WHERE token_hash=?", String.class, hash);
        jdbc.update("DELETE FROM auth_session WHERE token_hash=?", hash);
        return users.stream().findFirst().orElse(null);
    }
    @Transactional
    public IssuedSession issue(String uid) {
        byte[] bytes = new byte[32]; random.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        var now = clock.instant(); var expires = now.plus(Duration.ofHours(8));
        jdbc.update("INSERT INTO auth_session(token_hash,uid,created_at,expires_at) VALUES(?,?,?,?)", digest(token), uid, IdentityRepository.utc(now), IdentityRepository.utc(expires));
        var user = identities.byUid(uid).filter(a -> a.status().equals("active")).orElseThrow(ApiException::unauthorized);
        return new IssuedSession(token, new SessionContext(user.summary(), expires, identities.defaultTeam(uid), identities.memberships(uid), selectedTeam(uid)));
    }
}
