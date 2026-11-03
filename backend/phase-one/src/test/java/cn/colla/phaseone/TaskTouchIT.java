package cn.colla.phaseone;

import cn.colla.phaseone.auth.SessionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "colla.database-name=task_touch_c_it")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class TaskTouchIT {
    static final Instant NOW = Instant.parse("2026-11-02T00:00:00Z");
    @TestConfiguration static class TimeConfig {
        @Bean @Primary Clock touchClock() { return Clock.fixed(NOW, ZoneOffset.UTC); }
    }
    @Autowired MockMvc http;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired SessionService sessions;
    String importer, owner, member, outsider, team, otherTeam, token, id;

    @BeforeEach void prepare() throws Exception {
        for (String table : List.of("task_registration", "task_record", "auth_session", "team_member", "team", "app_user"))
            jdbc.update("DELETE FROM " + table);
        importer = user(); owner = user(); member = user(); outsider = user();
        team = team(owner); otherTeam = team(outsider);
        team(importer); team(member);
        for (String uid : List.of(importer, member))
            jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',?)", team, uid, utc(NOW));
        token = sessions.issue(importer).token();
        id = json.readTree(http.perform(post("/api/v1/teams/" + team + "/tasks")
            .header("Authorization", "Bearer " + token).header("Idempotency-Key", UUID.randomUUID().toString())
            .contentType("application/json").content("{\"title\":\"合成导入.dcm\"}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).at("/data/task_id").asText();
    }
    static OffsetDateTime utc(Instant time) { return time.atOffset(ZoneOffset.UTC); }
    String user() {
        String uid = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO app_user(uid,username,password_hash,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)", uid, uid, "synthetic-only", utc(NOW), utc(NOW));
        return uid;
    }
    String team(String uid) {
        String tid = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO team(team_id,name,owner_uid,created_at,updated_at) VALUES(?,?,?,?,?)", tid, "合成团队", uid, utc(NOW), utc(NOW));
        jdbc.update("INSERT INTO team_member VALUES(?,?,'owner',?)", tid, uid, utc(NOW));
        return tid;
    }
    String path(String tid, String taskId) { return "/api/v1/teams/" + tid + "/tasks/" + taskId + "/updated-at"; }
    MockHttpServletRequestBuilder touch(String tid, String taskId, String bearer, String body) {
        return patch(path(tid, taskId)).header("Authorization", "Bearer " + bearer).contentType("application/json").content(body);
    }
    JsonNode success() throws Exception {
        return json.readTree(http.perform(touch(team, id, token, "{}"))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("data");
    }
    Map<String, Object> row() {
        var row = new HashMap<>(jdbc.queryForMap("SELECT * FROM task_record WHERE task_id=?", id));
        // H2的JSON列返回新byte[]，逐字节比较而非数组对象身份。
        row.replaceAll((key, value) -> value instanceof byte[] bytes ? HexFormat.of().formatHex(bytes) : value);
        return row;
    }

    @Test void onlyUpdatedAtChangesAndFixedClockIsStrictlyMonotonic() throws Exception {
        var before = row(); var registration = jdbc.queryForMap("SELECT * FROM task_registration WHERE task_id=?", id);
        for (int n = 1; n <= 3; n++) {
            var data = success();
            assertThat(data.size()).isEqualTo(2);
            assertThat(data.path("task_id").asText()).isEqualTo(id);
            assertThat(Instant.parse(data.path("updated_at").asText())).isEqualTo(NOW.plusMillis(n));
        }
        var after = row();
        assertThat(after.remove("UPDATED_AT")).isEqualTo(utc(NOW.plusMillis(3)));
        before.remove("UPDATED_AT"); assertThat(after).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT * FROM task_registration WHERE task_id=?", id)).isEqualTo(registration);
    }
    @Test void clockAheadAndClockBehindBothUseMaxOfNowAndOldPlusOneMillisecond() throws Exception {
        jdbc.update("UPDATE task_record SET created_at=?,updated_at=? WHERE task_id=?", utc(NOW.minusSeconds(10)), utc(NOW.minusSeconds(5)), id);
        assertThat(Instant.parse(success().path("updated_at").asText())).isEqualTo(NOW);
        jdbc.update("UPDATE task_record SET updated_at=? WHERE task_id=?", utc(NOW.plusSeconds(10)), id);
        assertThat(Instant.parse(success().path("updated_at").asText())).isEqualTo(NOW.plusSeconds(10).plusMillis(1));
    }
    @Test void ownerAndOtherMemberAreForbiddenEvenThoughBothAreTeamMembers() throws Exception {
        var before = row();
        for (String uid : List.of(owner, member))
            http.perform(touch(team, id, sessions.issue(uid).token(), "{}")).andExpect(status().isForbidden());
        assertThat(row()).isEqualTo(before);
    }
    @Test void invisibleTeamMissingTaskAndWrongTeamTaskCombinationAreNotFound() throws Exception {
        http.perform(touch(team, id, sessions.issue(outsider).token(), "{}")).andExpect(status().isNotFound());
        http.perform(touch(otherTeam, id, sessions.issue(outsider).token(), "{}")).andExpect(status().isNotFound());
        http.perform(touch(team, UUID.randomUUID().toString(), token, "{}")).andExpect(status().isNotFound());
        jdbc.update("DELETE FROM team_member WHERE uid=?", importer);
        http.perform(touch(team, id, token, "{}")).andExpect(status().isNotFound());
    }
    @Test void anonymousExpiredAndDisabledPrincipalsAreUnauthorized() throws Exception {
        http.perform(patch(path(team, id)).contentType("application/json").content("{}")).andExpect(status().isUnauthorized());
        jdbc.update("UPDATE auth_session SET created_at=?,expires_at=?", utc(NOW.minusSeconds(10)), utc(NOW.minusSeconds(1)));
        http.perform(touch(team, id, token, "{}")).andExpect(status().isUnauthorized());
        token = sessions.issue(importer).token();
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", importer);
        http.perform(touch(team, id, token, "{}")).andExpect(status().isUnauthorized());
    }
    @ParameterizedTest @ValueSource(strings = {"{\"updated_at\":\"2026-01-01T00:00:00Z\"}", "{\"title\":\"伪造\"}", "{\"uid\":\"伪造\"}", "{\"metadata\":{}}", "{\"task_id\":\"伪造\"}", "[]", "null", "42", "\"x\""})
    void onlyEmptyJsonObjectIsAccepted(String payload) throws Exception {
        var before = row();
        http.perform(touch(team, id, token, payload)).andExpect(status().isUnprocessableEntity());
        assertThat(row()).isEqualTo(before);
    }
    @Test void concurrentTouchesLockTheRowAndCommitEveryDistinctMonotonicTimestamp() throws Exception {
        int count = 8; var barrier = new CyclicBarrier(count);
        try (var pool = Executors.newFixedThreadPool(count)) {
            var jobs = new ArrayList<Future<Instant>>();
            for (int n = 0; n < count; n++) jobs.add(pool.submit(() -> {
                barrier.await(10, TimeUnit.SECONDS);
                return Instant.parse(success().path("updated_at").asText());
            }));
            var timestamps = new TreeSet<Instant>();
            for (var job : jobs) timestamps.add(job.get(15, TimeUnit.SECONDS));
            assertThat(timestamps).hasSize(count);
            assertThat(timestamps.first()).isEqualTo(NOW.plusMillis(1));
            assertThat(timestamps.last()).isEqualTo(NOW.plusMillis(count));
        }
        assertThat(row().get("UPDATED_AT")).isEqualTo(utc(NOW.plusMillis(count)));
    }
    @Test void noTaskReadOrGeneralWriteMappingsAreIntroduced() throws Exception {
        for (String route : List.of("/api/v1/teams/" + team + "/tasks/" + id, path(team, id))) {
            int status = http.perform(get(route).header("Authorization", "Bearer " + token)).andReturn().getResponse().getStatus();
            assertThat(status).isIn(404, 405);
        }
        http.perform(patch("/api/v1/teams/" + team + "/tasks/" + id).header("Authorization", "Bearer " + token)
            .contentType("application/json").content("{}")).andExpect(status().isNotFound());
    }
}
