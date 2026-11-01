package cn.colla.phaseone;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import cn.colla.phaseone.shared.ApiException;
import cn.colla.phaseone.team.TeamPolicy;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "colla.database-name=auth_it")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class AuthSecurityIT {
    @TestConfiguration static class ControlledTime {
        @Bean @Primary MutableClock testClock() { return new MutableClock(); }
    }
    static class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-11-01T00:00:00Z");
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return Clock.fixed(now, zone); }
        public Instant instant() { return now; }
        void set(Instant value) { now = value; }
    }
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired MutableClock clock;
    @Autowired TeamPolicy teams;

    @BeforeEach void clean() {
        clock.set(Instant.parse("2026-11-01T00:00:00Z"));
        for (String table : List.of("auth_session", "team_member", "team", "app_user")) jdbc.update("DELETE FROM " + table);
    }
    String credentials(String name, String password) throws Exception { return json.writeValueAsString(Map.of("username", name, "password", password)); }
    JsonNode register(String name) throws Exception {
        return json.readTree(http.perform(post("/api/v1/users").contentType("application/json").content(credentials(name, "test-password")))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("data");
    }
    String token(JsonNode user) { return "Bearer " + user.path("token").asText(); }

    @Test void loginAndCurrentReturnOnlyAuthoritativeIdentityAndNoTokenOnCurrent() throws Exception {
        var account = register("login-user");
        var logged = json.readTree(http.perform(post("/api/v1/auth/sessions").contentType("application/json").content(credentials(" login-user ", "test-password")))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).path("data");
        assertThat(logged.path("token").asText()).isNotEqualTo(account.path("token").asText());
        assertThat(logged.path("default_team_id")).isEqualTo(account.path("default_team_id"));
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(logged)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.user.uid").value(account.at("/user/uid").asText()))
            .andExpect(jsonPath("$.data.token").doesNotExist()).andExpect(jsonPath("$.data.user.password_hash").doesNotExist());
    }

    @Test void unknownWrongPasswordAndDisabledHaveIdenticalFailure() throws Exception {
        var user = register("credentials-user"); String response = null;
        for (String input : List.of(credentials("unknown", "test-password"), credentials("credentials-user", "wrong"))) {
            String result = http.perform(post("/api/v1/auth/sessions").contentType("application/json").content(input))
                .andExpect(status().isUnauthorized()).andReturn().getResponse().getContentAsString();
            if (response == null) response = result; else assertThat(result).isEqualTo(response);
        }
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", user.at("/user/uid").asText());
        assertThat(http.perform(post("/api/v1/auth/sessions").contentType("application/json").content(credentials("credentials-user", "test-password")))
            .andExpect(status().isUnauthorized()).andReturn().getResponse().getContentAsString()).isEqualTo(response);
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(user))).andExpect(status().isUnauthorized());
    }

    @Test void exactExpiryBoundaryRejectsSessionWithoutSleeping() throws Exception {
        clock.set(Instant.parse("2026-11-01T00:00:00.123456789Z"));
        var user = register("expiry-user"); Instant expires = Instant.parse(user.path("expires_at").asText());
        assertThat(expires).isEqualTo(clock.instant().plus(Duration.ofHours(8)));
        clock.set(expires.minusNanos(1));
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(user))).andExpect(status().isOk());
        clock.set(expires);
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(user)))
            .andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
        http.perform(delete("/api/v1/auth/sessions/current").header("Authorization", token(user))).andExpect(status().isNoContent());
    }

    @Test void logoutIsIdempotentAndCannotRevokeAnotherSessionByClientUid() throws Exception {
        var a = register("logout-a"); var b = register("logout-b");
        http.perform(delete("/api/v1/auth/sessions/current").header("Authorization", token(a)).param("uid", b.at("/user/uid").asText()))
            .andExpect(status().isNoContent()).andExpect(content().string(""));
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(a))).andExpect(status().isUnauthorized());
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(b))).andExpect(status().isOk());
        for (String header : List.of(token(a), "Bearer invalid", "Basic xyz"))
            http.perform(delete("/api/v1/auth/sessions/current").header("Authorization", header)).andExpect(status().isNoContent());
        http.perform(delete("/api/v1/auth/sessions/current")).andExpect(status().isNoContent());
    }

    @Test void anonymousMalformedForgedAndOldDigestsAreRejectedWithJson() throws Exception {
        http.perform(get("/api/v1/auth/sessions/current")).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.details").isMap());
        for (String header : List.of("Bearer invalid", "Bearer " + "a".repeat(43), "Basic eA==", "Bearer "))
            http.perform(get("/api/v1/auth/sessions/current").header("Authorization", header)).andExpect(status().isUnauthorized()).andExpect(jsonPath("$.error.code").value("UNAUTHORIZED"));
        var user = register("old-digest"); jdbc.update("DELETE FROM auth_session");
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(user))).andExpect(status().isUnauthorized());
    }

    @Test void filterDatabaseFailureIsSanitizedAndDoesNotFallThrough() throws Exception {
        var user = register("filter-failure");
        jdbc.execute("ALTER TABLE auth_session RENAME TO unavailable_session");
        try {
            http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(user)))
                .andExpect(status().isInternalServerError()).andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"))
                .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("SELECT"))));
        } finally { jdbc.execute("ALTER TABLE unavailable_session RENAME TO auth_session"); }
    }

    @Test void publicAllowlistIsExactAndInfrastructureDoesNotDiscloseInternals() throws Exception {
        http.perform(get("/actuator/health")).andExpect(status().isOk()).andExpect(content().json("{\"status\":\"UP\"}"));
        for (String path : List.of("/api/v1/users", "/api/v1/teams", "/api/v1/auth/sessions", "/actuator/env", "/h2-console", "/api/v1/users/admin"))
            http.perform(get(path)).andExpect(status().isUnauthorized());
        http.perform(post("/api/v1/teams").contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
    }

    @Test void membershipsAreLiveAndTeamCapabilitiesNeverCrossBoundaries() throws Exception {
        var a = register("policy-a"); var b = register("policy-b");
        String uidA = a.at("/user/uid").asText(), uidB = b.at("/user/uid").asText();
        String teamA = a.path("default_team_id").asText(), teamB = b.path("default_team_id").asText();
        assertThat(teams.requireOwner(uidA, teamA).role()).isEqualTo("owner");
        assertThatThrownBy(() -> teams.requireMember(uidB, teamA)).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> teams.requireOwner(uidA, teamB)).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> teams.requireMember(uidA, "missing")).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.NOT_FOUND));
        jdbc.update("INSERT INTO team_member(team_id,uid,role,joined_at) VALUES(?,?,'annotator',?)", teamA, uidB, OffsetDateTime.now());
        assertThat(teams.requireMember(uidB, teamA).role()).isEqualTo("annotator");
        assertThatThrownBy(() -> teams.requireOwner(uidB, teamA)).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.FORBIDDEN));
        // 即使故障数据伪造 owner 成员，仍须匹配 team.owner_uid。
        jdbc.update("UPDATE team_member SET role='owner' WHERE team_id=? AND uid=?", teamA, uidB);
        assertThatThrownBy(() -> teams.requireOwner(uidB, teamA)).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.FORBIDDEN));
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(b)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.memberships.length()").value(2));
        jdbc.update("DELETE FROM team_member WHERE team_id=? AND uid=?", teamA, uidB);
        http.perform(get("/api/v1/auth/sessions/current").header("Authorization", token(b)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.data.memberships.length()").value(1));
        jdbc.update("UPDATE team_member SET role='annotator' WHERE team_id=? AND uid=?", teamA, uidA);
        assertThatThrownBy(() -> teams.requireOwner(uidA, teamA)).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.FORBIDDEN));
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", uidA);
        assertThatThrownBy(() -> teams.requireOwner(uidA, teamA)).isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.status()).isEqualTo(HttpStatus.UNAUTHORIZED));
    }
}
