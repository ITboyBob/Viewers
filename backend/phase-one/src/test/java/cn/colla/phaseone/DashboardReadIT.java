package cn.colla.phaseone;

import cn.colla.phaseone.auth.SessionService;
import cn.colla.phaseone.identity.IdentityRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
import org.springframework.test.web.servlet.ResultActions;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "colla.database-name=dashboard_read_it")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class DashboardReadIT {
    private static final Instant START = Instant.parse("2026-11-03T00:00:00Z");
    private static final List<String> TABLES = List.of("task_registration", "task_record", "team_invitation",
        "auth_session", "team_member", "team", "app_user");

    @TestConfiguration static class TimeConfig {
        @Bean @Primary MutableClock dashboardClock() { return new MutableClock(); }
    }
    static class MutableClock extends Clock {
        private Instant now = START;
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return Clock.fixed(now, zone); }
        public Instant instant() { return now; }
    }
    record Actor(String uid, String team, String token) {
        @Override public String toString() { return "Actor[凭证已隐藏]"; }
    }
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired IdentityRepository identities;
    @Autowired SessionService sessions;
    @Autowired MutableClock clock;
    Actor alice, bob;

    @BeforeEach void prepare() {
        clock.now = START;
        for (String table : TABLES) jdbc.update("DELETE FROM " + table);
        alice = actor("演示甲");
        bob = actor("演示乙");
    }
    private Actor actor(String name) {
        String uid = UUID.randomUUID().toString();
        String team = UUID.randomUUID().toString();
        identities.insertUser(uid, name, "synthetic-only", START);
        identities.insertOwnedTeam(team, uid, name + "的团队", START);
        return new Actor(uid, team, sessions.issue(uid).token());
    }
    private String teamPath(Actor actor) { return "/api/v1/teams/" + actor.team() + "/tasks"; }
    private String membersPath(String task) { return "/api/v1/tasks/" + task + "/members"; }
    private ResultActions read(Actor actor, String path) throws Exception {
        return http.perform(get(path).header("Authorization", "Bearer " + actor.token()));
    }
    private JsonNode data(Actor actor, String path) throws Exception {
        JsonNode envelope = json.readTree(read(actor, path).andExpect(status().isOk())
            .andReturn().getResponse().getContentAsString());
        assertThat(envelope.size()).isEqualTo(1);
        assertThat(envelope.has("data")).isTrue();
        assertThat(envelope.at("/data/mock").asBoolean()).isEqualTo(!path.endsWith("/members"));
        return envelope.path("data");
    }
    private List<JsonNode> items(JsonNode data) {
        var rows = new ArrayList<JsonNode>();
        data.path("items").forEach(rows::add);
        assertThat(data.path("total").asInt()).isEqualTo(rows.size());
        assertThat(rows).isNotEmpty();
        assertThat(rows).extracting(row -> row.path("task_id").asText()).doesNotHaveDuplicates();
        return rows;
    }
    private void memberContract(JsonNode result, String task, Actor creator) {
        assertThat(result.size()).isEqualTo(4);
        assertThat(result.path("task_id").asText()).isEqualTo(task);
        assertThat(result.path("mock").asBoolean()).isFalse();
        assertThat(result.path("owner_uid").asText()).isEqualTo(creator.uid());
        assertThat(result.path("members").size()).isEqualTo(1);
        var owner = result.path("members").get(0);
        assertThat(owner.size()).isEqualTo(2);
        assertThat(owner.path("uid").asText()).isEqualTo(creator.uid());
        assertThat(owner.path("username").asText()).isEqualTo(jdbc.queryForObject(
            "SELECT username FROM app_user WHERE uid=?", String.class, creator.uid()));
    }
    private Map<String, String> database() throws Exception {
        // 按字节比较 JSON 列；失败报告只输出快照摘要，不泄露会话或账号字段。
        var snapshot = new java.util.LinkedHashMap<String, String>();
        var digest = java.security.MessageDigest.getInstance("SHA-256");
        for (String table : TABLES) {
            var rows = jdbc.queryForList("SELECT * FROM " + table + " ORDER BY 1,2");
            snapshot.put(table, java.util.HexFormat.of().formatHex(digest.digest(json.writeValueAsBytes(rows))));
        }
        return snapshot;
    }
    private String importedTask(Actor actor, String team) throws Exception {
        return json.readTree(http.perform(post("/api/v1/teams/" + team + "/tasks")
            .header("Authorization", "Bearer " + actor.token()).header("Idempotency-Key", UUID.randomUUID().toString())
            .contentType("application/json").content("{\"title\":\"合成导入.dcm\"}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).at("/data/task_id").asText();
    }

    @Test void ownedTeamHasCompleteStableCardsAndWhitelistedPreviews() throws Exception {
        var result = data(alice, teamPath(alice));
        assertThat(result.size()).isEqualTo(3);
        var rows = items(result);
        assertThat(rows.size()).isGreaterThanOrEqualTo(2);
        for (var row : rows) {
            assertThat(row.size()).isEqualTo(5);
            assertThat(UUID.fromString(row.path("task_id").asText()).toString()).isEqualTo(row.path("task_id").asText());
            assertThat(row.path("team_id").asText()).isEqualTo(alice.team());
            assertThat(row.path("title").asText()).isNotBlank();
            assertThat(row.path("subtitle").asText()).isNotBlank();
            assertThat(row.path("preview_key").asText()).isIn("abdominal-ct", "none");
        }
        assertThat(rows).extracting(row -> row.path("preview_key").asText()).contains("abdominal-ct", "none");
        assertThat(data(alice, teamPath(alice) + "?page=2&page_size=1")).isEqualTo(result);
        clock.now = START.plusSeconds(3600);
        assertThat(data(alice, teamPath(alice))).isEqualTo(result);
    }

    @Test void recentIsExplicitPerUserHistoryWithUtcDescendingAndTaskIdTies() throws Exception {
        var result = data(alice, "/api/v1/tasks/recent");
        var rows = items(result);
        for (var row : rows) {
            assertThat(row.size()).isEqualTo(6);
            assertThat(row.path("last_entered_at").asText()).endsWith("Z");
            Instant.parse(row.path("last_entered_at").asText());
        }
        var order = Comparator.<JsonNode, Instant>comparing(row -> Instant.parse(row.path("last_entered_at").asText()))
            .reversed().thenComparing(row -> row.path("task_id").asText());
        assertThat(rows).isSortedAccordingTo(order);
        assertThat(rows.stream().map(row -> row.path("last_entered_at").asText()).distinct().count()).isLessThan(rows.size());
        assertThat(data(alice, "/api/v1/tasks/recent?uid=" + bob.uid())).isEqualTo(result);
        clock.now = START.plusSeconds(3600);
        assertThat(data(alice, "/api/v1/tasks/recent")).isEqualTo(result);
    }

    @Test void placeholderTasksNeverProduceMembers() throws Exception {
        var before = database();
        for (var row : items(data(alice, "/api/v1/tasks/recent")))
            read(alice, membersPath(row.path("task_id").asText())).andExpect(status().isNotFound());
        assertThat(database()).isEqualTo(before);
    }

    @Test void anotherTeamIsNotFoundEvenWhenActorIsAnOrdinaryMember() throws Exception {
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',?)", bob.team(), alice.uid(), IdentityRepository.utc(START));
        read(alice, teamPath(bob) + "?uid=" + bob.uid() + "&owner_uid=" + alice.uid())
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
        read(alice, "/api/v1/teams/" + UUID.randomUUID() + "/tasks").andExpect(status().isNotFound());
    }

    @Test void defaultTeamMustStillBeOwnedByPrincipal() throws Exception {
        String nextOwner = UUID.randomUUID().toString();
        identities.insertUser(nextOwner, "接任团队者", "synthetic-only", START);
        jdbc.update("UPDATE team SET owner_uid=? WHERE team_id=?", nextOwner, alice.team());
        read(alice, teamPath(alice)).andExpect(status().isNotFound());
    }

    @Test void twoAccountsCannotReadEachOthersPrivateTasksOrOwners() throws Exception {
        var a = items(data(alice, teamPath(alice)));
        var b = items(data(bob, teamPath(bob)));
        assertThat(a).extracting(row -> row.path("task_id").asText())
            .doesNotContainAnyElementsOf(b.stream().map(row -> row.path("task_id").asText()).toList());
        String task = importedTask(alice, alice.team());
        var own = data(alice, membersPath(task));
        memberContract(own, task, alice);
        assertThat(data(alice, membersPath(task))).isEqualTo(own);
        read(bob, membersPath(task)).andExpect(status().isNotFound());
        String other = importedTask(bob, bob.team());
        memberContract(data(bob, membersPath(other)), other, bob);
    }

    @ParameterizedTest @ValueSource(strings = {"not-a-uuid", "1-1-1-1-1", "00000000-0000-0000-0000-00000000000g"})
    void invalidUuidIs422ForBothParameterizedPaths(String value) throws Exception {
        for (String path : List.of("/api/v1/teams/" + value + "/tasks", membersPath(value)))
            read(alice, path).andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test void unknownTaskDoesNotProduceFallbackMembers() throws Exception {
        read(alice, membersPath(UUID.randomUUID().toString())).andExpect(status().isNotFound())
            .andExpect(jsonPath("$.error.code").value("NOT_FOUND"));
    }

    @Test void allThreeReadsRequireRealActiveUnexpiredBearerSessions() throws Exception {
        var paths = List.of(teamPath(alice), "/api/v1/tasks/recent", membersPath(UUID.randomUUID().toString()));
        for (String path : paths) {
            http.perform(get(path)).andExpect(status().isUnauthorized());
            http.perform(get(path).header("Authorization", "Bearer " + "x".repeat(43))).andExpect(status().isUnauthorized());
        }
        jdbc.update("UPDATE auth_session SET expires_at=? WHERE uid=?", IdentityRepository.utc(START.plusSeconds(1)), alice.uid());
        clock.now = START.plusSeconds(2);
        for (String path : paths) read(alice, path).andExpect(status().isUnauthorized());
        alice = new Actor(alice.uid(), alice.team(), sessions.issue(alice.uid()).token());
        jdbc.update("UPDATE app_user SET status='disabled' WHERE uid=?", alice.uid());
        for (String path : paths) read(alice, path).andExpect(status().isUnauthorized());
    }

    @Test void importedTaskOwnerIsCreatorNotViewerOrTeamOwnerAndReadsAreSideEffectFree() throws Exception {
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',?)", alice.team(), bob.uid(), IdentityRepository.utc(START));
        String task = importedTask(bob, alice.team());
        var before = database();
        var result = data(bob, membersPath(task));
        memberContract(result, task, bob);
        assertThat(data(alice, membersPath(task))).isEqualTo(result);
        for (Actor actor : List.of(alice, bob)) {
            assertThat(items(data(actor, teamPath(actor)))).extracting(row -> row.path("task_id").asText()).doesNotContain(task);
            assertThat(items(data(actor, "/api/v1/tasks/recent"))).extracting(row -> row.path("task_id").asText()).doesNotContain(task);
        }
        assertThat(database()).isEqualTo(before);
        jdbc.update("UPDATE app_user SET username=? WHERE uid=?", "真实创建者新用户名", bob.uid());
        memberContract(data(alice, membersPath(task)), task, bob);
        jdbc.update("DELETE FROM team_member WHERE team_id=? AND uid=?", alice.team(), bob.uid());
        read(bob, membersPath(task)).andExpect(status().isNotFound());
        memberContract(data(alice, membersPath(task)), task, bob);
    }

    @Test void realTaskReadDoesNotDependOnViewerOwningTheirDefaultTeam() throws Exception {
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',?)", bob.team(), alice.uid(), IdentityRepository.utc(START));
        String task = importedTask(bob, bob.team());
        jdbc.update("DELETE FROM team_member WHERE team_id=? AND uid=?", alice.team(), alice.uid());
        memberContract(data(alice, membersPath(task)), task, bob);
    }

    @Test void invisibleRealTaskAndDeletedTaskAre404() throws Exception {
        String task = importedTask(bob, bob.team());
        read(alice, membersPath(task)).andExpect(status().isNotFound());
        jdbc.update("DELETE FROM task_registration WHERE task_id=?", task);
        jdbc.update("DELETE FROM task_record WHERE task_id=?", task);
        read(bob, membersPath(task)).andExpect(status().isNotFound());
    }

    @Test void readsNeverCreateOrMutateBusinessRowsOrTables() throws Exception {
        String aliceTask = importedTask(alice, alice.team());
        String bobTask = importedTask(bob, bob.team());
        var before = database();
        var tables = jdbc.queryForList("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='PUBLIC' ORDER BY TABLE_NAME");
        for (Actor actor : List.of(alice, bob)) {
            items(data(actor, teamPath(actor)));
            items(data(actor, "/api/v1/tasks/recent"));
            for (var row : items(data(actor, teamPath(actor))))
                read(actor, membersPath(row.path("task_id").asText())).andExpect(status().isNotFound());
        }
        data(alice, membersPath(aliceTask));
        data(bob, membersPath(bobTask));
        assertThat(database()).isEqualTo(before);
        assertThat(jdbc.queryForList("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='PUBLIC' ORDER BY TABLE_NAME"))
            .isEqualTo(tables);
    }


}
