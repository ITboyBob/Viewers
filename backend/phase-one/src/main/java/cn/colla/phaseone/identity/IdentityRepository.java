package cn.colla.phaseone.identity;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import cn.colla.phaseone.identity.IdentityDtos.TeamMembership;
import cn.colla.phaseone.identity.IdentityDtos.UserSummary;

@Repository
public class IdentityRepository {
    private final JdbcTemplate jdbc;
    public IdentityRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public record Account(String uid, String username, String passwordHash, String avatarUrl, String status) {
        public UserSummary summary() { return new UserSummary(uid, username, avatarUrl); }
        @Override public String toString() { return "Account[已隐藏]"; }
    }
    public static OffsetDateTime utc(Instant instant) { return instant.atOffset(ZoneOffset.UTC); }
    public void insertUser(String uid, String username, String hash, Instant now) {
        jdbc.update("INSERT INTO app_user(uid,username,password_hash,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)", uid, username, hash, utc(now), utc(now));
    }
    public void insertOwnedTeam(String teamId, String uid, String name, Instant now) {
        jdbc.update("INSERT INTO team(team_id,name,description,owner_uid,created_at,updated_at) VALUES(?,?,'',?,?,?)", teamId, name, uid, utc(now), utc(now));
        jdbc.update("INSERT INTO team_member(team_id,uid,role,joined_at) VALUES(?,?,'owner',?)", teamId, uid, utc(now));
    }
    private List<Account> accounts(String sql, String value) {
        return jdbc.query(sql, (r, n) -> new Account(r.getString("uid"), r.getString("username"), r.getString("password_hash"), r.getString("avatar_url"), r.getString("status")), value);
    }
    public Optional<Account> byUsername(String name) { return accounts("SELECT * FROM app_user WHERE username=?", name).stream().findFirst(); }
    public Optional<Account> byUid(String uid) { return accounts("SELECT * FROM app_user WHERE uid=?", uid).stream().findFirst(); }
    public List<TeamMembership> memberships(String uid) {
        return jdbc.query("SELECT t.team_id,t.name,t.owner_uid,m.role FROM team t JOIN team_member m ON m.team_id=t.team_id WHERE m.uid=? ORDER BY t.team_id",
            (r, n) -> new TeamMembership(r.getString("team_id"), r.getString("name"), r.getString("owner_uid"), r.getString("role")), uid);
    }
    public String defaultTeam(String uid) {
        return jdbc.queryForObject("SELECT team_id FROM team WHERE owner_uid=?", String.class, uid);
    }
}
