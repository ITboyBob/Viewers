package cn.colla.phaseone;

import cn.colla.phaseone.auth.SessionService;
import cn.colla.phaseone.identity.IdentityRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = "colla.database-name=dashboard_tasks_it")
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class DashboardTasksIT {
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate jdbc;
    @Autowired IdentityRepository identities;
    @Autowired SessionService sessions;
    record Actor(String uid, String team, String token) {}
    Actor alice, bob;
    @BeforeEach void prepare() {
        for (String table : List.of("task_registration", "task_record", "team_invitation", "auth_session", "team_member", "team", "app_user")) jdbc.update("DELETE FROM " + table);
        alice = actor(); bob = actor();
    }
    Actor actor() {
        String uid = UUID.randomUUID().toString(), team = UUID.randomUUID().toString();
        identities.insertUser(uid, uid, "synthetic-only", Instant.now());
        identities.insertOwnedTeam(team, uid, "真实团队", Instant.now());
        return new Actor(uid, team, sessions.issue(uid).token());
    }
    JsonNode read(Actor actor, String path) throws Exception {
        return json.readTree(http.perform(get("/api/v1" + path).header("Authorization", "Bearer " + actor.token()))
            .andExpect(status().isOk()).andReturn().getResponse().getContentAsString()).path("data");
    }
    String create(Actor actor, String team) throws Exception {
        return json.readTree(http.perform(post("/api/v1/teams/" + team + "/tasks")
            .header("Authorization", "Bearer " + actor.token()).header("Idempotency-Key", UUID.randomUUID().toString())
            .contentType("application/json").content("{\"title\":\"真实导入.dcm\"}"))
            .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString()).at("/data/task_id").asText();
    }
    void visit(Actor actor, String task) throws Exception {
        http.perform(post("/api/v1/tasks/" + task + "/visits").header("Authorization", "Bearer " + actor.token()))
            .andExpect(status().isNoContent());
    }
    @Test void freshRuntimeHasNoDemoTasks() throws Exception {
        for (String path : List.of("/teams/" + alice.team() + "/tasks", "/tasks/recent")) {
            var data = read(alice, path);
            assertThat(data.path("mock").asBoolean()).isFalse();
            assertThat(data.path("total").asInt()).isZero();
            assertThat(data.path("items").size()).isZero();
        }
    }
    @Test void realTeamAndRecentListsHaveIndependentMembershipAndVisitScope() throws Exception {
        jdbc.update("INSERT INTO team_member VALUES(?,?,'annotator',?)", alice.team(), bob.uid(), IdentityRepository.utc(Instant.now()));
        String task = create(bob, alice.team());
        var cards = read(bob, "/teams/" + alice.team() + "/tasks");
        assertThat(cards.path("mock").asBoolean()).isFalse();
        assertThat(cards.path("items").get(0).path("task_id").asText()).isEqualTo(task);
        assertThat(cards.path("items").get(0).path("assignee_uid").asText()).isEqualTo(bob.uid());
        assertThat(read(bob, "/tasks/recent").path("total").asInt()).isZero();
        var timestamp = jdbc.queryForObject("SELECT updated_at FROM task_record WHERE task_id=?", Object.class, task);
        visit(bob, task); visit(bob, task);
        assertThat(read(bob, "/tasks/recent").path("items").get(0).path("task_id").asText()).isEqualTo(task);
        assertThat(read(alice, "/tasks/recent").path("total").asInt()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM task_visit WHERE uid=? AND task_id=?", Integer.class, bob.uid(), task)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT updated_at FROM task_record WHERE task_id=?", Object.class, task)).isEqualTo(timestamp);
        jdbc.update("DELETE FROM team_member WHERE team_id=? AND uid=?", alice.team(), bob.uid());
        assertThat(read(bob, "/tasks/recent").path("total").asInt()).isZero();
        http.perform(post("/api/v1/tasks/" + task + "/visits").header("Authorization", "Bearer " + bob.token())).andExpect(status().isNotFound());
    }
    @Test void taskAndVisitOrderingIsStableAndReadOnly() throws Exception {
        String a = create(alice, alice.team()), b = create(alice, alice.team());
        var at = IdentityRepository.utc(Instant.parse("2026-11-01T00:00:00Z"));
        jdbc.update("UPDATE task_record SET created_at=?", at);
        var cards = read(alice, "/teams/" + alice.team() + "/tasks").path("items");
        assertThat(cards.get(0).path("task_id").asText()).isEqualTo(a.compareTo(b) < 0 ? a : b);
        visit(alice, a); visit(alice, b);
        jdbc.update("UPDATE task_visit SET last_entered_at=?", at);
        var recent = read(alice, "/tasks/recent").path("items");
        assertThat(recent.get(0).path("task_id").asText()).isEqualTo(cards.get(0).path("task_id").asText());
        visit(alice, b);
        assertThat(read(alice, "/tasks/recent").path("items").get(0).path("task_id").asText()).isEqualTo(b);
        jdbc.update("DELETE FROM task_registration WHERE task_id=?", b);
        jdbc.update("DELETE FROM task_record WHERE task_id=?", b);
        assertThat(read(alice, "/tasks/recent").path("total").asInt()).isEqualTo(1);
    }
    @Test void visitRejectsUnauthenticatedUnknownAndForeignTasks() throws Exception {
        String task = create(alice, alice.team());
        http.perform(post("/api/v1/tasks/" + task + "/visits")).andExpect(status().isUnauthorized());
        http.perform(post("/api/v1/tasks/" + task + "/visits").header("Authorization", "Bearer " + bob.token())).andExpect(status().isNotFound());
        http.perform(post("/api/v1/tasks/not-a-uuid/visits").header("Authorization", "Bearer " + alice.token())).andExpect(status().isUnprocessableEntity());
        http.perform(post("/api/v1/tasks/" + UUID.randomUUID() + "/visits").header("Authorization", "Bearer " + alice.token())).andExpect(status().isNotFound());
    }
}
