package cn.colla.phaseone;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "colla.database-name=registration_it")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class RegistrationIT {
    @Autowired MockMvc http;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    @BeforeEach void clean() {
        for (String table : List.of("auth_session", "team_member", "team", "app_user")) jdbc.update("DELETE FROM " + table);
    }

    String body(String name, String password) throws Exception {
        return json.writeValueAsString(Map.of("username", name, "password", password));
    }
    JsonNode register(String name, String password) throws Exception {
        var response = http.perform(post("/api/v1/users").contentType("application/json").content(body(name, password)))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString();
        return json.readTree(response).path("data");
    }

    @Test void anonymousRegistrationCreatesExactlyOneOwnerTeamAndHashedSession() throws Exception {
        var data = register("  owner-test  ", "test-secret");
        assertThat(data.path("user").path("username").asText()).isEqualTo("owner-test");
        assertThat(data.path("user").has("email")).isFalse();
        assertThat(data.path("user").has("password_hash")).isFalse();
        assertThat(data.path("user").path("avatar_url").isNull()).isTrue();
        String uid = data.path("user").path("uid").asText();
        String team = data.path("default_team_id").asText();
        assertThat(data.path("memberships")).hasSize(1);
        assertThat(data.at("/memberships/0/role").asText()).isEqualTo("owner");
        for (String table : List.of("app_user", "team", "team_member", "auth_session"))
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT owner_uid FROM team WHERE team_id=?", String.class, team)).isEqualTo(uid);
        assertThat(jdbc.queryForObject("SELECT name FROM team WHERE team_id=?", String.class, team)).isEqualTo("owner-test的团队");
        String stored = jdbc.queryForObject("SELECT password_hash FROM app_user WHERE uid=?", String.class, uid);
        assertThat(stored).startsWith("$2a$12$").isNotEqualTo("test-secret");
        assertThat(new BCryptPasswordEncoder().matches("test-secret", stored)).isTrue();
        String token = data.path("token").asText();
        assertThat(token).matches("[A-Za-z0-9_-]{43}");
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
        assertThat(jdbc.queryForObject("SELECT token_hash FROM auth_session", String.class)).isEqualTo(digest).isNotEqualTo(token);
    }

    @Test void passwordIsNotTrimmedOrTruncatedAndUsernameIsCaseSensitive() throws Exception {
        register("Alpha", "  original secret  "); register("alpha", "x");
        String stored = jdbc.queryForObject("SELECT password_hash FROM app_user WHERE username='Alpha'", String.class);
        assertThat(new BCryptPasswordEncoder().matches("  original secret  ", stored)).isTrue();
        assertThat(new BCryptPasswordEncoder().matches("original secret", stored)).isFalse();
    }

    @Test void acceptsBoundaryLengthsAndBoundParameters() throws Exception {
        register("n".repeat(64), "密".repeat(24));
        register("x'); DROP TABLE team; --", "x");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM team", Integer.class)).isEqualTo(2);
    }

    @ParameterizedTest @ValueSource(strings = {"{}", "{\"username\":\" \",\"password\":\"x\"}", "{\"username\":\"u\",\"password\":\"\"}", "{\"username\":null,\"password\":\"x\"}", "{\"username\":\"u\",\"password\":null}", "{\"username\":\"u\",\"password\":\"x\",\"role\":\"owner\"}", "{\"username\":\"u\",\"password\":\"x\",\"email\":\"x@example.test\"}", "{\"username\":\"u\",\"password\":\"x\",\"permissions\":[]}"})
    void rejectsInvalidOrPrivilegedFields(String input) throws Exception {
        http.perform(post("/api/v1/users").contentType("application/json").content(input))
            .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM app_user", Integer.class)).isZero();
    }

    @ParameterizedTest @ValueSource(strings = {"{\"username\":123,\"password\":\"x\"}", "{\"username\":\"u\",\"password\":true}", "[]"})
    void rejectsNonStringCredentialFields(String input) throws Exception {
        http.perform(post("/api/v1/users").contentType("application/json").content(input))
            .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test void rejectsOverlongFieldsAndMalformedJson() throws Exception {
        for (String input : List.of(body("n".repeat(65), "x"), body("u", "密".repeat(25)))) {
            http.perform(post("/api/v1/users").contentType("application/json").content(input)).andExpect(status().isUnprocessableEntity());
        }
        http.perform(post("/api/v1/users").contentType("application/json").content("{"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("BAD_REQUEST"));
    }

    @ParameterizedTest @ValueSource(strings = {"team_member", "auth_session"})
    void realSqlConstraintFailureRollsBackEveryAssociatedRow(String table) throws Exception {
        String condition = table.equals("team_member") ? "role <> 'owner'" : "uid = 'impossible'";
        jdbc.execute("ALTER TABLE " + table + " ADD CONSTRAINT test_failure CHECK (" + condition + ")");
        try {
            http.perform(post("/api/v1/users").contentType("application/json").content(body("rollback", "x")))
                .andExpect(status().isInternalServerError()).andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"))
                .andExpect(content().string(org.hamcrest.Matchers.not(org.hamcrest.Matchers.containsString("INSERT"))));
            for (String target : List.of("app_user", "team", "team_member", "auth_session"))
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + target, Integer.class)).isZero();
        } finally { jdbc.execute("ALTER TABLE " + table + " DROP CONSTRAINT test_failure"); }
    }

    @Test void concurrentDuplicateUsernameProducesOneSuccessAndOneConflict() throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            Callable<Integer> call = () -> http.perform(post("/api/v1/users").contentType("application/json").content(body("race", "x"))).andReturn().getResponse().getStatus();
            var results = pool.invokeAll(List.of(call, call));
            assertThat(List.of(results.get(0).get(), results.get(1).get())).containsExactlyInAnyOrder(201, 409);
        }
        for (String table : List.of("app_user", "team", "team_member", "auth_session"))
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class)).isEqualTo(1);
    }
}
